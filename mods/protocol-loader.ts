import type {ModApi} from '@commandcode/harness';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Protocol Loader — load .agents/protocols/*.md on demand, like skills ────
//
// The templates kit's protocols are portable text files at `.agents/protocols/`
// with frontmatter `description` = "Run when …". On harnesses without native
// protocol support they are armed by AGENTS.md rules + wrapper skills (pointer
// shims that fire by description). This mod is the MECHANICAL Command Code
// layer: it discovers the same `.agents/protocols/` tree and activates a
// protocol on demand the way the harness activates skills —
//
//   1. DISCOVER — scan `.agents/protocols/*.md` in cwd and ancestor workspaces.
//   2. MATCH — when a typed prompt arrives, score each protocol's frontmatter
//      trigger description against the prompt (significant-token overlap).
//   3. ACTIVATE — the best match above the threshold loads immediately (like a
//      skill firing on its description); `/protocol <name>` loads explicitly
//      (the `/name` analog of skill invocation).
//   4. INJECT — active protocols ride the message tail via transformContext on
//      every round, so they stay in context after activation (same ephemeral
//      projection the harness uses for on-demand context). NEVER appendSystemPrompt:
//      the system prompt stays byte-stable and provider prefix caching is
//      untouched (see the kit's cache discipline).
//
// Wrappers become optional on Command Code with this mod installed; the AGENTS.md
// "Run when …" rule remains the canonical wiring for harnesses without it.

interface Protocol {
  name: string;
  description: string;
  path: string;
  text: string;
}

const STOPWORDS = new Set([
  'a','an','the','and','or','of','to','for','with','in','on','at','by','from','per',
  'its','it','is','are','was','were','be','been','being','may','might','will','would',
  'can','could','should','must','you','your','my','this','that','these','those','what',
  'which','who','whom','where','how','not','no','nor','so','if','then','than','too',
  'very','just','as','but','when','before','after','whenever','run','runs','executes',
  'turn','turns','work','works','working','session','sessions','user','prompt','prompts',
  'gate','gates','protocol','protocols','needs','produces','keeps','keeping','worth',
  'learned','arrives','ends','starts','begin','begins','while','during','next','last',
  'may','might','once','over','into','about','also','under','without','within',
]);

function parseFrontmatter(text: string): {name: string; description: string} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) throw new Error('protocol has no frontmatter');
  const field = (name: string): string | null => {
    const found = match[1].match(new RegExp(`^${name}:\\s*"?([^"\\n]+?)"?\\s*$`, 'm'));
    return found ? found[1].trim() : null;
  };
  const name = field('name');
  const description = field('description');
  if (!name || !description) throw new Error('protocol frontmatter must carry name + description');
  return {name, description};
}

function significantTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function scoreMatch(description: string, input: string): number {
  if (!description || !input) return 0;
  const trigger = description.split('. ')[0] ?? description;
  const triggerTokens = significantTokens(trigger);
  if (triggerTokens.size === 0) return 0;
  const inputTokens = significantTokens(input);
  let hits = 0;
  for (const token of triggerTokens) {
    if (inputTokens.has(token)) hits += 1;
  }
  return hits;
}

export default function (cmd: ModApi): void {
  let protocols: Protocol[] = [];
  const active = new Map<string, Protocol>(); // name -> loaded protocol

  // ── Flags ──────────────────────────────────────────────────────────────────
  cmd.addFlag('pl-autoload', {
    type: 'boolean',
    default: true,
    description: 'Automatically load a protocol when its trigger matches a typed prompt',
  });
  cmd.addFlag('pl-threshold', {
    type: 'string',
    default: '2',
    description: 'Minimum significant trigger-token matches required to auto-load',
  });
  cmd.addFlag('pl-disabled', {
    type: 'string',
    default: '',
    description: 'Comma-separated protocol names never auto-loaded (explicit /protocol still works)',
  });
  cmd.addFlag('pl-status', {
    type: 'boolean',
    default: true,
    description: 'Show the active-protocols footer status',
  });

  function boolFlag(name: string, fallback: boolean): boolean {
    const v = cmd.getFlag(name);
    if (typeof v === 'boolean') return v;
    const s = String(v).toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
    return fallback;
  }

  function threshold(): number {
    const n = Number(cmd.getFlag('pl-threshold') ?? 2);
    return Number.isFinite(n) && n > 0 ? n : 2;
  }

  function disabledNames(): Set<string> {
    const raw = String(cmd.getFlag('pl-disabled') ?? '');
    return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
  }

  function refreshStatus(): void {
    if (!boolFlag('pl-status', true)) return;
    const names = Array.from(active.keys()).sort();
    const text = names.length > 0 ? `protocols: ${names.join(', ')}` : null;
    try { cmd.ui.setStatus(text); } catch { /* headless or pre-bind */ }
    if (names.length > 0) {
      try { cmd.ui.notify(`[protocols] loaded: ${names.join(', ')}`); } catch { /* TUI-only */ }
    }
  }

  // ── Discovery: cwd + ancestor workspaces, project wins on name clash ─────
  function discover(): void {
    const found = new Map<string, Protocol>();
    const roots: string[] = [cmd.cwd];
    let cursor = cmd.cwd;
    for (let guard = 0; guard < 12 && path.dirname(cursor) !== cursor; guard += 1) {
      cursor = path.dirname(cursor);
      roots.push(cursor);
    }
    for (const root of roots) {
      const dir = path.join(root, '.agents', 'protocols');
      let entries: string[] = [];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const entry of entries.sort()) {
        if (!entry.endsWith('.md')) continue;
        const filePath = path.join(dir, entry);
        let text = '';
        try { text = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
        try {
          const fm = parseFrontmatter(text);
          found.set(fm.name, {name: fm.name, description: fm.description, path: filePath, text});
        } catch {
          // Malformed protocol: surface in /protocols, never crash.
          found.set(entry.replace(/\.md$/, ''), {
            name: entry.replace(/\.md$/, ''),
            description: '(unparsable frontmatter)',
            path: filePath,
            text,
          });
        }
      }
    }
    protocols = Array.from(found.values());
  }

  function activate(name: string): boolean {
    const protocol = protocols.find(p => p.name === name);
    if (!protocol) return false;
    if (!active.has(name)) {
      active.set(name, protocol);
      refreshStatus();
    }
    return true;
  }

  function inject(protocol: Protocol): string {
    return [
      `[protocol] ${protocol.name} is ACTIVE for this session (loaded ${protocol.path}).`,
      'Follow it exactly, top to bottom — preconditions, per-step Expect/On-failure checks,',
      'completion criteria, and its Abort/Rollback and Escalation paths. Deviation is an error.',
      '',
      protocol.text.trim(),
    ].join('\n');
  }

  // ── Trigger evaluation: like a skill firing on its description ───────────
  cmd.hooks({
    transformInput: ({text}) => {
      if (!text || !boolFlag('pl-autoload', true)) return undefined;
      discover();
      const disabled = disabledNames();
      let best: {protocol: Protocol; score: number} | null = null;
      for (const protocol of protocols) {
        if (active.has(protocol.name)) continue;
        if (disabled.has(protocol.name)) continue;
        const score = scoreMatch(protocol.description, text);
        if ((!best || score > best.score) && score >= threshold()) {
          best = {protocol, score};
        }
      }
      if (best) {
        const protocol = best.protocol;
        active.set(protocol.name, protocol);
        refreshStatus();
        try {
          cmd.ui.notify(`[protocols] trigger matched "${protocol.name}" (${best.score} terms)`);
        } catch { /* TUI-only */ }
      }
      return undefined;
    },

    // ── Injection: active protocols ride the message tail every round ──────
    // Tail-only by design: the provider's prompt-prefix cache keys on the
    // system prompt + message prefix, so appending at the end never busts it.
    transformContext: ({messages}) => {
      if (active.size === 0) return messages;
      const blocks: Protocol[] = Array.from(active.values()).sort((a, b) => a.name.localeCompare(b.name));
      if (blocks.length === 0) return messages;
      return [
        ...messages,
        ...blocks.map(protocol => ({
          role: 'user',
          // Array content blocks — the wire projection filters message.content
          // unguarded; string content crashes the run.
          content: [{type: 'text', text: inject(protocol)}],
        }) as never),
      ];
    },

    onSessionStart: () => {
      active.clear();
      protocols = [];
      refreshStatus();
    },
  });

  // ── Slash commands ─────────────────────────────────────────────────────────
  cmd.addCommand({
    name: 'protocol',
    description: 'Load a protocol by name into this session (e.g. /protocol completion-gate)',
    argumentHint: '<name>',
    handler: ({args}) => {
      const name = String(args ?? '').trim().replace(/\.md$/, '');
      if (!name) {
        return {message: 'Usage: /protocol <name>. Run /protocols to list available protocols.'};
      }
      discover();
      if (activate(name)) {
        return {message: `Protocol "${name}" loaded for this session (explicit /protocol load).`};
      }
      return {message: `No protocol named "${name}" found in .agents/protocols/. Run /protocols to list them.`};
    },
  });

  cmd.addCommand({
    name: 'protocols',
    description: 'List discovered protocols with their triggers and load state',
    handler: () => {
      discover();
      if (protocols.length === 0) return {message: 'No .agents/protocols/ found in this project or any ancestor workspace.'};
      const lines = protocols.map((p) => {
        const state = active.has(p.name) ? '● active' : '○ idle';
        return `${state}  ${p.name}\n      ${p.description}`;
      });
      return {message: `Discovered ${protocols.length} protocol(s):\n${lines.join('\n')}`};
    },
  });

  cmd.addCommand({
    name: 'protocol-clear',
    description: 'Deactivate all loaded protocols for this session',
    handler: () => {
      const count = active.size;
      active.clear();
      refreshStatus();
      return {message: count > 0 ? `Deactivated ${count} protocol(s).` : 'No protocols were active.'};
    },
  });

  // Initial discovery (may be pre-bind; best-effort)
  try { discover(); } catch { /* ok */ }
}