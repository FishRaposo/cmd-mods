import type {ModApi} from '@commandcode/harness';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Quality Guards — nudge the agent away from dumb mistakes ─────────────────
//
// Ownership (see README): quality-guards is the SAFETY slot — advisory
// warnings via additionalContext. It never blocks tools and never touches
// the self-repair ⇄ autopilot verdict flow. Enforcement of mandate scope and
// red actions belongs to autopilot while initiative is active.
//
// Features (each toggleable via --mod-option):
// 1. Failure coaching — escalating nudges on consecutive tool failures,
//    plus timeout and edit-conflict recovery. (qg-failure-coaching)
// 2. Loop detection — warn when the same edit is attempted repeatedly.
//    (qg-loop-detection)
// 3. Overwrite guard — warn before write_file clobbers an unread file.
//    (qg-overwrite-guard)
// 4. Git guard — warn on destructive git commands. (qg-git-guard)
// 5. Long-running hints — warn that a command may take a while and timeouts
//    may leave partial progress. (qg-long-running)
// 6. Build guard — warn before tests when the last build failed.
//    (qg-build-guard)
// 7. Test budget — escalate after N turns without a green test.
//    (qg-test-budget)
// 8. Token budget — warn when a run gets long and context may be filling.
//    (qg-token-budget)
// 9. Drift detection — remind the agent of the current task after N turns.
//    (qg-drift)
// 10. Run-length estimation — warn when a task runs long vs. similar past
//     tasks. Reads task durations from session-persistence's checkpoint
//     (.commandcode/checkpoint.json) when that mod is installed; otherwise
//     stays inert. (qg-run-length)

// ── Pure helpers (no ModApi dependency) ────────────────────────────────────

const DANGEROUS_GIT = [
  /\bgit\s+push\b.*--force(?!-with-lease)\b/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\brm\s+-rf\b/,
  /\bgit\s+commit\s+--amend\b/,
];

const TIMEOUT_SIGNALS = [
  /\b(timed\s*out|timeout)\b/i,
  /exit code 124\b/i,
  /Command timed out/i,
];

const SIGNAL_KILL_SIGNALS = [
  /\bkilled by signal\b/i,
  /\bSIGTERM\b.*\b(stopped|killed)\b/i,
  /\bSIGKILL\b.*\b(stopped|killed)\b/i,
];

// Build commands: an explicit runner invocation of a build step, or a
// standalone build tool. Avoids matching "build" inside prose/commit messages.
const BUILD_COMMANDS = [
  /\b(npm|pnpm|yarn|bun|npx|cargo|make|dotnet|go|cmake|ninja|msbuild)\b[^\n]*\b(build|compile)\b/i,
  /\b(tsc|esbuild|vite|webpack|rollup|gradle|mvn|sbt)\b/,
  /--build-solutions/,
];

// Test commands: an explicit runner invocation of a test step, or a
// standalone test tool. Avoids matching "test" inside prose/commit messages.
const TEST_COMMANDS = [
  /\b(npm|pnpm|yarn|bun|npx|cargo|make|dotnet|go)\b[^\n]*\btest(s)?\b/,
  /\b(pytest|vitest|jest|mocha|ava|playwright|cypress|karma|jasmine)\b/,
];

const LONG_RUNNING_COMMANDS = [
  // Package-manager invocations that install/build/test/download
  /\b(npm|pnpm|yarn|bun|npx|cargo|pip|pip3|dotnet|go|apt|apt-get|brew|choco|winget)\b[^\n]*\b(install|add|update|upgrade|restore|build|test|download)\b/,
  // Make targets (build/test are the common ones; any make invocation can be long).
  // Anchored at command start so prose like `echo "make sure"` doesn't match.
  /(^|[;&|]\s*)make\s+[-\w.]+/,
  // Network operations
  /\bgit\s+(clone|fetch|pull)\b/,
  /\bdocker\s+(build|pull|push)\b/,
  /\b(curl|wget)\b/,
  // Standalone build/test tools
  /\b(tsc|esbuild|vite|webpack|rollup|gradle|mvn|sbt|msbuild|pytest|vitest|jest)\b/,
  /--quit-after\s+\d{3,}/,
];

function extractCmd(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const rec = input as Record<string, unknown>;
  let cmd = '';
  if (typeof rec.command === 'string') cmd = rec.command;
  if (Array.isArray(rec.args)) {
    cmd = cmd + ' ' + (rec.args as unknown[]).map(String).join(' ');
  }
  return cmd.trim();
}

function extractFilePath(input: unknown): string | null {
  if (typeof input === 'object' && input !== null && 'file_path' in input) {
    return String((input as Record<string, unknown>).file_path);
  }
  return null;
}

function extractOldString(input: unknown): string | null {
  if (typeof input === 'object' && input !== null && 'old_string' in input) {
    return String((input as Record<string, unknown>).old_string);
  }
  return null;
}

function normalizeFilePath(filePath: string, cwd: string): string {
  const expanded = filePath.startsWith('~/')
    ? path.join(os.homedir(), filePath.slice(2))
    : filePath;
  return path.normalize(path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded)).toLowerCase();
}

function shortPath(filePath: string, cwd: string): string {
  const normPath = path.normalize(filePath).toLowerCase();
  const normCwd = path.normalize(cwd).toLowerCase();
  if (normPath === normCwd) return path.basename(filePath);
  const cwdSep = normCwd + path.sep;
  if (normPath.startsWith(cwdSep)) {
    return filePath.slice(cwdSep.length) || path.basename(filePath);
  }
  return path.basename(filePath);
}

// Tool results arrive as content blocks ([{type:'text',text}]), not raw
// strings — normalize before regex matching.
function contentText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result
      .map(block => {
        if (typeof block === 'object' && block !== null &&
            (block as Record<string, unknown>).type === 'text') {
          return String((block as Record<string, unknown>).text ?? '');
        }
        return '';
      })
      .join('\n');
  }
  if (result && typeof result === 'object') {
    const rec = result as Record<string, unknown>;
    return [rec.stdout, rec.stderr]
      .filter((v): v is string => typeof v === 'string')
      .join('\n');
  }
  return '';
}

function resultIsFailure(result: unknown): boolean {
  const text = contentText(result);
  if (!text) return false;
  // Prefer explicit machine signals. `\berror\b` is broad and catches benign
  // prose like "zero errors" or "no error" — avoid it.
  return (
    /\b(failed|fail(?:ed|ures?))\b/i.test(text) ||
    /\berrors?\b/i.test(text) && !/\b(?:0|zero|no)\s+errors?\b/i.test(text) ||
    /exit\s+code\s*:?\s*[1-9]\d*\b/i.test(text) ||
    /\b(0 pass|0 tests?|all fail)\b/i.test(text)
  );
}

function resultIsTimeout(result: unknown): boolean {
  const text = contentText(result);
  if (!text) return false;
  return (
    TIMEOUT_SIGNALS.some(p => p.test(text)) ||
    SIGNAL_KILL_SIGNALS.some(p => p.test(text))
  );
}

function resultIsBuildSuccess(result: unknown): boolean {
  const text = contentText(result);
  if (!text) return true;
  if (/exit\s+code\s*:?\s*[1-9]\d*\b/i.test(text)) return false;
  if (/\b(failed|broken|fail(?:ed|ures?))\b/i.test(text)) return false;
  return true;
}

function isBuildCommand(cmd: string): boolean {
  return cmd.length > 0 && BUILD_COMMANDS.some(p => p.test(cmd));
}

function isTestCommand(cmd: string): boolean {
  return cmd.length > 0 && TEST_COMMANDS.some(p => p.test(cmd));
}

function isLongRunning(cmd: string): boolean {
  return cmd.length > 0 && LONG_RUNNING_COMMANDS.some(p => p.test(cmd));
}

function extractTaskLabel(text: string): string | null {
  const match = text.match(
    /\b(implement|build|migrat|refactor|fix|add|configure|wire|deploy|setup|create|update|remove|rewrite|upgrade)\w*\s+([\w\s\-/.()]{3,80}?)[\.\n]/i,
  );
  return match ? match[0].trim() : null;
}

function taskSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

// ── Mod ─────────────────────────────────────────────────────────────────────

export default function (cmd: ModApi): void {
  // ── Feature toggles ──────────────────────────────────────────────────────
  cmd.addFlag('qg-failure-coaching', {type: 'boolean', default: true,
    description: 'Escalate on consecutive tool failures; coach timeouts and edit conflicts'});
  cmd.addFlag('qg-loop-detection', {type: 'boolean', default: true,
    description: 'Warn when the same edit is attempted repeatedly'});
  cmd.addFlag('qg-overwrite-guard', {type: 'boolean', default: true,
    description: 'Warn before write_file overwrites an unread file'});
  cmd.addFlag('qg-git-guard', {type: 'boolean', default: true,
    description: 'Warn on destructive git commands'});
  cmd.addFlag('qg-long-running', {type: 'boolean', default: true,
    description: 'Hint when a command may take a while'});
  cmd.addFlag('qg-build-guard', {type: 'boolean', default: true,
    description: 'Warn before tests after a failed build'});
  cmd.addFlag('qg-test-budget', {type: 'boolean', default: true,
    description: 'Escalate after N turns without a green test'});
  cmd.addFlag('qg-token-budget', {type: 'boolean', default: true,
    description: 'Warn when the context window may be filling'});
  cmd.addFlag('qg-drift', {type: 'boolean', default: true,
    description: 'Remind the agent of the current task after N turns'});
  cmd.addFlag('qg-run-length', {type: 'boolean', default: true,
    description: 'Warn when a task runs long vs. similar past tasks'});

  // Numeric thresholds (string flags: --mod-option values arrive as strings)
  cmd.addFlag('qg-max-failures', {type: 'string', default: '3',
    description: 'Consecutive failures before the STOP escalation'});
  cmd.addFlag('qg-loop-threshold', {type: 'string', default: '3',
    description: 'Identical edit attempts before the loop warning'});
  cmd.addFlag('qg-budget-turns', {type: 'string', default: '12',
    description: 'Turns without a green test before the budget escalation'});
  cmd.addFlag('qg-token-warn-turns', {type: 'string', default: '20',
    description: 'Turns in one run before the context-fill warning'});
  cmd.addFlag('qg-drift-turns', {type: 'string', default: '8',
    description: 'Turns on one task before the drift reminder'});

  function boolFlag(name: string, fallback: boolean): boolean {
    const v = cmd.getFlag(name);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v !== 'false';
    return fallback;
  }
  function numFlag(name: string, fallback: number, min: number = 0): number {
    const v = cmd.getFlag(name);
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (!Number.isFinite(n) || n < min) return fallback;
    return n;
  }
  function failureCoachingEnabled(): boolean { return boolFlag('qg-failure-coaching', true); }
  function loopDetectionEnabled(): boolean { return boolFlag('qg-loop-detection', true); }
  function overwriteGuardEnabled(): boolean { return boolFlag('qg-overwrite-guard', true); }
  function gitGuardEnabled(): boolean { return boolFlag('qg-git-guard', true); }
  function longRunningEnabled(): boolean { return boolFlag('qg-long-running', true); }
  function buildGuardEnabled(): boolean { return boolFlag('qg-build-guard', true); }
  function testBudgetEnabled(): boolean { return boolFlag('qg-test-budget', true); }
  function tokenBudgetEnabled(): boolean { return boolFlag('qg-token-budget', true); }
  function driftEnabled(): boolean { return boolFlag('qg-drift', true); }
  function runLengthEnabled(): boolean { return boolFlag('qg-run-length', true); }
  function maxFailures(): number { return numFlag('qg-max-failures', 3, 1); }
  function loopThreshold(): number { return numFlag('qg-loop-threshold', 3, 1); }
  function budgetTurns(): number { return numFlag('qg-budget-turns', 12, 1); }
  function tokenWarnTurns(): number { return numFlag('qg-token-warn-turns', 20, 1); }
  function driftTurns(): number { return numFlag('qg-drift-turns', 8, 1); }

  // ── State ────────────────────────────────────────────────────────────────
  let consecutiveFailures = 0;
  const filesRead = new Set<string>();

  // ── Loop state ───────────────────────────────────────────────────────────
  const recentEditStrings = new Map<string, number>();
  // Signatures that already produced a loop warning; cleared when that
  // specific edit succeeds, so warnings on file A don't suppress file B.
  const loopWarnedSignatures = new Set<string>();

  // ── Attention budget ─────────────────────────────────────────────────────
  let turnsSinceTestPassed = 0;
  let turnsInRun = 0;

  // ── Bridging state (beforeToolCall → afterToolCall) ──────────────────────
  // Keyed by toolCallId: with parallel tool execution, multiple shell calls
  // can be in flight at once, so per-call classification can't live in a
  // single shared boolean. Stale entries are cleaned up after each call.
  const callIsTest = new Map<string, boolean>();
  const callIsBuild = new Map<string, boolean>();

  // ── Build-state tracking ─────────────────────────────────────────────────
  let lastBuildPassed = false;
  let lastBuildChecked = false;

  // ── Drift + run-length ───────────────────────────────────────────────────
  let currentTaskLabel: string | null = null;
  let topicTurns = 0;
  let turnsSinceSummary = 0;
  let taskDurations: Record<string, number> = {};
  // Task label the run-length warning last fired for — the warning must fire
  // at most once per task, not re-inject on every remaining turn.
  let runLengthWarnedFor: string | null = null;

  // Loose read-only dependency on session-persistence's checkpoint: past task
  // durations live there. If the mod isn't installed, run-length stays inert.
  function loadPastDurations(): Record<string, number> {
    try {
      const cpPath = path.join(cmd.cwd, '.commandcode', 'checkpoint.json');
      if (!fs.existsSync(cpPath)) return {};
      const cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
      return cp.taskDurations && typeof cp.taskDurations === 'object' ? cp.taskDurations : {};
    } catch { return {}; }
  }

  // ── Observer: turn counter ───────────────────────────────────────────────
  cmd.on('turn_start', () => {
    turnsSinceTestPassed++;
    turnsInRun++;
    turnsSinceSummary++;
    topicTurns++;
  });

  // Pending edit signatures keyed by toolCallId so parallel edit_file
  // completions resolve to their own entry regardless of completion order.
  const pendingEditSignatures = new Map<string, string>();

  // ── Observer: track files read for the overwrite guard ───────────────────
  cmd.on('tool_queued', event => {
    if (event.type !== 'tool_queued') return;
    const toolName = typeof (event as Record<string, unknown>).toolName === 'string'
      ? String((event as Record<string, unknown>).toolName) : '';
    const fp = extractFilePath((event as Record<string, unknown>).input);
    if (fp && toolName === 'read_file') filesRead.add(normalizeFilePath(fp, cmd.cwd));
  });

  // ── Hooks: bootstrap guard + loop detection + git guard + build guard ──────
  cmd.hooks({
    beforeToolCall: async ({toolCallId, toolName, input}) => {
      const rawCmd = extractCmd(input);
      const isShell = toolName === 'shell_command' || toolName === 'powershell';

      if (isShell && typeof toolCallId === 'string') {
        callIsTest.set(toolCallId, isTestCommand(rawCmd));
        callIsBuild.set(toolCallId, isBuildCommand(rawCmd));
      }

      if (buildGuardEnabled() && isShell && isTestCommand(rawCmd) && lastBuildChecked && !lastBuildPassed) {
        return {
          additionalContext: 'The last build check FAILED. Run a build first and verify it passes before running tests.',
        };
      }

      if (longRunningEnabled() && isLongRunning(rawCmd)) {
        return {
          additionalContext: 'This command may take a while. If it times out, check for partial progress before retrying — do NOT restart from scratch.',
        };
      }

      if (overwriteGuardEnabled() && toolName === 'write_file') {
        const filePath = extractFilePath(input);
        if (filePath) {
          try {
            const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(cmd.cwd, filePath);
            const stat = fs.statSync(fullPath);
            if (stat.isFile() && stat.size > 100 && !filesRead.has(normalizeFilePath(filePath, cmd.cwd))) {
              return {
                additionalContext: `WARNING: ${shortPath(filePath, cmd.cwd)} already exists (${stat.size} bytes) and you have NOT read it. You are about to OVERWRITE it. Read it first, or use edit_file.`,
              };
            }
          } catch { /* doesn't exist — fine */ }
        }
        return undefined;
      }

      if (loopDetectionEnabled() && toolName === 'edit_file') {
        const oldStr = extractOldString(input);
        const filePath = extractFilePath(input);
        if (oldStr && filePath) {
          const signature = `${shortPath(filePath, cmd.cwd)}::${oldStr.slice(0, 80)}`;
          const prevCount = recentEditStrings.get(signature) || 0;
          recentEditStrings.set(signature, prevCount + 1);
          if (typeof toolCallId === 'string') {
            pendingEditSignatures.set(toolCallId, signature);
          }
          if (prevCount + 1 >= loopThreshold() && !loopWarnedSignatures.has(signature)) {
            loopWarnedSignatures.add(signature);
            return {
              additionalContext: `LOOP DETECTED: same edit on ${shortPath(filePath, cmd.cwd)} attempted ${prevCount + 1} times. The file content has changed or your approach is wrong. Read current content, then try a different approach or escalate.`,
            };
          }
        }
        return undefined;
      }

      if (gitGuardEnabled() && isShell && DANGEROUS_GIT.some(p => p.test(rawCmd))) {
        return {
          additionalContext: `DESTRUCTIVE GIT (${rawCmd.slice(0, 80)}). Verify no uncommitted changes — this is intentional?`,
        };
      }

      return undefined;
    },
  });

  // ── Hooks: failure coaching + edit-conflict + timeout recovery + build tracking ──
  cmd.hooks({
    afterToolCall: async ({toolCallId, toolName, isError, result}) => {
      if (typeof toolCallId === 'string' && callIsBuild.has(toolCallId)) {
        lastBuildChecked = true;
        lastBuildPassed = !isError && resultIsBuildSuccess(result);
      }

      if (typeof toolCallId === 'string' && callIsTest.has(toolCallId)) {
        if (!isError && !resultIsFailure(result)) {
          turnsSinceTestPassed = 0;
        }
      }

      // Clean up per-call classification entries
      if (typeof toolCallId === 'string') {
        callIsTest.delete(toolCallId);
        callIsBuild.delete(toolCallId);
      }

      // Clear the loop counter for this edit once it succeeds
      if (toolName === 'edit_file' && typeof toolCallId === 'string' && !isError) {
        const signature = pendingEditSignatures.get(toolCallId);
        if (signature) {
          pendingEditSignatures.delete(toolCallId);
          recentEditStrings.delete(signature);
          loopWarnedSignatures.delete(signature);
        }
      }

      if (!failureCoachingEnabled()) return undefined;

      if (resultIsTimeout(result)) {
        consecutiveFailures = 0;
        return {
          additionalContext: 'COMMAND TIMED OUT. The command may have partially completed. Do NOT re-run the same command immediately — check the output log, verify what state changed (build artifacts may exist), and only retry what is still needed. Do NOT restart your entire approach.',
        };
      }

      if (!isError) {
        consecutiveFailures = 0;
        return undefined;
      }

      const errText = contentText(result);
      const errMsg = (errText || 'unknown error').slice(0, 300);

      if (toolName === 'edit_file' && /changed on disk|re-read|read before|no longer match/i.test(errMsg)) {
        consecutiveFailures = 0;
        return {
          additionalContext: 'The file changed on disk during your edit. Re-read it entirely, then retry the edit against current content — do NOT overwrite the whole file.',
        };
      }

      consecutiveFailures++;
      if (consecutiveFailures === 1) {
        return { additionalContext: `${toolName} failed. Try an alternative approach — do NOT repeat the same command.` };
      }
      if (consecutiveFailures === 2) {
        return { additionalContext: `${toolName} failed again. Debug the root cause: read relevant files, check assumptions, try once more with a DIFFERENT approach.` };
      }
      if (consecutiveFailures >= maxFailures()) {
        return { additionalContext: `${toolName} failed ${consecutiveFailures} consecutive times. STOP. Diagnose the real problem — read files, check state, fix the root cause. Escalate to the user if unclear.` };
      }
      return undefined;
    },
  });

  // ── Warnings: drift + test budget + token budget + run-length ────────────
  // Tail-injected via transformContext, NOT appendSystemPrompt: the system
  // prompt must stay byte-identical across turns so the provider's prompt
  // cache keeps its prefix hits. Warning text changes at threshold
  // crossings; living on the message tail confines the churn to the tail.
  function buildWarnings(): string[] {
      const prompts: string[] = [];

      if (driftEnabled() && currentTaskLabel && turnsSinceSummary >= driftTurns()) {
        turnsSinceSummary = 0;
        prompts.push(`Reminder: current task is "${currentTaskLabel}". If you've drifted, return to it. If the task changed, update your plan.`);
      }

      if (testBudgetEnabled() && turnsSinceTestPassed >= budgetTurns()) {
        turnsSinceTestPassed = 0;
        prompts.push(`ATTENTION BUDGET EXCEEDED: ${budgetTurns()}+ turns without a green test. Re-examine your approach — you may be stuck. Consider escalating to the user.`);
      }

      // Token budget awareness: warn when run is getting long
      if (tokenBudgetEnabled() && turnsInRun >= tokenWarnTurns()) {
        prompts.push(
          `TOKEN BUDGET: ${turnsInRun}+ turns in this run. The context window may be filling. ` +
          'If you have more work ahead, consider running /compact to summarize history and free space. ' +
          'Focus on completing the highest-priority remaining task.',
        );
        turnsInRun = 0; // Reset so it doesn't fire every turn, only once per threshold
      }

      // Run-length estimation: warn if current task is taking longer than similar past tasks
      if (runLengthEnabled() && currentTaskLabel && runLengthWarnedFor !== currentTaskLabel) {
        if (Object.keys(taskDurations).length === 0) {
          taskDurations = loadPastDurations();
        }
        if (Object.keys(taskDurations).length > 0) {
          for (const [pastTask, pastTurns] of Object.entries(taskDurations)) {
            if (taskSimilarity(currentTaskLabel, pastTask) > 0.5) {
              const currentTurns = topicTurns;
              if (currentTurns > pastTurns * 1.5) {
                prompts.push(
                  `RUN-LENGTH: Similar task "${pastTask}" took ~${pastTurns} turns. ` +
                  `You're at ${currentTurns} turns on "${currentTaskLabel}". ` +
                  'You may be over-engineering or stuck. Consider wrapping up and moving on.',
                );
                runLengthWarnedFor = currentTaskLabel; // Once per task
              }
              break; // Only report the first close match
            }
          }
        }
      }

      return prompts;
  }

  cmd.hooks({
    transformContext: ({messages}) => {
      const prompts = buildWarnings();
      if (prompts.length === 0) return messages;
      return [...messages, {
        role: 'user',
        // Array content blocks — the harness's wire projection assumes
        // message.content is always an array; string content crashes it.
        content: [{type: 'text', text: `[quality-guards] Advisory:\n${prompts.join('\n')}`}],
      } as never];
    },
  });

  // ── Hooks: task-label tracking (drift + run-length) ─────────────────────
  cmd.hooks({
    onStop: async ({lastAssistantText}) => {
      const taskLabel = extractTaskLabel(lastAssistantText);
      if (taskLabel && topicTurns >= 3) {
        if (currentTaskLabel && currentTaskLabel !== taskLabel) {
          if (topicTurns >= 3) {
            taskDurations[currentTaskLabel] = topicTurns;
          }
        }
        currentTaskLabel = taskLabel;
        topicTurns = 0;
      }
      // Drift/run-length never force a continuation — pass through.
      return undefined;
    },
  });
}
