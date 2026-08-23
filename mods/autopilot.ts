import type {ModApi} from '@commandcode/harness';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Autopilot — a verified-momentum engine for Command Code ──────────────────
//
// Autopilot does not babysit the model and does not activate mid-task. It
// waits until the self-repair mod (session-persistence) emits a FINAL verdict
// that the current task is verified done, then looks around the immediate
// neighborhood and spends a small, bounded trust budget on safe local
// follow-ups.
//
// North star:
//   No verified done, no initiative.
//   No verification, no green.
//   No mandate, no motion.
//   No receipts, no trust.
//
// v0.1 scope:
//   - green actions execute automatically (one per repair cycle);
//   - yellow/red are proposed only, red attempts are blocked;
//   - every executed action re-enters self-repair verification;
//   - receipts are written to .commandcode/autopilot/receipts.jsonl.

// ── Types ────────────────────────────────────────────────────────────────────

type Tier = 'green' | 'yellow' | 'red';

interface RepairVerdict {
  version: number;
  cycleId: string;
  complete: boolean;
  final: boolean;
  missing?: string[];
  evidence: string[];
  files: string[];
  at: number;
}

interface NextAction {
  id: string;
  title: string;
  tier: Tier;
  why: string;
  scope: string[];
  verify: string[];
  rollback: string;
  confidence: number;
  impact: number;
  reversibility: 'trivial' | 'checkpoint' | 'hard' | 'irreversible';
  blastRadius: 'file' | 'module' | 'repo' | 'external';
  touchesSecrets: boolean;
  externalSideEffect: boolean;
  requestedByTask: boolean;
  goalDrift: number;
  status: 'queued' | 'doing' | 'awaiting_repair' | 'done' | 'proposed' | 'blocked';
}

interface Mandate {
  mode: 'off' | 'suggest' | 'momentum';
  actions_after_done: number;
  budget: {turns: number};
  scope: string[];
  forbidden: string[];
  quiet_when_idle: boolean;
  max_green_chain: number;
}

interface Receipt {
  ts: string;
  cycleId: string;
  actionId: string;
  tier: Tier;
  title: string;
  why: string;
  scope: string[];
  verify: string[];
  rollback: string;
  outcome: string;
  stoppedBecause?: string;
}

interface DecisionEntry {
  ts: number;
  actionId: string;
  decision: string;
  reason: string;
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

// Red table: deterministic, always-proposal-only actions.
const RED_PATTERNS = [
  /\bgit\s+push\b/,
  /\b(npm|pnpm|yarn|bun|npx)\s+(publish|whoami|login|logout|adduser)\b/,
  /\b(aws|az|gcloud|terraform|kubectl|helm|doctl)\b/,
  /\b(deploy|provision|migrate)\b/,
  /\b(production|prod|staging|infra)\b/,
  /\b(DELETE|DROP|TRUNCATE)\b/,
  /\bgit\s+(reset\s+--hard|push\s+-f|clean\s+-fd)\b/,
  /\brm\s+-rf\b/,
  /\b(setup|configure)\s+(dns|domain|ssl|cert)\b/i,
];

// Secrets: touching these is never green.
const SECRET_PATTERNS = [
  /\.env(\.local|\.production|\.staging)?$/i,
  /(secret|credential|keychain|keystore|token|password)\.(json|key|pem|crt|p12)$/i,
  /\.ssh\//i,
  /\.aws\//i,
];

// Security-semantics touch: auth/security/crypto changes are red-adjacent.
const SECURITY_SEMANTICS = /\b(auth|authentication|authorization|permission|security|crypto|encrypt|token|jwt|session)\b/i;

// Injection rule: instructions found inside tool OUTPUT can never create
// green candidates. Output-derived directives matching these are red.
const INJECTION_RED_SIGNALS = [
  /(run|execute|curl|wget|git push|publish|deploy|install)\s+[^\s]+\s+from\s+the\s+output/i,
  /please\s+(run|execute|push|publish|deploy)/i,
];

export function tierFromScope(input: {
  requestedByTask: boolean;
  touchesSecrets: boolean;
  externalSideEffect: boolean;
  hasVerification: boolean;
  blastRadius: NextAction['blastRadius'];
  reversibility: NextAction['reversibility'];
  goalDrift: number;
}): Tier {
  if (input.touchesSecrets || input.externalSideEffect) return 'red';
  if (input.reversibility === 'irreversible') return 'red';
  if (input.blastRadius === 'external') return 'red';
  if (!input.requestedByTask || input.goalDrift > 2) return 'yellow';
  if (!input.hasVerification) return 'yellow';
  if (input.blastRadius === 'repo') return 'yellow';
  return 'green';
}

export function isRedCommand(cmd: string): boolean {
  return cmd.length > 0 && RED_PATTERNS.some(p => p.test(cmd));
}

export function isSecretPath(p: string): boolean {
  return SECRET_PATTERNS.some(r => r.test(p));
}

export function isSecurityTouch(p: string): boolean {
  return SECURITY_SEMANTICS.test(p);
}

export function injectionRedFlags(text: string): string[] {
  return INJECTION_RED_SIGNALS.filter(r => r.test(text)).map(String);
}

export function isForbidden(cmd: string, forbidden: string[]): boolean {
  if (forbidden.length === 0) return false;
  const lower = cmd.toLowerCase();
  return forbidden.some(f => f.length > 0 && lower.includes(f.toLowerCase()));
}

export function pathWithinScope(p: string, scope: string[], cwd: string): boolean {
  if (scope.length === 0) return true; // no scope restriction
  const resolved = path.resolve(p.startsWith('~') ? path.join(os.homedir(), p.slice(2)) : p);
  const abs = path.isAbsolute(resolved) ? resolved : path.resolve(cwd, resolved);
  const norm = path.normalize(abs).toLowerCase();
  for (const s of scope) {
    const sAbs = path.isAbsolute(s) ? s : path.resolve(cwd, s);
    const normS = path.normalize(sAbs).toLowerCase();
    if (norm === normS || norm.startsWith(normS + path.sep)) return true;
  }
  return false;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'task';
}

function shortPath(p: string, cwd: string): string {
  const normPath = path.normalize(p).toLowerCase();
  const normCwd = path.normalize(cwd).toLowerCase();
  if (normPath === normCwd) return path.basename(p);
  const cwdSep = normCwd + path.sep;
  if (normPath.startsWith(cwdSep)) return p.slice(cwdSep.length);
  return path.basename(p);
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

// ── Mod ──────────────────────────────────────────────────────────────────────

export default function (cmd: ModApi): void {
  // ── Flags ───────────────────────────────────────────────────────────────
  cmd.addFlag('auto-mode', {type: 'string', default: 'suggest',
    description: 'Autopilot mode: off | suggest | momentum'});
  cmd.addFlag('auto-actions', {type: 'string', default: '3',
    description: 'Max actions after a verified completion'});
  cmd.addFlag('auto-max-green-chain', {type: 'string', default: '3',
    description: 'Max consecutive green actions'});
  cmd.addFlag('auto-budget-turns', {type: 'string', default: '25',
    description: 'Max turns in one initiative cycle'});
  cmd.addFlag('auto-scope', {type: 'string', default: '',
    description: 'Comma-separated scope paths (empty = repo root)'});
  cmd.addFlag('auto-forbidden', {type: 'string', default: 'push,publish,deploy,migrate',
    description: 'Comma-separated forbidden command substrings'});

  function numFlag(name: string, fallback: number, min: number = 0): number {
    const v = cmd.getFlag(name);
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (!Number.isFinite(n) || n < min) return fallback;
    return n;
  }

  // ── Mandate resolution ──────────────────────────────────────────────────
  let mandateOverride: Mandate | null = null;
  let paused = false;

  function loadMandate(): Mandate {
    if (mandateOverride) return mandateOverride;
    const filePath = path.join(cmd.cwd, '.commandcode', 'autopilot.json');
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return normalizeMandate(raw);
      }
    } catch { /* fall through to flags */ }
    return mandateFromFlags();
  }

  function mandateFromFlags(): Mandate {
    const modeRaw = String(cmd.getFlag('auto-mode') || 'suggest') as Mandate['mode'];
    const mode: Mandate['mode'] = modeRaw === 'momentum' || modeRaw === 'off' ? modeRaw : 'suggest';
    const scope = String(cmd.getFlag('auto-scope') || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const forbidden = String(cmd.getFlag('auto-forbidden') || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    return {
      mode,
      actions_after_done: numFlag('auto-actions', 3),
      budget: {turns: numFlag('auto-budget-turns', 25)},
      scope,
      forbidden,
      quiet_when_idle: true,
      max_green_chain: numFlag('auto-max-green-chain', 3),
    };
  }

  function normalizeMandate(raw: Record<string, unknown>): Mandate {
    const mode = raw.mode === 'momentum' || raw.mode === 'off' ? raw.mode : 'suggest';
    return {
      mode,
      actions_after_done: typeof raw.actions_after_done === 'number' ? raw.actions_after_done : 3,
      budget: {
        turns: typeof raw.budget === 'object' && raw.budget !== null &&
          typeof (raw.budget as Record<string, unknown>).turns === 'number'
          ? (raw.budget as Record<string, unknown>).turns as number : 25,
      },
      scope: Array.isArray(raw.scope) ? raw.scope.map(String) : [],
      forbidden: Array.isArray(raw.forbidden) ? raw.forbidden.map(String) : [],
      quiet_when_idle: raw.quiet_when_idle !== false,
      max_green_chain: typeof raw.max_green_chain === 'number' ? raw.max_green_chain : 3,
    };
  }

  function effectiveMode(): Mandate['mode'] {
    if (paused) return 'suggest';
    return loadMandate().mode;
  }

  // ── State ───────────────────────────────────────────────────────────────
  let pendingVerdict: RepairVerdict | null = null;
  let consumedCycleId: string | null = null;
  const backlog: NextAction[] = [];
  let currentActionId: string | null = null;
  let greenChain = 0;
  let initiativeActions = 0;
  let initiativeTurns = 0;
  const decisionLog: DecisionEntry[] = [];
  let injectionBlockedAction = false;
  // Referee presence: probed synchronously on the first run. Without the
  // self-repair mod, momentum is permanently disabled (suggest-only).
  let refereePresent = false;
  let refereeProbed = false;
  let runStartedAt = 0;
  const receiptsDir = path.join(cmd.cwd, '.commandcode', 'autopilot');
  const receiptsPath = path.join(receiptsDir, 'receipts.jsonl');

  function logDecision(actionId: string, decision: string, reason: string): void {
    decisionLog.push({ts: Date.now(), actionId, decision, reason});
  }

  function writeReceipt(r: Receipt): void {
    try {
      if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, {recursive: true});
      fs.appendFileSync(receiptsPath, JSON.stringify(r) + '\n');
    } catch { /* receipts are best-effort */ }
  }

  // ── Activation: verdict consumption ─────────────────────────────────────
  cmd.events.on('self-repair/verdict', (raw) => {
    const v = (raw ?? {}) as Record<string, unknown>;
    if (v.final !== true || v.complete !== true) return;
    const childOfCurrentAction = currentActionId !== null &&
      typeof v.cycleId === 'string' && String(v.cycleId).includes('/' + currentActionId);
    if (childOfCurrentAction) {
      // The action's child verification cycle finished: the action's lifetime
      // ends here. Guard-state must not leak into subsequent turns.
      currentActionId = null;
      updateStatus();
    }
    const verdict: RepairVerdict = {
      version: typeof v.version === 'number' ? v.version : 0,
      cycleId: typeof v.cycleId === 'string' ? v.cycleId : 'unknown',
      complete: true,
      final: true,
      evidence: Array.isArray(v.evidence) ? v.evidence.map(String) : [],
      files: Array.isArray(v.files) ? v.files.map(String) : [],
      at: typeof v.at === 'number' ? v.at : Date.now(),
    };
    if (verdict.version < 2) {
      logDecision('n/a', 'verdict-rejected', 'contract version < 2');
      return;
    }
    pendingVerdict = verdict;
    updateStatus();
  });

  // ── Referee probe (synchronous handshake) ───────────────────────────────
  let pongSeen = false;
  cmd.events.on('self-repair/pong', () => { pongSeen = true; });
  cmd.events.on('self-repair/cycle-accepted', () => { /* ack observed in emitter */ });

  cmd.on('run_start', () => {
    runStartedAt = Date.now();
    initiativeTurns = 0;
    if (!refereeProbed) {
      refereeProbed = true;
      pongSeen = false;
      try { cmd.events.emit('self-repair/ping', {at: Date.now()}); } catch { /* best-effort */ }
      refereePresent = pongSeen;
      if (!refereePresent) {
        cmd.ui.notify('autopilot: self-repair mod not installed — momentum disabled, suggest-only.');
      }
    }
  });

  // ── Hooks: injection check only ────────────────────────────────────────
  // File/evidence tracking is NOT duplicated here: the verdict carries the
  // receipt (files + evidence) and the backlog trusts it.
  cmd.hooks({
    afterToolCall: async ({toolName, result}) => {
      if (toolName !== 'shell_command' && toolName !== 'powershell') return undefined;
      const text = contentText(result);
      // Injection rule: directives inside tool output can never create green
      // actions. Record red flags so the classifier fails upward.
      const redFlags = injectionRedFlags(text);
      if (redFlags.length > 0) {
        for (const flag of redFlags) {
          logDecision(currentActionId ?? 'n/a', 'injection-red', flag);
        }
        // Output-derived directives abort the current initiative action: the
        // instruction stream was compromised, so no further green action is
        // safe. The child cycle will be judged without autopilot's backing.
        if (currentActionId) {
          injectionBlockedAction = true;
          currentActionId = null;
        }
      }
      return undefined;
    },
  });

  cmd.on('turn_start', () => {
    if (currentActionId || pendingVerdict) initiativeTurns++;
  });

  // ── Backlog builder (deterministic signals only) ────────────────────────
  function buildBacklog(): void {
    backlog.length = 0;
    const verdict = pendingVerdict;
    if (!verdict) return;

    const cwd = cmd.cwd;
    const modified = verdict.files.filter(f => !isSecretPath(f));
    const evidence = verdict.evidence;

    const srcFiles = modified
      .map(f => shortPath(f, cwd))
      .filter(f => !isSecretPath(f));

    const src = srcFiles.filter(f => /\.(ts|tsx|js|jsx|py|rs|go|java|rb|c|h|cpp|cs)$/i.test(f));
    const touchedScope = src.length > 0 ? src[0].split(path.sep)[0] || '' : '';

    // 1. Regression test (green): a verify ran green + non-test sources touched.
    if (evidence.length > 0 && src.length > 0) {
      backlog.push({
        id: 'green-1',
        title: `Add a regression test covering the change in ${src.join(', ')}`,
        tier: 'green',
        why: 'A verification command passed while non-test sources were touched; ' +
          'the change has no dedicated regression coverage yet.',
        scope: src,
        verify: [`run the focused test suite for the touched scope`],
        rollback: 'git checkout -- <created test file>',
        confidence: 0.9,
        impact: 4,
        reversibility: 'trivial',
        blastRadius: 'file',
        touchesSecrets: false,
        externalSideEffect: false,
        requestedByTask: true,
        goalDrift: 0,
        status: 'queued',
      });
    }

    // 2. Docs refresh (green): docs exist in the repo.
    const docsDirs = ['docs', 'doc', 'README.md'];
    const docsExist = docsDirs.some(d => {
      try {
        const p = path.join(cwd, d);
        return fs.existsSync(p);
      } catch { return false; }
    });
    if (docsExist && src.length > 0) {
      backlog.push({
        id: `green-${backlog.length + 1}`,
        title: 'Update docs/comments that describe the touched behavior',
        tier: 'green',
        why: 'Documentation exists and the change may have made parts of it stale.',
        scope: [`${touchedScope}`],
        verify: ['read the docs and confirm they match current behavior'],
        rollback: 'git checkout -- <updated docs>',
        confidence: 0.8,
        impact: 3,
        reversibility: 'trivial',
        blastRadius: 'file',
        touchesSecrets: false,
        externalSideEffect: false,
        requestedByTask: true,
        goalDrift: 0,
        status: 'queued',
      });
    }

    // 3. Broader verify (green): another fast verify command is available.
    if (evidence.length > 0) {
      backlog.push({
        id: `green-${backlog.length + 1}`,
        title: 'Run the broader relevant suite (typecheck/lint/adjacent tests)',
        tier: 'green',
        why: 'The focused pass was green; a broader pass is cheap and confirms ' +
          'the change did not ripple.',
        scope: [],
        verify: ['run the broader suite; do not chase pre-existing failures'],
        rollback: 'none needed (read-only)',
        confidence: 0.85,
        impact: 2,
        reversibility: 'trivial',
        blastRadius: 'module',
        touchesSecrets: false,
        externalSideEffect: false,
        requestedByTask: true,
        goalDrift: 0,
        status: 'queued',
      });
    }

    // Yellow proposal: sibling-module pattern (not executed in v0.1).
    if (src.length > 0) {
      backlog.push({
        id: 'yellow-1',
        title: `Check for the same bug pattern in sibling modules near ${touchedScope}`,
        tier: 'yellow',
        why: 'The same defect class may exist in adjacent code, but that is ' +
          'outside the completed task\'s scope.',
        scope: [],
        verify: [],
        rollback: 'n/a (proposal only)',
        confidence: 0.5,
        impact: 3,
        reversibility: 'checkpoint',
        blastRadius: 'module',
        touchesSecrets: false,
        externalSideEffect: false,
        requestedByTask: false,
        goalDrift: 1,
        status: 'proposed',
      });
    }

    // Red proposal: release/publish (always proposed, never executed).
    backlog.push({
      id: 'red-1',
      title: 'Publish a patch release with this fix',
      tier: 'red',
      why: 'A verified fix may warrant a release, but publishing touches the ' +
        'outside world and requires explicit human approval.',
      scope: [],
      verify: [],
      rollback: 'n/a (proposal only)',
      confidence: 0.9,
      impact: 5,
      reversibility: 'hard',
      blastRadius: 'external',
      touchesSecrets: false,
      externalSideEffect: true,
      requestedByTask: false,
      goalDrift: 3,
      status: 'proposed',
    });
  }

  function nextGreen(): NextAction | undefined {
    return backlog.find(a => a.tier === 'green' && a.status === 'queued');
  }

  function instructionBlock(action: NextAction): string {
    return [
      'AUTOPILOT (verified follow-up — one bounded action):',
      `Task: ${action.title}`,
      `Scope: ${action.scope.length > 0 ? action.scope.join(', ') : 'repo-local, in the touched area only'}`,
      `Verify: ${action.verify.join('; ') || 'run the relevant check'}`,
      `Rollback: ${action.rollback}`,
      'Constraints: do ONLY this. Do not refactor unrelated code, do not',
      'touch dependencies, do not push or publish. Do not claim the task is',
      'done — self-repair will verify this action separately. End your turn',
      'with what you changed and what you verified.',
    ].join('\n');
  }

  // ── The actuator: onStop ────────────────────────────────────────────────
  cmd.hooks({
    onStop: async ({lastAssistantText, stopReason}) => {
      // A user interrupt is an explicit abort: never take initiative over it.
      if (stopReason === 'interrupted') return undefined;

      const mandate = loadMandate();
      const mode = effectiveMode();

      // Never act while self-repair is still fighting for truth.
      if (!pendingVerdict || consumedCycleId === pendingVerdict.cycleId) {
        return undefined;
      }
      // Mandate before momentum.
      if (mode !== 'momentum') return undefined;
      // No referee → no initiative. The verdict can only be trusted when
      // the self-repair mod acknowledged the handshake.
      if (!refereePresent) return undefined;
      // Freshness: only verdicts emitted during THIS run may act.
      if (pendingVerdict.at < runStartedAt) {
        pendingVerdict = null;
        return undefined;
      }

      // Budget checks.
      if (injectionBlockedAction) {
        writeReceipt({
          ts: new Date().toISOString(),
          cycleId: pendingVerdict.cycleId,
          actionId: 'n/a',
          tier: 'green',
          title: 'initiative stop',
          why: 'injection signals aborted the prior action',
          scope: [], verify: [], rollback: '',
          outcome: 'stopped',
          stoppedBecause: 'injection_abort',
        });
        injectionBlockedAction = false;
        pendingVerdict = null;
        return undefined;
      }
      if (initiativeActions >= mandate.actions_after_done) {
        writeReceipt({
          ts: new Date().toISOString(),
          cycleId: pendingVerdict.cycleId,
          actionId: 'n/a',
          tier: 'green',
          title: 'initiative stop',
          why: 'actions-after-done budget exhausted',
          scope: [], verify: [], rollback: '',
          outcome: 'stopped',
          stoppedBecause: 'actions_after_done',
        });
        pendingVerdict = null;
        return undefined;
      }
      if (greenChain >= mandate.max_green_chain) {
        writeReceipt({
          ts: new Date().toISOString(),
          cycleId: pendingVerdict.cycleId,
          actionId: 'n/a',
          tier: 'green',
          title: 'initiative stop',
          why: 'max green chain reached',
          scope: [], verify: [], rollback: '',
          outcome: 'stopped',
          stoppedBecause: 'max_green_chain',
        });
        pendingVerdict = null;
        return undefined;
      }
      if (initiativeTurns > mandate.budget.turns) {
        writeReceipt({
          ts: new Date().toISOString(),
          cycleId: pendingVerdict.cycleId,
          actionId: 'n/a',
          tier: 'green',
          title: 'initiative stop',
          why: 'turn budget exhausted',
          scope: [], verify: [], rollback: '',
          outcome: 'stopped',
          stoppedBecause: 'budget',
        });
        pendingVerdict = null;
        return undefined;
      }

      // Build the backlog once per verified cycle. A stale backlog from a
      // prior cycle must never leak actions into this one.
      if (backlog.length === 0) buildBacklog();
      else backlog.forEach(a => { if (a.status === 'doing') a.status = 'queued'; });

      const action = nextGreen();
      if (!action) {
        // Nothing green left: quiet stop, proposals only.
        pendingVerdict = null;
        updateStatus();
        return undefined;
      }

      // Consume the verdict once.
      consumedCycleId = pendingVerdict.cycleId;
      const parentCycleId = pendingVerdict.cycleId;
      pendingVerdict = null;

      action.status = 'doing';
      currentActionId = action.id;
      greenChain++;
      initiativeActions++;
      logDecision(action.id, 'execute-green', action.why);

      // Open a child verification cycle in self-repair — and REQUIRE the
      // synchronous ack before continuing. No ack = no referee = stop.
      const childCycleId = `${parentCycleId}/${action.id}`;
      let ackSeen = false;
      const ackHandler = (raw: unknown) => {
        const a = (raw ?? {}) as Record<string, unknown>;
        if (a.cycleId === childCycleId) ackSeen = true;
      };
      const unsubscribe = cmd.events.on('self-repair/cycle-accepted', ackHandler);
      try {
        cmd.events.emit('self-repair/request-cycle', {
          cycleId: childCycleId,
          actionId: action.id,
          verify: action.verify,
        });
      } catch { /* best-effort */ }
      try { unsubscribe(); } catch { /* best-effort */ }
      if (!ackSeen) {
        currentActionId = null;
        writeReceipt({
          ts: new Date().toISOString(),
          cycleId: childCycleId,
          actionId: action.id,
          tier: action.tier,
          title: action.title,
          why: action.why,
          scope: action.scope,
          verify: action.verify,
          rollback: action.rollback,
          outcome: 'no-referee',
          stoppedBecause: 'self-repair did not acknowledge the cycle request',
        });
        updateStatus();
        return undefined;
      }

      writeReceipt({
        ts: new Date().toISOString(),
        cycleId: childCycleId,
        actionId: action.id,
        tier: action.tier,
        title: action.title,
        why: action.why,
        scope: action.scope,
        verify: action.verify,
        rollback: action.rollback,
        outcome: 'doing',
      });

      updateStatus();
      return { continue: true, reason: instructionBlock(action) };
    },
  });

  // ── User input resets initiative ────────────────────────────────────────
  cmd.hooks({
    transformInput: ({text}) => {
      if (text.trim().length === 0) return {action: 'continue'};
      // Real user input ends the momentum window (mandate before momentum).
      currentActionId = null;
      pendingVerdict = null;
      greenChain = 0;
      initiativeActions = 0;
      initiativeTurns = 0;
      injectionBlockedAction = false;
      backlog.length = 0;
      return {action: 'continue'};
    },
  });

  // ── Guardrails: red + scope blocks ──────────────────────────────────────
  cmd.hooks({
    beforeToolCall: async ({toolName, input}) => {
      const cmdText = extractCmd(input);
      const fp = typeof input === 'object' && input !== null &&
        'file_path' in (input as Record<string, unknown>)
        ? String((input as Record<string, unknown>).file_path) : '';

      // Red commands are always blocked while initiative is active.
      if ((currentActionId || effectiveMode() === 'momentum') && isRedCommand(cmdText)) {
        return {
          block: true,
          additionalContext: 'RED — this action requires explicit human approval. ' +
            'Autopilot can propose it but never execute it.',
        };
      }

      // Forbidden substrings from the mandate.
      const mandate = loadMandate();
      if (currentActionId && mandate.forbidden.length > 0 && isForbidden(cmdText, mandate.forbidden)) {
        return {
          block: true,
          additionalContext: `BLOCKED by mandate: command contains a forbidden pattern (${mandate.forbidden.join(', ')}).`,
        };
      }

      // Scope enforcement on writes during an initiative action.
      if (currentActionId && fp && (toolName === 'write_file' || toolName === 'edit_file')) {
        if (mandate.scope.length > 0 && !pathWithinScope(fp, mandate.scope, cmd.cwd)) {
          return {
            block: true,
            additionalContext: `BLOCKED: write outside mandate scope (${mandate.scope.join(', ')}).`,
          };
        }
        if (isSecretPath(fp)) {
          return {
            block: true,
            additionalContext: 'BLOCKED: secrets-adjacent path — never written by autopilot.',
          };
        }
      }
      return undefined;
    },
  });

  // ── Status footer ───────────────────────────────────────────────────────
  function updateStatus(): void {
    try {
      const mode = effectiveMode();
      if (mode === 'off' || mode === 'suggest') {
        cmd.ui.setStatus(`auto: idle · mode ${mode}`);
      } else if (pendingVerdict) {
        cmd.ui.setStatus(`auto: verified · backlog ${backlog.length} · waiting`);
      } else if (currentActionId) {
        cmd.ui.setStatus(`auto: doing ${currentActionId} · verify running`);
      } else {
        cmd.ui.setStatus(`auto: idle · mandate ${mode}`);
      }
    } catch { /* headless or pre-bind */ }
  }

  // ── End-of-run summary + receipts flush ─────────────────────────────────
  cmd.hooks({
    onRunEnd: async () => {
      if (currentActionId) {
        writeReceipt({
          ts: new Date().toISOString(),
          cycleId: consumedCycleId ?? 'unknown',
          actionId: currentActionId,
          tier: 'green',
          title: 'run ended during action',
          why: 'run ended before the child repair cycle finished',
          scope: [], verify: [], rollback: '',
          outcome: 'awaiting_repair',
        });
      }
      // Reset per-run initiative state; receipts remain the durable ledger.
      // Verdicts NEVER survive across runs — a hard-stop (max_turns/interrupt)
      // must not hand initiative to the next automated run.
      currentActionId = null;
      pendingVerdict = null;
      consumedCycleId = null;
      greenChain = 0;
      initiativeActions = 0;
      initiativeTurns = 0;
      injectionBlockedAction = false;
      backlog.length = 0;
      updateStatus();
    },
  });

  // ── Commands ────────────────────────────────────────────────────────────
  cmd.addCommand({
    name: 'autopilot',
    description: 'Autopilot status, mode, mandate, pause, resume',
    argumentHint: '[status|mode <off|suggest|momentum>|mandate <text>|pause|resume|why]',
    handler: ({args}) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || 'status').toLowerCase();

      if (sub === 'status') {
        const mandate = loadMandate();
        const lines = [
          `Autopilot: ${paused ? 'paused' : effectiveMode()}`,
          `Mandate: ${mandate.mode} · ${initiativeActions}/${mandate.actions_after_done} actions · budget ${mandate.budget.turns} turns`,
          `Scope: ${mandate.scope.length > 0 ? mandate.scope.join(', ') : '(repo)'}`,
          `Backlog: ${backlog.map(a => `${a.tier}:${a.id}(${a.status})`).join(' ') || 'empty'}`,
          `Receipts: ${receiptsPath}`,
        ];
        return {message: lines.join('\n')};
      }

      if (sub === 'mode') {
        const target = (parts[1] || '').toLowerCase();
        if (target !== 'off' && target !== 'suggest' && target !== 'momentum') {
          return {message: 'Usage: /autopilot mode off|suggest|momentum'};
        }
        const current = loadMandate();
        mandateOverride = {...current, mode: target};
        updateStatus();
        return {message: `Autopilot mode: ${target}`};
      }

      if (sub === 'mandate') {
        const text = args.trim().slice('mandate'.length).trim();
        if (!text) return {message: 'Usage: /autopilot mandate <text> — e.g. "3 green actions in src/auth"'};
        const current = loadMandate();
        const scopeMatch = text.match(/(?:in|within)\s+([^\s,]+(?:\/[^\s,]+)*)/i);
        mandateOverride = {
          ...current,
          mode: 'momentum',
          scope: scopeMatch ? [scopeMatch[1]] : current.scope,
        };
        updateStatus();
        return {message: `Mandate set: momentum in ${mandateOverride.scope.join(', ') || '(repo)'}.`};
      }

      if (sub === 'pause') {
        paused = true;
        updateStatus();
        return {message: 'Autopilot paused.'};
      }

      if (sub === 'resume') {
        paused = false;
        updateStatus();
        return {message: 'Autopilot resumed.'};
      }

      if (sub === 'why') {
        if (decisionLog.length === 0) return {message: 'No decisions recorded yet.'};
        const recent = decisionLog.slice(-5).map(d =>
          `${new Date(d.ts).toLocaleTimeString()} ${d.actionId}: ${d.decision} — ${d.reason}`);
        return {message: recent.join('\n')};
      }

      return {message: 'Usage: /autopilot status|mode|mandate|pause|resume|why'};
    },
  });

  cmd.addCommand({
    name: 'next',
    description: 'Show the autopilot backlog',
    handler: () => {
      if (backlog.length === 0) return {message: 'No backlog. It builds after a verified completion.'};
      const lines = backlog.map(a =>
        `${a.tier.toUpperCase()} ${a.id} [${a.status}] ${a.title}\n  why: ${a.why}`);
      return {message: lines.join('\n\n')};
    },
  });

  cmd.addCommand({
    name: 'next-do',
    description: 'Approve and queue a specific backlog action',
    argumentHint: '<action-id>',
    handler: ({args}) => {
      const id = args.trim();
      if (!id) return {message: 'Usage: /next-do <action-id>'};
      const action = backlog.find(a => a.id === id);
      if (!action) return {message: `No action "${id}" in the backlog.`};
      if (action.tier === 'red') {
        return {message: `"${id}" is red — proposal only, cannot be queued.`};
      }
      action.status = 'queued';
      return {message: `Queued ${id}: ${action.title}`};
    },
  });

  cmd.addCommand({
    name: 'next-dismiss',
    description: 'Remove an action from the backlog',
    argumentHint: '<action-id>',
    handler: ({args}) => {
      const id = args.trim();
      if (!id) return {message: 'Usage: /next-dismiss <action-id>'};
      const idx = backlog.findIndex(a => a.id === id);
      if (idx < 0) return {message: `No action "${id}" in the backlog.`};
      backlog.splice(idx, 1);
      return {message: `Dismissed ${id}.`};
    },
  });

  // ── Tool: propose_next_actions ──────────────────────────────────────────
  cmd.addTool({
    schema: {
      name: 'propose_next_actions',
      description: 'List the current autopilot backlog with tiers (green/yellow/red), status, and rationale. Read-only.',
      input_schema: {
        type: 'object',
        properties: {
          reason: {type: 'string', description: 'Why the agent is asking for next actions.'},
          limit: {type: 'number', description: 'Max items to return (default 10).'},
        },
        required: [],
      },
    },
    readOnly: true,
    run: async ({input}) => {
      const limit = typeof input.limit === 'number' ? input.limit : 10;
      if (backlog.length === 0) {
        return {ok: true, content: [{type: 'text', text: 'Backlog empty. It builds after a verified completion verdict.'}]};
      }
      const text = backlog.slice(0, limit)
        .map(a => `${a.tier.toUpperCase()} ${a.id} [${a.status}] ${a.title}\n  why: ${a.why}\n  verify: ${a.verify.join('; ') || 'n/a'}`)
        .join('\n\n');
      return {ok: true, content: [{type: 'text', text}]};
    },
  });

  // ── Renderer: autopilot/summary ─────────────────────────────────────────
  try {
    cmd.addRenderer('autopilot/summary', (data: any) => {
      const lines: string[] = ['Autopilot summary'];
      const actions = Array.isArray(data?.actions) ? data.actions : [];
      for (const a of actions) {
        lines.push(`${String(a?.tier || '?').toUpperCase()} ${String(a?.title || '')} — ${String(a?.outcome || '')}`);
      }
      if (data?.stoppedBecause) lines.push(`Stopped because: ${String(data.stoppedBecause)}`);
      return lines;
    });
  } catch { /* renderer registration can fail in older versions */ }

  // ── Initialize ──────────────────────────────────────────────────────────
  try { cmd.ui.setStatus('auto: idle'); } catch { /* headless or pre-bind */ }
}
