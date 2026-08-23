import type {ModApi} from '@commandcode/harness';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Write-tool blocklist ────────────────────────────────────────────────────

const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'task_create',
]);

const DANGEROUS_COMMANDS = [
  /\bgit\s+push\b.*--force(?!-with-lease)\b/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\brm\s+-rf\b/,
  /\bgit\s+commit\s+--amend\b/,
];

function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMANDS.some(r => r.test(command));
}

function isShellWriteCommand(command: string): boolean {
  return (
    /(?:\b|\s)>\s*[\w./-]+/.test(command) ||
    /\b>>\s*[\w./-]+/.test(command) ||
    /\bsed\s+-i\b/.test(command) ||
    /\btee\b/.test(command) ||
    /\bgit\s+(checkout|stash|commit|add)\b/.test(command) ||
    /\b(Set-Content|Out-File|Add-Content)\b/i.test(command)
  );
}

function extractFilePath(input: unknown): string | null {
  if (typeof input === 'object' && input !== null && 'file_path' in input) {
    return String((input as Record<string, unknown>).file_path);
  }
  return null;
}

// ── Approval/revise signals ─────────────────────────────────────────────────

const APPROVE_SIGNALS = /^\s*(approve|accept|lgtm|ship\s+it)\s*[.!]?\s*$/i;
const REVISE_SIGNALS = /^\s*(revise|rework|try\s+again)\s*[.!]?\s*$/i;
// Answer responses are the whole line, matching the briefing's response format:
// "Q1-2", "1-2", "delegate Q3", or a bare option number for linear answers.
const ANSWER_SIGNALS = /^\s*(?:Q\d+[-–]\d+|\d+[-–]\d+|delegate\s+Q\d+|\d+)\s*$/i;

// ── Helpers ─────────────────────────────────────────────────────────────────

function todaySlug(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'plan';
}

// ── Mod ─────────────────────────────────────────────────────────────────────

export default function (cmd: ModApi): void {
  // ─── State (closure-scoped, matching self-repair pattern) ───────────────
  type State = 'IDLE' | 'BRIEFING' | 'COMPILING' | 'REVIEW';

  let currentState: State = 'IDLE';
  let objective: string = '';
  let round: number = 0;
  let compiledPlanPath: string = '';
  let approved: boolean = false;
  let planWritten: boolean = false;
  let reviewNotified: boolean = false;

  function reset(): void {
    currentState = 'IDLE';
    objective = '';
    round = 0;
    compiledPlanPath = '';
    approved = false;
    planWritten = false;
    reviewNotified = false;
  }

  // ─── Flag helpers ──────────────────────────────────────────────────────
  function planPath(): string {
    return String(cmd.getFlag('cc-plan-path') || '~/.commandcode/plans/')
      .replace(/\/?$/, '/');
  }

  // addFlag supports only 'boolean' | 'string' — a --mod-option value for a
  // numeric flag arrives as a string, so parse it here.
  function numFlag(name: string, fallback: number, min: number = 0): number {
    const v = cmd.getFlag(name);
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (!Number.isFinite(n) || n < min) return fallback;
    return n;
  }

  function boolFlag(name: string, fallback: boolean): boolean {
    const v = cmd.getFlag(name);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v !== 'false';
    return fallback;
  }

  function maxRounds(): number {
    return numFlag('cc-max-rounds', 3, 1);
  }

  function verbose(): boolean {
    return boolFlag('cc-verbose', false);
  }

  function notify(message: string): void {
    if (verbose()) {
      cmd.ui.notify(message);
    }
  }

  // ─── Resolve plan path (expand ~ to home, resolve relative to cwd) ─────
  function resolvedPlanPath(): string {
    let base = planPath();
    if (base.startsWith('~/')) {
      base = path.join(os.homedir(), base.slice(2));
    }
    base = path.resolve(cmd.cwd, base);
    return base.endsWith(path.sep) ? base : base + path.sep;
  }

  // ─── Prompts ───────────────────────────────────────────────────────────
  function briefingPrompt(): string {
    const roundInfo = round <= 1
      ? `Round ${round}/${maxRounds()} — first pass: discover decisions`
      : `Round ${round}/${maxRounds()} — narrowing: fewer open decisions each round`;

    return `
▌ COMMAND CENTER — BRIEFING MODE
▌ Objective: ${objective}
▌ ${roundInfo}

You are in a DECISION FUNNEL. Your job is to narrow ambiguity, not write code.
Guide the conversation toward convergence — each round should have fewer open
decisions than the last. When all [CRITICAL] and [IMPORTANT] decisions are
settled, proactively suggest compiling the plan.

RULES:
1. INSPECT first — read README, AGENTS.md, existing code, config, docs.
2. IDENTIFY decisions that require human judgment.
3. PRESENT 2-4 concrete options per remaining open decision. NEVER ask
   open-ended questions. Every question list MUST end with a numbered
   "Other — specify below" option so the user is never boxed in.
4. FORMAT each decision like this:

   Q1 [CRITICAL] Database
     1. PostgreSQL — mature, typed, needs separate server
     2. SQLite — zero-config, single-file, less concurrent
     3. Other — specify below

5. TAG each question by importance: [CRITICAL] / [IMPORTANT] / [NICE-TO-HAVE].
6. USER RESPONDS by question number and option: "Q1-2" or "1-2" means Q1
   option 2. Shorthand: if answering linearly, just "2" works. Delegate:
   "delegate Q3" lets the model pick. Custom: "Q1-3: use DynamoDB".
7. After every round, summarize settled decisions and remaining open ones.
8. When all [CRITICAL] decisions are settled, say:
   "All critical decisions resolved. /commandcenter-compile when ready."
   Do NOT drag out the briefing after the important calls are made.

COMMANDS: /commandcenter-compile, /commandcenter-cancel, /commandcenter-status

You CANNOT write code, edit files, or create tasks in this mode.
Use read_file, glob, grep, read_directory, web_search, and web_fetch only.
`; }

  function compilationPrompt(): string {
    const rp = resolvedPlanPath();
    const filename = `command-center-${todaySlug()}-${slugify(objective)}.md`;
    const fullPath = `${rp}${filename}`;
    compiledPlanPath = fullPath;

    return `
▌ COMMAND CENTER — COMPILATION MODE
▌ Objective: ${objective}
▌ Target: ${fullPath}

You are now producing the PLAN ARTIFACT. Write it to ${fullPath}.

STRUCTURE:
- # ${objective}
- ## Status — date, gate conditions
- ## Decisions Made — each decision, the option chosen, and by whom (human/delegated)
- ## Assumptions — what you're assuming that wasn't explicitly decided
- ## Design — architecture, component interactions, data flow
- ## Implementation Steps — task-by-task, each independently verifiable
- ## Verification — how to know the work is done correctly
- ## Open Questions — decisions deferred or requiring later attention

INSTRUCTIONS:
- Check for existing plan conventions in the project (read docs/plans/ for
  templates or existing phase plans).
- Create the directory if it doesn't exist.
- Write the plan file, then announce: "Plan saved to ${fullPath}."
`.trim();
  }

  function reviewPrompt(): string {
    if (approved) {
      return `
▌ COMMAND CENTER — REVIEW APPROVED
▌ Plan: ${compiledPlanPath}

The user has approved the plan. Call enter_plan_mode to open it for formal review.
`.trim();
    }
    return `
▌ COMMAND CENTER — REVIEW MODE
▌ Plan: ${compiledPlanPath}

The plan artifact has been written. Review it before proceeding.

- Reply "approve" to enter plan mode for formal review.
- Reply "revise" to return to briefing and refine decisions.

COMMANDS: /commandcenter-cancel, /commandcenter-status
`.trim();
  }

  // ─── Flags ─────────────────────────────────────────────────────────────
  cmd.addFlag('cc-plan-path', {
    type: 'string',
    default: '~/.commandcode/plans/',
    description: 'Where to save plan artifacts (~/ for home, or project-relative)',
  });
  cmd.addFlag('cc-max-rounds', {
    type: 'string',
    default: '3',
    description: 'Maximum briefing rounds before auto-compile',
  });
  cmd.addFlag('cc-verbose', {
    type: 'boolean',
    default: false,
    description: 'Show internal state transitions as notifications',
  });

  // ─── Slash commands ────────────────────────────────────────────────────
  cmd.addCommand({
    name: 'commandcenter',
    description: 'Start a Command Center briefing for a structured plan',
    argumentHint: '[objective]',
    handler: ({args}) => {
      if (currentState === 'BRIEFING' || currentState === 'COMPILING' || currentState === 'REVIEW') {
        reset();
      }
      const obj = args.trim();
      if (!obj) {
        objective = '';
        currentState = 'BRIEFING';
        round = 1;
        notify('Command Center briefing started (no objective yet)');
        return {
          prompt:
            'Ask the user what they want to build or accomplish. Do not proceed until you have a clear objective statement.',
        };
      }
      objective = obj;
      currentState = 'BRIEFING';
      round = 1;
      notify(`Command Center briefing started: "${objective}"`);
      return {
        prompt: `Command Center briefing started for: ${objective}`,
      };
    },
  });

  cmd.addCommand({
    name: 'commandcenter-compile',
    description: 'Compile the current briefing into a plan artifact',
    handler: () => {
      if (currentState !== 'BRIEFING' && currentState !== 'COMPILING') {
        return {message: 'No active briefing to compile. Start one with /commandcenter.'};
      }
      currentState = 'COMPILING';
      notify('Transitioning to COMPILATION mode');
      return {
        prompt: `Compile the plan for: ${objective}`,
      };
    },
  });

  cmd.addCommand({
    name: 'commandcenter-cancel',
    description: 'Cancel the active Command Center session',
    handler: () => {
      if (currentState === 'IDLE') {
        return {message: 'No active briefing to cancel.'};
      }
      const was = currentState;
      reset();
      notify('Command Center session cancelled.');
      return {
        message: `Command Center ${was === 'REVIEW' ? 'review' : was === 'COMPILING' ? 'compilation' : 'briefing'} cancelled.`,
      };
    },
  });

  cmd.addCommand({
    name: 'commandcenter-status',
    description: 'Show current Command Center state',
    handler: () => {
      if (currentState === 'IDLE') {
        return {message: 'Command Center is idle. Start a briefing with /commandcenter.'};
      }
      return {
        message: [
          `State: ${currentState}`,
          `Objective: ${objective || '(none)'}`,
          currentState === 'BRIEFING' ? `Round: ${round}/${maxRounds()}` : '',
          compiledPlanPath ? `Plan: ${compiledPlanPath}` : '',
        ].filter(Boolean).join('\n'),
      };
    },
  });

  // ─── transformInput: REVIEW state approve/revise ─────────────────────────
  cmd.hooks({
    transformInput: ({text}) => {
      if (currentState === 'IDLE') {
        return {action: 'continue'};
      }

      if (currentState === 'BRIEFING' && objective === '') {
        objective = text.trim();
        if (objective) {
          notify(`Objective captured: "${objective}"`);
        }
        return {action: 'continue'};
      }

      if (currentState === 'BRIEFING') {
        if (ANSWER_SIGNALS.test(text)) {
          round += 1;
          notify(`Round ${round}/${maxRounds()} — answer received`);
        }
        return {action: 'continue'};
      }

      if (currentState === 'REVIEW') {
        if (APPROVE_SIGNALS.test(text)) {
          approved = true;
          return {
            action: 'continue',
          };
        }
        if (REVISE_SIGNALS.test(text)) {
          currentState = 'BRIEFING';
          notify('Returning to briefing for revision.');
          return {
            action: 'continue',
          };
        }
        return {action: 'continue'};
      }

      return {action: 'continue'};
    },
  });

  // ─── appendSystemPrompt: context injection ─────────────────────────────
  cmd.hooks({
    appendSystemPrompt: () => {
      switch (currentState) {
        case 'IDLE':
          return undefined;
        case 'BRIEFING':
          return briefingPrompt();
        case 'COMPILING':
          return compilationPrompt();
        case 'REVIEW':
          return reviewPrompt();
      }
    },
  });

  // ─── beforeToolCall: tool gating ───────────────────────────────────────
  cmd.hooks({
    beforeToolCall: async ({toolName, input}) => {
      if (currentState === 'IDLE' || currentState === 'REVIEW') {
        if (currentState === 'REVIEW' && (toolName === 'shell_command' || toolName === 'powershell')) {
          const command =
            typeof input === 'object' && input !== null && 'command' in input
              ? String(input.command)
              : '';
          if (isDangerousCommand(command) || isShellWriteCommand(command)) {
            return {
              block: true,
              additionalContext:
                'BLOCKED: Shell commands that modify files are blocked during review. ' +
                'The plan is already compiled.',
            };
          }
        }
        // The plan artifact is already written — nothing may be modified
        // during review, not even the plan file.
        if (currentState === 'REVIEW' && WRITE_TOOLS.has(toolName)) {
          return {
            block: true,
            additionalContext:
              'BLOCKED: You are in Command Center REVIEW mode. The plan has been ' +
              'compiled. Reply "approve" to enter plan mode, "revise" to return to ' +
              'briefing, or use /commandcenter-cancel to exit.',
          };
        }
        return undefined;
      }

      if (currentState === 'BRIEFING') {
        if (WRITE_TOOLS.has(toolName)) {
          return {
            block: true,
            additionalContext:
              'BLOCKED: You are in Command Center BRIEFING mode. ' +
              'Do not write code, edit files, or create tasks. ' +
              'Focus on understanding the codebase and presenting decisions ' +
              'to the user. Use /commandcenter-cancel to exit briefing.',
          };
        }
        if (toolName === 'shell_command' || toolName === 'powershell') {
          const command =
            typeof input === 'object' && input !== null && 'command' in input
              ? String(input.command)
              : '';
          if (isDangerousCommand(command)) {
            return {
              block: true,
              additionalContext: 'BLOCKED: Destructive command blocked during briefing mode.',
            };
          }
          if (isShellWriteCommand(command)) {
            return {
              block: true,
              additionalContext: 'BLOCKED: Shell file writes are not allowed during briefing mode.',
            };
          }
        }
        return undefined;
      }

      if (currentState === 'COMPILING') {
        if (WRITE_TOOLS.has(toolName)) {
          const filePath = extractFilePath(input);
          if (!filePath) {
            return {
              block: true,
              additionalContext:
                `BLOCKED: In COMPILING mode, writes are restricted to the plan file (${compiledPlanPath}).`,
            };
          }
          const normalizedInput = path.resolve(
            filePath.startsWith('~/')
              ? path.join(os.homedir(), filePath.slice(2))
              : filePath,
          );
          const normalizedPlan = path.resolve(compiledPlanPath);
          if (normalizedInput !== normalizedPlan) {
            return {
              block: true,
              additionalContext:
                `BLOCKED: In COMPILING mode, writes are restricted to the plan file (${compiledPlanPath}).`,
            };
          }
        }
        if (toolName === 'shell_command' || toolName === 'powershell') {
          const command =
            typeof input === 'object' && input !== null && 'command' in input
              ? String(input.command)
              : '';
          if (isDangerousCommand(command)) {
            return {
              block: true,
              additionalContext: 'BLOCKED: Destructive command blocked during compilation.',
            };
          }
          if (isShellWriteCommand(command)) {
            return {
              block: true,
              additionalContext: 'BLOCKED: Shell file writes are restricted to the plan file during compilation.',
            };
          }
        }
        return undefined;
      }

      return undefined;
    },
  });

  // ─── afterToolCall: detect plan file written ───────────────────────────
  cmd.hooks({
    afterToolCall: async ({toolName, input, isError}) => {
      if (currentState !== 'COMPILING' || planWritten || isError) {
        return undefined;
      }
      if (toolName === 'write_file' || toolName === 'edit_file') {
        const rawPath =
          typeof input === 'object' && input !== null && 'file_path' in input
            ? String((input as Record<string, unknown>).file_path)
            : '';
        if (!rawPath) return undefined;
        const normalizedInput = path.resolve(
          rawPath.startsWith('~/') ? path.join(os.homedir(), rawPath.slice(2)) : rawPath,
        );
        const normalizedPlan = path.resolve(compiledPlanPath);
        if (normalizedInput === normalizedPlan) {
          planWritten = true;
        }
      }
      return undefined;
    },
  });

  // ─── Observe: round tracking & state transitions ───────────────────────
  cmd.on('run_end', () => {
    if (currentState === 'BRIEFING' && round > maxRounds()) {
      notify(`Briefing continues past max rounds (${maxRounds()}). Compile when ready: /commandcenter-compile`);
    }

    if (currentState === 'COMPILING' && planWritten) {
      currentState = 'REVIEW';
      planWritten = false;
      reviewNotified = false;
      notify(`Plan compiled. Entering review.`);
    }

    if (currentState === 'REVIEW' && !reviewNotified) {
      reviewNotified = true;
      notify(`Review the plan at ${compiledPlanPath}`);
    }
  });
}
