import type {ModApi} from '@commandcode/harness';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Error Tracker — suite-wide error observability ───────────────────────────
//
// Pure observer of the harness error events: mod_error (per mod + hook),
// tool_errored (per tool), run_error, api_retry, and interrupted. It keeps
// per-session aggregates, shows a footer badge when anything errored, and
// appends one JSONL line per error to ~/.commandcode/error-tracker.jsonl so
// crashes survive the session that produced them.
//
// It registers NO prompt hooks (no appendSystemPrompt / transformContext), so
// it can never affect the runs it watches — same discipline as cache-tracker.
// Locked appends serialize parallel sessions; errors are best-effort and never
// crash the host.

const LEDGER_PATH = path.join(os.homedir(), '.commandcode', 'error-tracker.jsonl');

interface SessionErrorTotals {
  modErrors: Record<string, Record<string, number>>; // modId -> hook -> count
  toolErrors: Record<string, number>;
  retries: number;
  runErrors: number;
  interrupted: number;
  requests: number;
  runs: number;
}

function zeroTotals(): SessionErrorTotals {
  return {modErrors: {}, toolErrors: {}, retries: 0, runErrors: 0, interrupted: 0, requests: 0, runs: 0};
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

// Collapse newlines, cap length, and mask anything that looks like a long
// token/key (so an error dump never leaks a secret into the ledger).
function redact(text: unknown, max = 400): string {
  const flat = str(text).replace(/\s+/g, ' ').trim();
  const cut = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  return cut.replace(/\b[A-Za-z0-9+/=]{48,}\b/g, '[redacted]');
}

function numOf(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── Ledger: read back error history for /errors ─────────────────────────────
// Best-effort: a corrupt or unreadable ledger degrades to "no history" rather
// than crashing the report.
function loadLedger(): Record<string, unknown>[] {
  try {
    if (!fs.existsSync(LEDGER_PATH)) return [];
    return fs.readFileSync(LEDGER_PATH, 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

export default function (cmd: ModApi): void {
  let totals: SessionErrorTotals = zeroTotals();
  // tool_queued carries the ORIGINAL toolName per call; tool_errored does not,
  // so attribute failures via the call id.
  const toolNameByCall = new Map<string, string>();

  function boolFlag(name: string, fallback: boolean): boolean {
    const v = cmd.getFlag(name);
    if (typeof v === 'boolean') return v;
    const s = String(v).toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
    return fallback;
  }

  function errorCount(): number {
    const modErrors = Object.values(totals.modErrors)
      .flatMap(hooks => Object.values(hooks))
      .reduce((a, b) => a + b, 0);
    const toolErrors = Object.values(totals.toolErrors).reduce((a, b) => a + b, 0);
    return modErrors + toolErrors + totals.retries + totals.runErrors + totals.interrupted;
  }

  cmd.addFlag('et-status', {
    type: 'boolean',
    default: true,
    description: 'Show the error-count footer status when any error occurred',
  });
  cmd.addFlag('et-limit', {
    type: 'string',
    default: '5000',
    description: 'Maximum ledger lines kept in ~/.commandcode/error-tracker.jsonl',
  });

  function refreshStatus(): void {
    if (!boolFlag('et-status', true)) return;
    const count = errorCount();
    const modCount = Object.keys(totals.modErrors).length;
    const text = count > 0
      ? `err ${count}${modCount > 0 ? ` in ${modCount} mod(s)` : ''} · ${totals.runs} run(s)`
      : null;
    try { cmd.ui.setStatus(text); } catch { /* headless or pre-bind */ }
  }

  function retainLimit(): void {
    try {
      const limit = Math.max(100, Math.floor(Number(cmd.getFlag('et-limit') ?? 5000)));
      if (!fs.existsSync(LEDGER_PATH)) return;
      const lines = fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(l => l.trim());
      if (lines.length > limit) {
        fs.writeFileSync(LEDGER_PATH, lines.slice(lines.length - limit).join('\n') + '\n');
      }
    } catch { /* best-effort */ }
  }

  // Locked append: serializes parallel sessions writing the same JSONL.
  function appendLine(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(LEDGER_PATH), {recursive: true});
      const lock = `${LEDGER_PATH}.lock`;
      const tmp = `${lock}.tmp-${process.pid}`;
      const started = Date.now();
      while (true) {
        try {
          fs.mkdirSync(tmp, {recursive: false});
          try {
            fs.renameSync(tmp, lock);
          } catch {
            fs.rmSync(tmp, {recursive: true, force: true});
            if (Date.now() - started > 10000) return; // best-effort, skip
            const until = Date.now() + 40;
            while (Date.now() < until) { /* spin */ }
            continue;
          }
        } catch {
          return;
        }
        try {
          fs.appendFileSync(LEDGER_PATH, `${JSON.stringify(entry)}\n`);
        } finally {
          try { fs.rmSync(lock, {recursive: true, force: true}); } catch { /* stale later */ }
        }
        return;
      }
    } catch { /* errors are best-effort */ }
  }

  function record(kind: string, fields: Record<string, unknown>): void {
    appendLine({
      ts: new Date().toISOString(),
      project: path.basename(cmd.cwd),
      kind,
      ...fields,
    });
    retainLimit();
    refreshStatus();
  }

  // ── Observers: harness error events ─────────────────────────────────────
  cmd.on('mod_error', event => {
    if (event.type !== 'mod_error') return;
    const mod = str((event as Record<string, unknown>).modId, 'unknown');
    const hook = str((event as Record<string, unknown>).hook, 'unknown');
    totals.modErrors[mod] = totals.modErrors[mod] ?? {};
    totals.modErrors[mod][hook] = (totals.modErrors[mod][hook] ?? 0) + 1;
    record('mod_error', {mod, hook, error: redact((event as Record<string, unknown>).error)});
  });

  cmd.on('tool_queued', event => {
    if (event.type !== 'tool_queued') return;
    const callId = str((event as Record<string, unknown>).toolCallId);
    const tool = str((event as Record<string, unknown>).toolName);
    if (callId) toolNameByCall.set(callId, tool || 'unknown');
  });

  cmd.on('tool_errored', event => {
    if (event.type !== 'tool_errored') return;
    const callId = str((event as Record<string, unknown>).toolCallId);
    const tool = str((event as Record<string, unknown>).toolName) || (callId ? toolNameByCall.get(callId) : '') || 'unknown';
    if (callId) toolNameByCall.delete(callId);
    totals.toolErrors[tool] = (totals.toolErrors[tool] ?? 0) + 1;
    record('tool_errored', {tool, error: redact((event as Record<string, unknown>).error)});
  });

  cmd.on('run_error', event => {
    if (event.type !== 'run_error') return;
    totals.runErrors += 1;
    record('run_error', {error: redact((event as Record<string, unknown>).error)});
  });

  cmd.on('api_retry', event => {
    if (event.type !== 'api_retry') return;
    totals.retries += 1;
    record('api_retry', {
      attempt: numOf((event as Record<string, unknown>).attempt),
      delayMs: numOf((event as Record<string, unknown>).delayMs),
      error: redact((event as Record<string, unknown>).error),
    });
  });

  cmd.on('interrupted', () => {
    totals.interrupted += 1;
    record('interrupted', {});
  });

  cmd.on('model_request_end', event => {
    if (event.type === 'model_request_end') totals.requests += 1;
  });

  cmd.on('run_start', () => {
    totals.runs += 1;
  });

  // ── Lifecycle: flush status at run end (session tallies persist for /errors) ─
  cmd.hooks({
    onRunEnd: () => {
      refreshStatus();
    },
  });

  // ── Slash commands ──────────────────────────────────────────────────────
  cmd.addCommand({
    name: 'errors',
    description: 'Show error tracking: this session, per mod/hook, recent ledger history',
    handler: () => {
      const lines: string[] = [];
      const count = errorCount();
      lines.push(count > 0
        ? `Session: ${count} error event(s) across ${totals.runs} run(s), ${totals.requests} request(s)` +
          (totals.requests > 0 ? ` (rate ${((count / totals.requests) * 100).toFixed(1)}%)` : '')
        : 'Session: no error events tracked yet.');
      const modEntries = Object.entries(totals.modErrors);
      if (modEntries.length > 0) {
        lines.push('mod_error by mod → hook:');
        for (const [mod, hooks] of modEntries.sort()) {
          lines.push(`  ${mod}: ${Object.entries(hooks).map(([h, n]) => `${h}×${n}`).join(', ')}`);
        }
      }
      const toolEntries = Object.entries(totals.toolErrors);
      if (toolEntries.length > 0) {
        lines.push(`tool_errored: ${toolEntries.map(([t, n]) => `${t}×${n}`).join(', ')}`);
      }
      if (totals.retries > 0 || totals.runErrors > 0 || totals.interrupted > 0) {
        lines.push(`api_retry: ${totals.retries} · run_error: ${totals.runErrors} · interrupted: ${totals.interrupted}`);
      }
      const history = loadLedger().slice(-10).reverse();
      if (history.length > 0) {
        lines.push('Recent ledger (last 10):');
        for (const l of history) {
          const ts = String(l.ts ?? '').slice(11, 19);
          const kind = String(l.kind ?? '?');
          const scope = str(l.mod) || str(l.tool) || '';
          const error = str(l.error, '').slice(0, 90);
          lines.push(`  ${ts}  ${kind}${scope ? ` ${scope}` : ''}${error ? ` — ${error}` : ''}`);
        }
      } else {
        lines.push('No history yet (stored in ~/.commandcode/error-tracker.jsonl).');
      }
      return {message: lines.join('\n')};
    },
  });

  cmd.addCommand({
    name: 'errors-clear',
    description: 'Delete the error ledger and reset this session\u2019s tallies',
    handler: () => {
      try {
        if (fs.existsSync(LEDGER_PATH)) fs.rmSync(LEDGER_PATH);
      } catch { /* ok */ }
      totals = zeroTotals();
      refreshStatus();
      return {message: 'Error ledger cleared; tracking restarts with this session.'};
    },
  });

  // Initial status (safe in case UI isn't bound yet)
  try { refreshStatus(); } catch { /* headless or pre-bind */ }
}