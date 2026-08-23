import type {ModApi} from '@commandcode/harness';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Cache Tracker — prompt-cache hit-rate observability ─────────────────────
//
// Pure observer of model_request_end usage. The harness threads
// {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens} from the
// provider's inputTokenDetails on every request; this mod accumulates them
// per session, shows a live footer status, and appends one JSONL line per
// session to ~/.commandcode/cache-tracker.jsonl.
//
// Hit rate = cacheRead / (input + cacheRead + cacheWrite) — the harness
// treats those three as disjoint buckets (see its own total-token math).
//
// It registers NO prompt hooks (no appendSystemPrompt / transformContext),
// so it can never affect the cache it measures. The footer status is
// TUI-only and never reaches the model.

interface SessionTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

const STATS_PATH = path.join(os.homedir(), '.commandcode', 'cache-tracker.jsonl');

function zeroTotals(): SessionTotals {
  return {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0};
}

function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function hitRate(t: SessionTotals): number {
  const denom = t.input + t.cacheRead + t.cacheWrite;
  return denom > 0 ? t.cacheRead / denom : 0;
}

// A provider that never reports inputTokenDetails yields all-zero cache
// fields — distinguish "no breakdown" from a genuine 0% hit rate.
function hasBreakdown(t: SessionTotals): boolean {
  return t.cacheRead > 0 || t.cacheWrite > 0;
}

export default function (cmd: ModApi): void {
  let totals: SessionTotals = zeroTotals();
  let lastModel: string = '';

  function readLines(): Record<string, unknown>[] {
    try {
      if (!fs.existsSync(STATS_PATH)) return [];
      return fs.readFileSync(STATS_PATH, 'utf-8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l));
    } catch {
      return [];
    }
  }

  function appendLine(entry: Record<string, unknown>): void {
    // Parallel sessions append to the same JSONL; each line is one write,
    // but two writers racing the same append can interleave bytes on some
    // filesystems. Serialize via a lock dir next to the file.
    try {
      fs.mkdirSync(path.dirname(STATS_PATH), {recursive: true});
      const lock = STATS_PATH + '.lock';
      const tmp = lock + '.tmp-' + process.pid;
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
          fs.appendFileSync(STATS_PATH, JSON.stringify(entry) + '\n');
        } finally {
          try { fs.rmSync(lock, {recursive: true, force: true}); } catch { /* stale later */ }
        }
        return;
      }
    } catch { /* stats are best-effort */ }
  }

  function statusText(): string {
    if (totals.requests === 0) return '';
    const denom = totals.input + totals.cacheRead + totals.cacheWrite;
    if (!hasBreakdown(totals)) {
      return `cache: — (provider reports no cache breakdown)`;
    }
    const pct = Math.round(hitRate(totals) * 100);
    return `cache: ${pct}% hit · ${fmtTokens(totals.cacheRead)}/${fmtTokens(denom)} in`;
  }

  function refreshStatus(): void {
    if (!boolFlag('ct-status', true)) return;
    const text = statusText();
    cmd.ui.setStatus(text || null);
  }

  function boolFlag(name: string, fallback: boolean): boolean {
    const v = cmd.getFlag(name);
    if (typeof v === 'boolean') return v;
    const s = String(v).toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
    return fallback;
  }

  cmd.addFlag('ct-status', {
    type: 'boolean',
    default: true,
    description: 'Show the live cache hit-rate footer status',
  });

  // ── Observer: accumulate every inference call's usage ──────────────────
  cmd.on('model_request_end', event => {
    if (event.type !== 'model_request_end') return;
    const usage = (event as Record<string, unknown>).usage as
      | Record<string, unknown> | undefined;
    if (!usage) return;
    totals.input += num(usage.inputTokens);
    totals.output += num(usage.outputTokens);
    totals.cacheRead += num(usage.cacheReadTokens);
    totals.cacheWrite += num(usage.cacheWriteTokens);
    totals.requests += 1;
    if (typeof (event as Record<string, unknown>).model === 'string') {
      lastModel = String((event as Record<string, unknown>).model);
    }
    refreshStatus();
  });

  function num(v: unknown): number {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // ── Lifecycle: accumulate per run, flush one JSONL line per run ────────
  // onRunEnd fires in BOTH TUI and headless print mode (core loop, awaited,
  // before run_end); onSessionEnd does not reliably fire in headless
  // one-shot processes, so the flush lives here.
  cmd.hooks({
    onSessionStart: () => {
      totals = zeroTotals();
      refreshStatus();
    },
    onRunEnd: () => {
      if (totals.requests > 0) {
        appendLine({
          ts: new Date().toISOString(),
          project: path.basename(cmd.cwd),
          model: lastModel,
          requests: totals.requests,
          input: totals.input,
          output: totals.output,
          cacheRead: totals.cacheRead,
          cacheWrite: totals.cacheWrite,
          hitRate: Number(hitRate(totals).toFixed(4)),
        });
      }
      totals = zeroTotals();
      refreshStatus();
    },
    onSessionEnd: () => {
      cmd.ui.setStatus(null);
      totals = zeroTotals();
    },
  });

  // ── Slash commands ──────────────────────────────────────────────────────
  cmd.addCommand({
    name: 'cache',
    description: 'Show the prompt-cache hit rate: this session, all-time, recent sessions',
    handler: () => {
      const lines: string[] = [];

      if (totals.requests > 0) {
        const denom = totals.input + totals.cacheRead + totals.cacheWrite;
        lines.push(
          hasBreakdown(totals)
            ? `Session: ${totals.requests} requests · ${fmtTokens(denom)} in (${fmtTokens(totals.cacheRead)} cache read, ${fmtTokens(totals.cacheWrite)} cache write) · ${Math.round(hitRate(totals) * 100)}% hit`
            : `Session: ${totals.requests} requests · ${fmtTokens(totals.input)} in · provider reports no cache breakdown`,
        );
      } else {
        lines.push('Session: no model requests yet.');
      }

      const history = readLines();
      if (history.length > 0) {
        const sum = history.reduce((acc, l) => {
          acc.input += Number(l.input ?? 0);
          acc.cacheRead += Number(l.cacheRead ?? 0);
          acc.cacheWrite += Number(l.cacheWrite ?? 0);
          acc.requests += Number(l.requests ?? 0);
          return acc;
        }, zeroTotals());
        const denomAll = sum.input + sum.cacheRead + sum.cacheWrite;
        lines.push(
          hasBreakdown(sum)
            ? `All-time (${history.length} sessions): ${sum.requests} requests · ${fmtTokens(denomAll)} in · ${Math.round(hitRate(sum) * 100)}% hit`
            : `All-time (${history.length} sessions): ${sum.requests} requests · ${fmtTokens(sum.input)} in · no cache breakdown reported`,
        );
        lines.push('Recent sessions:');
        for (const l of history.slice(-5).reverse()) {
          const pct = Math.round(Number(l.hitRate ?? 0) * 100);
          const proj = String(l.project ?? '?');
          const ts = String(l.ts ?? '').slice(0, 10);
          lines.push(`  ${ts}  ${proj}  ${pct}% · ${fmtTokens(Number(l.input ?? 0))} in`);
        }
      } else {
        lines.push('No session history yet (stored in ~/.commandcode/cache-tracker.jsonl).');
      }

      return {message: lines.join('\n')};
    },
  });

  cmd.addCommand({
    name: 'cache-reset',
    description: 'Delete all recorded cache history and start fresh',
    handler: () => {
      try {
        if (fs.existsSync(STATS_PATH)) fs.rmSync(STATS_PATH);
      } catch { /* ok */ }
      totals = zeroTotals();
      refreshStatus();
      return {message: 'Cache history cleared. Tracking restarts with this session.'};
    },
  });

  // Initial status (safe in case UI isn't bound yet)
  try { refreshStatus(); } catch { /* headless or pre-bind */ }
}
