import type {ModApi} from '@commandcode/harness';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// ── Self-Repair — the completion judge. ──────────────────────────────────────
//
// Self-repair is the ONLY mod allowed to judge a task done. It owns:
// 1. The self-review gate — force the agent to verify its own output before
//    declaring done. (sr-self-review)
// 2. Verdict emission — every verified completion emits a verdict on the
//    cross-mod event bus; autopilot consumes final verdicts. Nothing else
//    may act on them.
// 3. Checkpoints — mid-task state snapshots, recover after crash. (sr-checkpoints)
// 4. Git state — surface staged/unstaged counts + merge conflicts. (sr-git-state)
// 5. Task continuity — remember what was next, not just what was touched.
//    (sr-task-continuity)
// 6. Resume recovery — keep going after sudden stops. (sr-resume)
//
// Cross-mod contract (see README):
//   self-repair/verdict        → autopilot (v2: cycleId, complete, final,
//                               missing?, evidence[], files[], at)
//   self-repair/request-cycle  ← autopilot (open a child verification cycle)
//   self-repair/cycle-accepted → autopilot (synchronous ack)
//   self-repair/ping / pong    ⇄ autopilot (referee presence probe)
//
// With sr-self-review off, no verdict is ever emitted — autopilot stays
// muted. That is intentional: no referee judgment, no initiative.

// ── Pure helpers (no ModApi dependency) ────────────────────────────────────

const MERGE_CONFLICT_PORCELAIN = /^(?:UU|AA|[DUA][UD])\s/;

// Patterns for extracting what the agent intends to do next
const NEXT_ACTION_PATTERNS = [
  /\b(next|remaining|still|up next|about to)\s+.*?(?:I|we|will|need|must|have to|should|going to)\s+(.{5,120}?)[\.\n]/i,
  /\b(to do|remaining|still need|haven't|not yet)\s*:?\s*(.{5,120}?)[\.\n]/i,
  /\b(continuing|proceeding|moving on)\s+to\s+(.{5,120}?)[\.\n]/i,
];

// Patterns for detecting completion + work mention (self-review gate)
const COMPLETION_WORK_SIGNALS = /\b(done|complete|completed|finished|all (green|pass|tests pass)|ready|committed|closing)\b/i;
// Work mentions must match common inflections: "Fixed", "added", "wrote",
// "tests" — bare stems like \bfix\b miss them and the gate never fires.
const WORK_MENTION_SIGNALS = /\b(fix(?:ed|es|ing)?|file[ds]?|code|test(?:s|ed|ing)?|build(?:ing|s)?|implement(?:ed|ation|ing)?|change[ds]?|updat(?:ed|es|ing)?|edit(?:ed|s|ing)?|commit(?:ted|s)?|refactor(?:ed|ing|s)?|migrat(?:ed|ion|ing|es)?|config(?:ured|s|uring)?|creat(?:ed|es|ing)?|add(?:ed|s|ing)?|remov(?:ed|es|ing)?|delet(?:ed|es|ing)?|renam(?:ed|es|ing)?|wrot(?:e|ing)|written|writes?)\b/i;
const STILL_ACTIVE_SIGNALS = /\b(not yet|still (need|working|have to|must)|to do|remaining|wip|in progress|continuing|unfinished)\b/i;

// Verification commands whose green result counts as completion evidence.
const VERIFY_COMMANDS = [
  /\b(npm|pnpm|yarn|bun|npx|cargo|make|dotnet|go)\b[^\n]*\b(test|check|typecheck|lint)\b/i,
  /\b(pytest|vitest|jest|mocha|ava|playwright|cypress|tsc|eslint)\b/,
];

// Inspection commands merely MENTION test runners ("cat jest.config.js");
// their green exit proves nothing. Never count them as evidence.
const INSPECTION_COMMANDS = /^(?:sudo\s+)?(?:cat|type|head|tail|less|more|grep|rg|findstr|ls|dir|Get-Content|Select-String|echo|Write-Output)\b/i;

const FAILURE_SIGNALS = /\b(failed|error|broken|fail(?:ed|ures?)|exit\s+code\s*:?\s*[1-9])\b/i;

function isVerifyCommand(cmd: string): boolean {
  if (cmd.length === 0) return false;
  if (INSPECTION_COMMANDS.test(cmd)) return false;
  return VERIFY_COMMANDS.some(p => p.test(cmd));
}

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

// Tool results are content blocks ([{type:'text',text}]), not raw strings.
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

function extractFilePath(input: unknown): string | null {
  if (typeof input === 'object' && input !== null && 'file_path' in input) {
    return String((input as Record<string, unknown>).file_path);
  }
  return null;
}

// Mod-managed state dirs never count as work: learn-loop's distillation
// turn and memory-bank maintenance write here, and those writes must not
// trip the completion gate or pollute verdict receipts.
function isModStatePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    normalized.includes('/.agents/learning/') ||
    normalized.includes('/.agents/memory/') ||
    normalized.includes('/.agents/skills/') ||
    normalized.includes('/.commandcode/') ||
    normalized.endsWith('/.agents/learning') ||
    normalized.endsWith('/.agents/memory') ||
    normalized.endsWith('/.agents/skills')
  );
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

function hasClosingSignal(text: string): boolean {
  // A completion word mid-text usually describes an intermediate step ("I
  // finished reading the file..."). Only treat the LAST 200 chars as the
  // run's actual closing claim.
  const tail = text.length > 200 ? text.slice(-200) : text;
  return COMPLETION_WORK_SIGNALS.test(tail);
}

function extractNextAction(text: string): string | null {
  for (const pattern of NEXT_ACTION_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const captured = (match[1] + ' ' + (match[2] || '')).trim();
      if (captured.length > 10 && captured.length < 200) return captured;
    }
  }
  return null;
}

function extractTaskLabel(text: string): string | null {
  const match = text.match(
    /\b(implement|build|migrat|refactor|fix|add|configure|wire|deploy|setup|create|update|remove|rewrite|upgrade)\w*\s+([\w\s\-/.()]{3,80}?)[\.\n]/i,
  );
  return match ? match[0].trim() : null;
}

// ── Mod ─────────────────────────────────────────────────────────────────────

export default function (cmd: ModApi): void {
  // ── Configurable flags ───────────────────────────────────────────────────
  // Feature toggles — disable any individual behavior without uninstalling.
  cmd.addFlag('sr-checkpoints', {type: 'boolean', default: true,
    description: 'Save mid-task checkpoints and recover after crash'});
  cmd.addFlag('sr-git-state', {type: 'boolean', default: false,
    description: 'Inject git status warnings at session start'});
  cmd.addFlag('sr-task-continuity', {type: 'boolean', default: true,
    description: 'Track task intent, next action, and run-length estimates'});
  cmd.addFlag('sr-self-review', {type: 'boolean', default: true,
    description: 'Force a self-review turn before declaring completion'});
  cmd.addFlag('sr-resume', {type: 'boolean', default: true,
    description: 'Resume after sudden stops and interruptions'});

  // Numeric thresholds (string flags: --mod-option values arrive as strings)
  cmd.addFlag('sr-max-resumes', {type: 'string', default: '3',
    description: 'Max auto-resume continuations per task'});
  cmd.addFlag('sr-snapshot-interval', {type: 'string', default: '5',
    description: 'Save a mid-task checkpoint every N turns'});

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
  function checkpointsEnabled(): boolean { return boolFlag('sr-checkpoints', true); }
  function gitStateEnabled(): boolean { return boolFlag('sr-git-state', false); }
  function continuityEnabled(): boolean { return boolFlag('sr-task-continuity', true); }
  function selfReviewEnabled(): boolean { return boolFlag('sr-self-review', true); }
  function resumeEnabled(): boolean { return boolFlag('sr-resume', true); }
  function maxResumes(): number { return numFlag('sr-max-resumes', 3, 0); }
  function snapshotInterval(): number { return numFlag('sr-snapshot-interval', 5, 1); }

  // ── State ────────────────────────────────────────────────────────────────
  const filesTouched = new Set<string>();
  const filesModified = new Set<string>();
  let resumes = 0;
  let selfReviewTriggered = false;
  let checkpointInjected = false;
  let gitStateInjected = false;
  let snapshotTurnsSinceLastSave = 0;
  let finalCheckpointStatus: 'active' | 'interrupted' | 'completed' = 'active';
  const checkpointDir = path.join(cmd.cwd, '.commandcode');
  const checkpointPath = path.join(checkpointDir, 'checkpoint.json');
  const backupPath = checkpointPath + '.backup';

  // ── Verdict contract (self-repair ⇄ autopilot) ───────────────────────────
  // Every verified completion emits a verdict on the cross-mod event bus.
  // Autopilot consumes final verdicts; nothing else is allowed to act on them.
  let cycleSeq = 0;
  let currentCycleId: string | null = null;
  let cycleFromAutopilot = false;
  const lastVerifyEvidence: string[] = [];

  function nextCycleId(): string {
    cycleSeq += 1;
    return `${new Date().toISOString().slice(0, 10)}-${cycleSeq}`;
  }

  function ensureCycle(): string {
    if (!currentCycleId) currentCycleId = nextCycleId();
    return currentCycleId;
  }

  // A final verdict closes the current verification cycle. Reset per-cycle
  // state so the NEXT task in this same session starts a fresh self-review
  // gate instead of inheriting a spent one. filesModified is cycle-scoped too
  // — otherwise verdict `files[]` leaks prior tasks into every receipt.
  function closeCycle(): void {
    currentCycleId = null;
    cycleFromAutopilot = false;
    selfReviewTriggered = false;
    resumes = 0;
    lastVerifyEvidence.length = 0;
    filesModified.clear();
  }

  function emitVerdict(v: {
    cycleId: string;
    complete: boolean;
    final: boolean;
    missing?: string[];
    evidence?: string[];
  }): void {
    try {
      cmd.events.emit('self-repair/verdict', {
        version: 2,
        cycleId: v.cycleId,
        complete: v.complete,
        final: v.final,
        ...(v.missing ? {missing: v.missing} : {}),
        evidence: v.evidence ?? [...lastVerifyEvidence],
        files: Array.from(filesModified).slice(-30),
        at: Date.now(),
      });
    } catch { /* cross-mod bus is best-effort */ }
  }

  // Autopilot asks for a fresh verification cycle after each of its actions.
  // Accepting the request resets the gate so the child cycle gets its own
  // self-review pass and its own final verdict. Ack synchronously so
  // autopilot can detect a missing referee.
  cmd.events.on('self-repair/request-cycle', (req) => {
    const r = (req ?? {}) as Record<string, unknown>;
    const cycleId = typeof r.cycleId === 'string' ? r.cycleId : '';
    if (!cycleId) return;
    currentCycleId = cycleId;
    cycleFromAutopilot = true;
    selfReviewTriggered = false;
    resumes = 0;
    lastVerifyEvidence.length = 0;
    try {
      cmd.events.emit('self-repair/cycle-accepted', {cycleId});
    } catch { /* best-effort */ }
  });

  // Referee presence probe: autopilot pings, self-repair pongs synchronously.
  cmd.events.on('self-repair/ping', () => {
    try {
      cmd.events.emit('self-repair/pong', {version: 2});
    } catch { /* best-effort */ }
  });

  // ── Task continuity ─────────────────────────────────────────────────────
  let lastIntent: string | null = null;
  let nextAction: string | null = null;
  let taskDurations: Record<string, number> = {};
  let currentTaskLabel: string | null = null;
  let topicTurns = 0;
  let midEditFile: string | null = null;
  // Pending edit_file calls keyed by toolCallId, so parallel edits resolve
  // to their own entry regardless of completion order.
  const pendingEdits = new Map<string, { filePath: string }>();

  // ── Checkpoint helpers ───────────────────────────────────────────────────
  function loadCheckpoint(): {
    filesTouched: string[];
    lastTopic: string;
    lastIntent?: string;
    nextAction?: string;
    midEditFile?: string;
    taskDurations?: Record<string, number>;
    status?: string;
  } | null {
    for (const p of [checkpointPath, backupPath]) {
      try {
        if (!fs.existsSync(p)) continue;
        const raw = fs.readFileSync(p, 'utf-8');
        const cp = JSON.parse(raw);
        if (!cp.lastSession) continue;
        // Don't recover from completed sessions
        if (cp.status === 'completed') continue;
        if (p === checkpointPath) {
          try {
            fs.copyFileSync(checkpointPath, backupPath);
            fs.unlinkSync(checkpointPath);
          } catch { /* leave both alone if copy fails */ }
        }
        return {
          filesTouched: Array.isArray(cp.filesTouched) ? cp.filesTouched : [],
          lastTopic: typeof cp.lastTopic === 'string' ? cp.lastTopic : '',
          lastIntent: typeof cp.lastIntent === 'string' ? cp.lastIntent : undefined,
          nextAction: typeof cp.nextAction === 'string' ? cp.nextAction : undefined,
          midEditFile: typeof cp.midEditFile === 'string' ? cp.midEditFile : undefined,
          taskDurations: cp.taskDurations && typeof cp.taskDurations === 'object' ? cp.taskDurations : undefined,
          status: typeof cp.status === 'string' ? cp.status : undefined,
        };
      } catch { /* try next */ }
    }
    return null;
  }

  function saveCheckpoint(partial: boolean = false, status: 'active' | 'interrupted' | 'completed' = 'active') {
    if (!checkpointsEnabled()) return;
    try {
      if (!fs.existsSync(checkpointDir)) fs.mkdirSync(checkpointDir, { recursive: true });
      const checkpoint = {
        lastSession: new Date().toISOString(),
        partial: partial || undefined,
        status: status,
        filesTouched: Array.from(filesTouched).slice(-30),
        lastTopic: currentTaskLabel || '',
        lastIntent: lastIntent || undefined,
        nextAction: nextAction || undefined,
        midEditFile: midEditFile || undefined,
        taskDurations: Object.keys(taskDurations).length > 0 ? taskDurations : undefined,
      };
      const tmp = checkpointPath + '.tmp-' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2));
      try { fs.renameSync(tmp, checkpointPath); } catch {
        try { fs.unlinkSync(tmp); } catch { /* ok */ }
        fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
      }
      if (fs.existsSync(backupPath)) {
        try {
          if (fs.existsSync(checkpointPath) && fs.statSync(checkpointPath).size > 10) {
            fs.unlinkSync(backupPath);
          }
        } catch { /* ok */ }
      }
      snapshotTurnsSinceLastSave = 0;
    } catch { /* never crash */ }
  }

  // ── Hooks: checkpoint load + git state (one-shot) ────────────────────────
  cmd.hooks({
    appendSystemPrompt: () => {
      const lines: string[] = [];
      let hasAny = false;
      let cp: ReturnType<typeof loadCheckpoint> = null;

      if (!checkpointInjected) {
        checkpointInjected = true;
        cp = loadCheckpoint();
        if (cp) {
          hasAny = true;
          const statusLabel = cp.status === 'interrupted' ? 'INTERRUPTED' : 'IN PROGRESS';
          lines.push(`PREVIOUS SESSION WAS ${statusLabel}:`);
          if (cp.filesTouched.length > 0) {
            lines.push(`  Touched: ${cp.filesTouched.slice(-25).map(f => shortPath(f, cmd.cwd)).join(', ')}`);
          }
          if (cp.lastTopic) {
            lines.push(`  Topic: ${cp.lastTopic}`);
          }
          if (cp.lastIntent) {
            lastIntent = cp.lastIntent;
            lines.push(`  Intent: ${cp.lastIntent}`);
          }
          if (cp.nextAction) {
            nextAction = cp.nextAction;
            lines.push(`  Next: ${cp.nextAction}`);
          }
          if (cp.midEditFile) {
            lines.push(`  Mid-edit: ${cp.midEditFile} — re-read before editing`);
          }
          if (cp.taskDurations) {
            taskDurations = cp.taskDurations;
          }
          lines.push('Continue from exactly where you left off — do NOT restart.');
        }
      }

      if (gitStateEnabled() && !gitStateInjected) {
        gitStateInjected = true;
        try {
          const status = execSync('git status --porcelain', {
            cwd: cmd.cwd, encoding: 'utf-8', timeout: 2000,
          }).trim();
          if (status) {
            const statusLines = status.split('\n');
            const staged = statusLines.filter(l => /^[MADRC]/.test(l)).length;
            const unstaged = statusLines.filter(l => /^.[MADRC]/.test(l)).length;
            const untracked = statusLines.filter(l => l.startsWith('??')).length;
            const hasMergeConflicts = statusLines.some(l => MERGE_CONFLICT_PORCELAIN.test(l));
            const hasBadState = staged > 8 || unstaged > 25 || hasMergeConflicts;

            if (cp || hasBadState) {
              hasAny = true;
              lines.push('GIT STATE:');
              if (staged > 0) lines.push(`  ${staged} staged`);
              if (unstaged > 0) lines.push(`  ${unstaged} unstaged`);
              if (untracked > 0) lines.push(`  ${untracked} untracked`);
              if (hasMergeConflicts) lines.push('  MERGE CONFLICTS — resolve first');
              lines.push('  Commit before starting new work if from a prior session.');

              try {
                const head = execSync('git rev-parse --abbrev-ref HEAD', {
                  cwd: cmd.cwd, encoding: 'utf-8', timeout: 2000,
                }).trim();
                if (head === 'HEAD') lines.push('  DETACHED HEAD — check out a branch.');
              } catch { /* ok */ }
            }
          }
        } catch { /* not a git repo */ }
      }

      return hasAny ? lines.join('\n') : undefined;
    },
  });

  // ── Observer: file tracking ──────────────────────────────────────────────
  // tool_queued carries the ORIGINAL input; tool_completed does not carry input.
  cmd.on('tool_queued', event => {
    if (event.type !== 'tool_queued') return;
    const toolName = typeof (event as Record<string, unknown>).toolName === 'string'
      ? String((event as Record<string, unknown>).toolName) : '';
    const input = (event as Record<string, unknown>).input;
    const filePath = extractFilePath(input);
    if (filePath && !isModStatePath(filePath)) {
      if (toolName === 'edit_file' || toolName === 'write_file' || toolName === 'read_file') {
        filesTouched.add(filePath);
      }
      if (toolName === 'edit_file' || toolName === 'write_file') {
        filesModified.add(filePath);
      }
    }
    if (toolName === 'edit_file' && filePath && typeof (event as Record<string, unknown>).toolCallId === 'string') {
      pendingEdits.set(String((event as Record<string, unknown>).toolCallId), { filePath });
    }
  });

  cmd.on('tool_completed', event => {
    if (event.type !== 'tool_completed') return;
    // Drop completed edits so midEditFile only reflects calls still in flight
    const toolCallId = (event as Record<string, unknown>).toolCallId;
    if (typeof toolCallId === 'string') pendingEdits.delete(toolCallId);
    // Track mid-edit state: if edits are still pending, surface the most
    // recent one for checkpoint continuity.
    if (pendingEdits.size > 0) {
      const last = Array.from(pendingEdits.values()).pop();
      if (last) midEditFile = shortPath(last.filePath, cmd.cwd);
    } else {
      midEditFile = null;
    }
    // Mid-task snapshots: save during execution, not just at run end
    if (snapshotTurnsSinceLastSave >= snapshotInterval()) {
      saveCheckpoint(true);
    }
  });

  // ── Observer: turn counter ───────────────────────────────────────────────
  cmd.on('turn_start', () => {
    topicTurns++;
    snapshotTurnsSinceLastSave++;
  });

  // ── Hooks: verification-evidence collection ──────────────────────────────
  cmd.hooks({
    afterToolCall: async ({toolName, input, result, isError}) => {
      if (toolName !== 'shell_command' && toolName !== 'powershell') return undefined;
      const cmdText = extractCmd(input);
      if (!isVerifyCommand(cmdText)) return undefined;
      const text = contentText(result);
      if (isError || FAILURE_SIGNALS.test(text)) return undefined;
      const entry = `${cmdText.slice(0, 120)} -> green`;
      if (!lastVerifyEvidence.includes(entry)) lastVerifyEvidence.push(entry);
      return undefined;
    },
  });

  // ── Hooks: final-verdict emission ────────────────────────────────────────
  // onTurnEnd fires BEFORE the same pass's stop consultation, so the verdict
  // reaches autopilot's onStop regardless of mod registration order.
  cmd.hooks({
    onTurnEnd: async ({state}) => {
      if (!selfReviewTriggered || !currentCycleId) return state;
      const msgs = (state as Record<string, unknown>).messages;
      if (!Array.isArray(msgs) || msgs.length === 0) return state;
      const last = msgs[msgs.length - 1] as Record<string, unknown>;
      let text = '';
      const content = last.content;
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        text = content
          .filter((p: unknown) => typeof p === 'object' && p !== null &&
            (p as Record<string, unknown>).type === 'text')
          .map((p: unknown) => String((p as Record<string, unknown>).text || ''))
          .join('\n');
      }
      if (!text) return state;

      const isClosing = hasClosingSignal(text);
      const mentionsWork = WORK_MENTION_SIGNALS.test(text);
      const stillActive = STILL_ACTIVE_SIGNALS.test(text);
      const interruptedOrUnfinished =
        /\b(turn limit|context limit|timeout|truncated|token limit|budget|mid.?task|not yet|to do|remaining|wip|in progress|continuing)\b/i.test(text);

      // Clean-stop condition: the same state where onStop returns
      // {continue:false}, so the verdict can never contradict a resume.
      if (isClosing && mentionsWork && !stillActive && !interruptedOrUnfinished) {
        emitVerdict({
          cycleId: currentCycleId,
          complete: true,
          final: true,
        });
        // Clean-stop bookkeeping lives here (always runs), not in onStop:
        // autopilot's onStop may win the continuation and skip self-repair's
        // own clean-stop path.
        if (continuityEnabled() && currentTaskLabel && topicTurns >= 3) {
          taskDurations[currentTaskLabel] = topicTurns;
        }
        finalCheckpointStatus = 'completed';
        closeCycle();
      }
      return state;
    },
  });

  // ── Hooks: task continuity + self-review + interruption resume + sudden-stop ──
  cmd.hooks({
    onStop: async ({lastAssistantText, stopReason}) => {
      // A user interrupt is an explicit abort: never resume or self-review
      // over it. Let the run stop.
      if (stopReason === 'interrupted') {
        finalCheckpointStatus = 'interrupted';
        return { continue: false };
      }

      // Extract task label for duration tracking
      const taskLabel = extractTaskLabel(lastAssistantText);
      if (continuityEnabled() && taskLabel && topicTurns >= 3) {
        if (currentTaskLabel && currentTaskLabel !== taskLabel) {
          // Task changed — record old task duration
          taskDurations[currentTaskLabel] = topicTurns;
          // Reset per-task state for the new task
          selfReviewTriggered = false;
          resumes = 0;
        }
        currentTaskLabel = taskLabel;
        topicTurns = 0;
      }

      // Extract intent and next action for checkpoint continuity
      if (continuityEnabled() && (taskLabel || (currentTaskLabel && topicTurns >= 3))) {
        lastIntent = lastAssistantText.slice(0, 500);
        const next = extractNextAction(lastAssistantText);
        if (next) nextAction = next;
      }

      // Rate limit: let it stop
      if (/\b(rate.?limit|too many requests|throttl|429|503|try again later)\b/i.test(lastAssistantText)) {
        return { continue: false };
      }

      // ── Self-Review Gate ──────────────────────────────────────────────
      const isClosing = hasClosingSignal(lastAssistantText);
      const mentionsWork = WORK_MENTION_SIGNALS.test(lastAssistantText);
      const stillActive = STILL_ACTIVE_SIGNALS.test(lastAssistantText);

      if (isClosing && mentionsWork && !stillActive && selfReviewEnabled() && !selfReviewTriggered && (filesModified.size > 0 || cycleFromAutopilot)) {
        selfReviewTriggered = true;
        const cycleId = ensureCycle();
        if (continuityEnabled() && currentTaskLabel && topicTurns >= 3) {
          taskDurations[currentTaskLabel] = topicTurns;
        }
        finalCheckpointStatus = 'interrupted';
        emitVerdict({
          cycleId,
          complete: false,
          final: false,
          missing: ['self-review pass not yet completed'],
        });
        return {
          continue: true,
          reason: [
            'SELF-REVIEW: Before declaring the task done, CRITICALLY VERIFY your work:',
            '1. Re-read the original request. Did you actually deliver what was asked? Check for scope drift or missing requirements.',
            '2. Re-run the test suite (all tests must pass). If tests fail, fix them — do not stop with failures.',
            '3. Check git diff for uncommitted changes. Do they match the task scope? Any accidental edits or leftover debug code?',
            '4. Review every file you created or edited. Look for incomplete implementations, placeholder comments, TODO markers, or obviously wrong logic.',
            '5. Can a user actually use what you built? Is it wired up end-to-end, or are there missing integration points?',
            '6. If you find ANY issues, fix them. Only say "done" when all six checks pass.',
          ].join('\n'),
        };
      }

      if (!resumeEnabled()) {
        finalCheckpointStatus = 'completed';
        return { continue: false };
      }

      // ── Sudden-stop resume ──────────────────────────────────────────
      const noSignal = !isClosing;
      const textIsShort = lastAssistantText.length < 200;
      const wasProcessing =
        /\b(reading|writing|editing|running|testing|building|executing|committing|checking|verifying)\b/i.test(
          lastAssistantText,
        );

      const maxR = maxResumes();
      if (noSignal && textIsShort && wasProcessing && resumes < maxR && filesModified.size > 0) {
        resumes++;
        finalCheckpointStatus = 'interrupted';
        return {
          continue: true,
          reason: 'You stopped abruptly — likely a tool timeout or connection interruption. Check the last tool result for partial progress, then CONTINUE from where you left off. Do NOT restart from scratch.',
        };
      }

      if (resumes < maxR) {
        const interrupted =
          /\b(turn limit|context limit|timeout|truncated|token limit|budget|mid.?task)\b/i.test(
            lastAssistantText,
          );
        const unfinished =
          /\b(not yet|still (need|working|have to|must)|to do|remaining|wip|in progress|continuing)\b/i.test(
            lastAssistantText,
          );

        if ((interrupted || unfinished) && filesModified.size > 0) {
          resumes++;
          finalCheckpointStatus = 'interrupted';
          return {
            continue: true,
            reason: interrupted
              ? 'You were interrupted mid-task. Continue from exactly where you stopped — do NOT restart or re-explain context.'
              : 'Work appears incomplete. Continue from where you left off.',
          };
        }
      }

      // Mark session as completed (not interrupted). Duration recording
      // happens in onTurnEnd's clean-stop branch.
      finalCheckpointStatus = 'completed';

      return { continue: false };
    },
  });

  // ── Slash command: status ───────────────────────────────────────────────
  cmd.addCommand({
    name: 'self-repair',
    description: 'Self-repair status: cycle, gate, files, resumes, checkpoint',
    handler: () => {
      const lines = [
        `Cycle: ${currentCycleId ?? '(none)'}${cycleFromAutopilot ? ' (from autopilot)' : ''}`,
        `Self-review: ${selfReviewEnabled() ? (selfReviewTriggered ? 'triggered' : 'armed') : 'off'}`,
        `Files: ${filesTouched.size} touched · ${filesModified.size} modified`,
        `Resumes: ${resumes}/${maxResumes()}`,
        `Evidence: ${lastVerifyEvidence.length} green verify entries`,
        `Checkpoint: ${checkpointPath}${checkpointsEnabled() ? '' : ' (disabled)'}`,
        `Git state injection: ${gitStateEnabled() ? 'on' : 'off'}`,
      ];
      return {message: lines.join('\n')};
    },
  });

  // ── Hooks: mid-task snapshot save + full checkpoint + scratch-fill logging ──
  cmd.hooks({
    onRunEnd: async () => {
      saveCheckpoint(false, finalCheckpointStatus);
      finalCheckpointStatus = 'active';

      // Scratch-fill logging: record scratch dirs that accumulate files so
      // the user can spot leaky workflows.
      if (!checkpointsEnabled()) return;
      try {
        const candidates: string[] = [
          path.join(cmd.cwd, '.commandcode', 'scratch'),
        ];
        const envScratch = process.env.COMMANDCODE_SCRATCHPAD;
        if (envScratch) candidates.push(envScratch);
        for (const scratchDir of candidates) {
          if (!fs.existsSync(scratchDir)) continue;
          const scratchFiles = fs.readdirSync(scratchDir).filter(f => f !== '.' && f !== '..');
          if (scratchFiles.length > 5) {
            const logPath = path.join(checkpointDir, 'orphan-scratch.log');
            const MAX_LOG_LINES = 50;
            try {
              if (fs.existsSync(logPath)) {
                const existing = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
                if (existing.length >= MAX_LOG_LINES) {
                  fs.writeFileSync(logPath, existing.slice(-MAX_LOG_LINES / 2).join('\n') + '\n');
                }
              }
            } catch { /* ok */ }
            fs.appendFileSync(
              logPath,
              `${new Date().toISOString()} — ${scratchDir}: ${scratchFiles.length} files\n`,
            );
          }
        }
      } catch { /* ok */ }
    },
  });
}
