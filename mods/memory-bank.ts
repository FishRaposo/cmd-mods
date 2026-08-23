import type {ModApi} from '@commandcode/harness';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Memory Bank — durable, gated project memory ─────────────────────────────
//
// Memory-bank owns a layered, file-based store at <project>/.agents/memory/
// following the shared-memory templates convention:
//
//   L1-EVENTS.md   — append-only event log, newest first, evt-NNNN ids
//   L1-ARCHIVE.md  — compaction target (verbatim moves)
//   L2-REGISTRY.md — four fixed tables of POINTERS to source-of-truth
//   L3-LESSONS/    — one lesson per file with frontmatter
//   episodes.jsonl — verified-episode ledger (private feed + audit trail)
//
// North star:
//   No write-bar pass, no memory.
//   No verification, no automatic write.
//   Reality wins over memory.
//
// taste-compiler (learning) is untouched: it distills personal patterns
// from raw episodes; memory-bank remembers verified project facts. The
// write-bar is the difference: only verified completions (final
// self-repair verdicts) and explicit /bank remember writes enter here.

// ── Constants ───────────────────────────────────────────────────────────────

const L1_CAP = 30;
const L1_ENTRY_RE = /^### (\d{4}-\d{2}-\d{2}) — (evt-(\d{4})) — .+$/;
const L3_FRONTMATTER_RE = /^---\s*\ntype: lesson\s*\ndomain: (\S+)\s*\ndate: (\d{4}-\d{2}-\d{2})\s*\nconfidence: (high|medium|low)\s*\nsource: (.+)\s*\n---/;

const L2_SECTIONS = ['## Systems / Repos', '## People', '## Skills / Tools', '## Decisions'];

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'are',
  'was', 'not', 'but', 'you', 'all', 'can', 'had', 'her', 'was', 'one',
  'our', 'out', 'has', 'been', 'when', 'your', 'how', 'will', 'each',
  'about', 'which', 'their', 'said', 'would', 'make', 'like', 'just',
  'into', 'them', 'than', 'then', 'its', 'over', 'also', 'after',
  'what', 'only', 'other', 'more', 'some', 'could', 'these', 'very',
]);

interface VerdictEvent {
  version: number;
  cycleId: string;
  complete: boolean;
  final: boolean;
  evidence: string[];
  files: string[];
  at: number;
}

interface EpisodeLine {
  line: number;
  data: Record<string, unknown>;
}

interface LessonMeta {
  file: string;
  domain: string;
  date: string;
  confidence: 'high' | 'medium' | 'low';
  source: string;
  title: string;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_.,;:!?()[\]{}"'`~@#$%^&*+=<>/\\|]+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 20);
}

function scoreMatch(queryKeys: string[], keys: string[]): number {
  let overlap = 0;
  for (const qk of queryKeys) {
    if (keys.includes(qk)) overlap++;
    else {
      for (const k of keys) {
        if (k.includes(qk) || qk.includes(k)) { overlap += 0.5; break; }
      }
    }
  }
  return queryKeys.length > 0 ? overlap / queryKeys.length : 0;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'note';
}

// ── Store contract text (installed with the store) ─────────────────────────

const STORE_README = `# Shared Memory

**Purpose:** shared markdown memory layer for AI agents — the unifying layer across harnesses.
**Principle:** no duplicate truth, no cached context, no stale dashboards.

This store is maintained by the memory-bank mod and follows the shared-memory
templates convention. The mod enforces the write-bar and formats mechanically;
the \`memory-maintenance\` judgment steps run as an automated sweep (\`/bank maintain\`).

## Read Order

1. \`README.md\` — this file. Understand the contract.
2. \`L1-EVENTS.md\` — recent significant events and decisions.
3. \`L2-REGISTRY.md\` — durable entities and pointers to source-of-truth.
4. \`L3-LESSONS/*.md\` — reusable cross-domain lessons.

## Write Rules

- **Significant change or decision** → prepend to \`L1-EVENTS.md\` (newest first)
- **Durable entity appears, updates, or retires** → modify \`L2-REGISTRY.md\`
- **Cross-domain insight** → add \`L3-LESSONS/<topic>.md\`
- **Everything else** → do not write it

## Trust Rules

- A memory is a lead, not a fact.
- Memories lose to: live repo state, tests, docs, plans, \`AGENTS.md\`.
- Any agent relying on a memory verifies it before acting.
- If a memory graduates, it becomes a rule, skill, protocol, or doc — and is removed from here.

## What Belongs Here

- Significant durable events and decisions
- Registry entries for stable systems, repos, skills, people
- Cross-domain lessons too broad for one project or skill
- Pointers to source-of-truth (not the truth itself)

## What Does Not Belong Here

- Current task progress
- Raw cron outputs or transient logs
- Commit SHAs, PR numbers, deploy statuses
- Secrets, tokens, API keys
- Duplicated operator backlog or project docs
- Cached context summaries
`;

const L1_TEMPLATE = `# L1 — Events

Append-only log of significant events and decisions.

**Rule:** Every entry gets a timestamp and a unique ID. Never edit or delete past entries.

---

## Event Log

<!-- Newest first -->
`;

const L2_TEMPLATE = `# L2 — Registry

Durable entity registry. Pointer to source-of-truth, not the truth itself.

**Rule:** If an entity moves or changes, update the pointer. Remove only when the entity is permanently retired.

---

## Systems / Repos

| Name | Type | URL | Status | Notes |
|------|------|-----|--------|-------|

## People

| Name | Role | Contact | Notes |
|------|------|---------|-------|

## Skills / Tools

| Name | Type | Source | Notes |
|------|------|--------|-------|

## Decisions

| ID | Label | Source | Status | Last checked |
|----|-------|--------|--------|--------------|
`;

// ── Mod ──────────────────────────────────────────────────────────────────────

export default function (cmd: ModApi): void {
  // ── Flags ───────────────────────────────────────────────────────────────
  cmd.addFlag('mb-recall-threshold', {type: 'string', default: '0.35',
    description: 'Minimum match score to inject recall context'});
  cmd.addFlag('mb-max-recall-items', {type: 'string', default: '3',
    description: 'Max recall leads injected per message'});
  cmd.addFlag('mb-digest-lines', {type: 'string', default: '3',
    description: 'L1 events shown in the session-start digest'});
  cmd.addFlag('mb-graduate-after', {type: 'string', default: '3',
    description: 'Times a lesson must be recalled before it auto-graduates into a learn-loop-managed skill'});
  cmd.addFlag('mb-auto-graduate', {type: 'boolean', default: true,
    description: 'Automatically hand stable lessons to learn-loop as skills once they cross mb-graduate-after'});

  function numFlag(name: string, fallback: number, min: number = 0): number {
    const v = cmd.getFlag(name);
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    if (!Number.isFinite(n) || n < min) return fallback;
    return n;
  }

  function boolFlag(name: string, fallback: boolean): boolean {
    const v = cmd.getFlag(name);
    if (typeof v === 'boolean') return v;
    const s = String(v).toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
    return fallback;
  }

  // ── Store paths ─────────────────────────────────────────────────────────
  const storeDir = path.join(cmd.cwd, '.agents', 'memory');
  const l1Path = path.join(storeDir, 'L1-EVENTS.md');
  const l1ArchivePath = path.join(storeDir, 'L1-ARCHIVE.md');
  const l2Path = path.join(storeDir, 'L2-REGISTRY.md');
  const l3Dir = path.join(storeDir, 'L3-LESSONS');
  const ledgerPath = path.join(storeDir, 'episodes.jsonl');
  const recallStatsPath = path.join(storeDir, 'recall-stats.json');

  function bootstrapStore(): void {
    ensureDir(storeDir);
    ensureDir(l3Dir);
    if (!fs.existsSync(path.join(storeDir, 'README.md'))) {
      fs.writeFileSync(path.join(storeDir, 'README.md'), STORE_README);
    }
    if (!fs.existsSync(l1Path)) fs.writeFileSync(l1Path, L1_TEMPLATE);
    if (!fs.existsSync(l1ArchivePath)) {
      fs.writeFileSync(l1ArchivePath, '# L1 — Archive\n\n<!-- Verbatim compactions from L1-EVENTS.md, oldest first -->\n');
    }
    if (!fs.existsSync(l2Path)) fs.writeFileSync(l2Path, L2_TEMPLATE);
    if (!fs.existsSync(ledgerPath)) fs.writeFileSync(ledgerPath, '');
  }

  // ── Ledger + L1 helpers ────────────────────────────────────────────────
  function readLedger(): EpisodeLine[] {
    try {
      if (!fs.existsSync(ledgerPath)) return [];
      const lines = fs.readFileSync(ledgerPath, 'utf-8').split('\n');
      const out: EpisodeLine[] = [];
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i];
        if (!text.trim()) continue;
        try {
          out.push({line: i + 1, data: JSON.parse(text)});
        } catch { /* skip corrupt line */ }
      }
      return out;
    } catch { return []; }
  }

  function isTombstone(data: Record<string, unknown>): boolean {
    return data._tombstone === true;
  }

  function nextEventId(): number {
    const entries = readL1Entries();
    const ids = entries.map(e => e.num).filter((n): n is number => n !== null);
    return ids.length > 0 ? Math.max(...ids) + 1 : 1;
  }

  function readL1Entries(): {line: string; num: number | null; date: string; title: string}[] {
    try {
      if (!fs.existsSync(l1Path)) return [];
      const lines = stripBom(fs.readFileSync(l1Path, 'utf-8')).split(/\r?\n/);
      const entries: {line: string; num: number | null; date: string; title: string}[] = [];
      for (const line of lines) {
        if (!line.startsWith('### ')) continue;
        const m = line.match(L1_ENTRY_RE);
        entries.push({
          line,
          num: m ? parseInt(m[3], 10) : null,
          date: m ? m[1] : '',
          // The entry title is everything after the "evt-NNNN — " prefix.
          title: m ? line.slice(line.indexOf('—', line.indexOf('—') + 1) + 2).trim() : line.slice(4),
        });
      }
      return entries;
    } catch { return []; }
  }

  function prependL1Entry(date: string, id: number, title: string, body: string): void {
    bootstrapStore();
    const raw = stripBom(fs.readFileSync(l1Path, 'utf-8'));
    const marker = '## Event Log';
    const idx = raw.indexOf(marker);
    if (idx < 0) return;
    const head = raw.slice(0, idx + marker.length);
    const tail = raw.slice(idx + marker.length);
    const entry = `\n\n### ${date} — evt-${String(id).padStart(4, '0')} — ${title}\n${body}\n`;

    // The event log tail starts with a "<!-- Newest first -->" comment after
    // bootstrap. Insert the entry right after it; otherwise fall back to a
    // plain append after the "## Event Log" heading.
    const commentIdx = tail.indexOf('<!-- Newest first -->');
    if (commentIdx >= 0) {
      const commentEnd = commentIdx + '<!-- Newest first -->'.length;
      const newTail = tail.slice(0, commentEnd) + entry + tail.slice(commentEnd);
      fs.writeFileSync(l1Path, head + newTail);
    } else {
      fs.writeFileSync(l1Path, head + entry + tail);
    }
    compactL1();
  }

  function compactL1(): void {
    try {
      const entries = readL1Entries();
      if (entries.length <= L1_CAP) return;
      // Newest-first layout: the OLDEST entries are at the END of the entries
      // list. Keep the first L1_CAP (newest); archive the trailing oldest.
      const keep = entries.slice(0, L1_CAP);
      const overflow = entries.slice(L1_CAP);
      const raw = stripBom(fs.readFileSync(l1Path, 'utf-8'));
      const lines = raw.split(/\r?\n/);
      const overflowLines = new Set(overflow.map(e => e.line));
      const kept = lines.filter(l => !overflowLines.has(l));
      fs.writeFileSync(l1Path, kept.join('\n'));
      // Append overflow verbatim to archive (oldest first).
      const archiveRaw = fs.existsSync(l1ArchivePath)
        ? stripBom(fs.readFileSync(l1ArchivePath, 'utf-8')) : '';
      fs.writeFileSync(
        l1ArchivePath,
        archiveRaw + '\n' + overflow.map(e => e.line).join('\n') + '\n',
      );
    } catch { /* best-effort */ }
  }

  // ── L2 helpers ──────────────────────────────────────────────────────────
  function readL2(): string {
    try {
      return fs.existsSync(l2Path) ? stripBom(fs.readFileSync(l2Path, 'utf-8')) : L2_TEMPLATE;
    } catch { return L2_TEMPLATE; }
  }

  function l2SectionValid(): boolean {
    const raw = readL2();
    return L2_SECTIONS.every(s => raw.includes(s));
  }

  function addL2Row(section: string, cells: string[]): string | null {
    if (!L2_SECTIONS.includes(section)) return `Unknown section: ${section}`;
    if (cells.length === 0 || cells.some(c => c.includes('|'))) return 'Cells must not contain pipes';
    const raw = readL2();
    const lines = raw.split(/\r?\n/);
    const secIdx = lines.findIndex(l => l.trim() === section);
    if (secIdx < 0) return `Section ${section} missing`;
    // Insert after the header separator row (## --- | --- row).
    let insertAt = secIdx + 2;
    while (insertAt < lines.length && lines[insertAt].trim() !== '' && lines[insertAt].includes('|')) {
      insertAt++;
    }
    const row = '| ' + cells.join(' | ') + ' |';
    lines.splice(insertAt, 0, row);
    fs.writeFileSync(l2Path, lines.join('\n'));
    return null;
  }

  // ── L3 helpers ──────────────────────────────────────────────────────────
  function listLessons(): LessonMeta[] {
    try {
      if (!fs.existsSync(l3Dir)) return [];
      return fs.readdirSync(l3Dir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const raw = stripBom(fs.readFileSync(path.join(l3Dir, f), 'utf-8'));
          const m = raw.match(L3_FRONTMATTER_RE);
          const titleMatch = raw.match(/^# Lesson: (.+)$/m);
          return {
            file: f,
            domain: m ? m[1] : 'unknown',
            date: m ? m[2] : '',
            confidence: (m ? m[3] : 'low') as LessonMeta['confidence'],
            source: m ? m[4] : '',
            title: titleMatch ? titleMatch[1] : f.replace(/\.md$/, ''),
          };
        })
        .filter(l => l !== null);
    } catch { return []; }
  }

  function writeLesson(meta: {
    domain: string;
    title: string;
    confidence: 'high' | 'medium' | 'low';
    source: string;
    what: string;
    why: string;
  }): string | null {
    const file = `${slugify(meta.domain)}-${slugify(meta.title)}.md`;
    const existing = path.join(l3Dir, file);
    if (fs.existsSync(existing)) return `Lesson already exists: ${file}`;
    const content = `---\ntype: lesson\ndomain: ${meta.domain}\ndate: ${today()}\nconfidence: ${meta.confidence}\nsource: ${meta.source}\n---\n\n# Lesson: ${meta.title}\n\n## What\n${meta.what}\n\n## Why\n${meta.why}\n`;
    ensureDir(l3Dir);
    fs.writeFileSync(existing, content);
    return null;
  }

  // ── Episode feed (verified completions only) ────────────────────────────
  const seenCycleIds = new Set<string>();
  const lastUse: Record<string, number> = {};
  const graduated = new Set<string>();

  interface RecallStats {
    counts: Record<string, number>;
    graduated: string[];
  }

  function loadRecallStats(): RecallStats {
    try {
      if (fs.existsSync(recallStatsPath)) {
        const parsed = JSON.parse(fs.readFileSync(recallStatsPath, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          return {
            counts: parsed.counts && typeof parsed.counts === 'object' ? parsed.counts : {},
            graduated: Array.isArray(parsed.graduated) ? parsed.graduated : [],
          };
        }
      }
    } catch { /* start fresh */ }
    return {counts: {}, graduated: []};
  }

  function saveRecallStats(stats: RecallStats): void {
    try {
      ensureDir(storeDir);
      fs.writeFileSync(recallStatsPath, JSON.stringify(stats, null, 2));
    } catch { /* best-effort */ }
  }

  function bumpRecallCount(title: string): void {
    const stats = loadRecallStats();
    stats.counts[title] = (stats.counts[title] ?? 0) + 1;
    saveRecallStats(stats);
  }

  function markGraduated(file: string): void {
    const stats = loadRecallStats();
    if (!stats.graduated.includes(file)) {
      stats.graduated.push(file);
      saveRecallStats(stats);
    }
  }

  function graduateLessonToLearnLoop(lesson: LessonMeta): void {
    if (graduated.has(lesson.file)) return;
    let what = '';
    let why = '';
    try {
      const raw = stripBom(fs.readFileSync(path.join(l3Dir, lesson.file), 'utf-8'));
      what = raw.match(/## What\n([\s\S]*?)(?=\n## Why|\n---|$)/)?.[1]?.trim() ?? '';
      why = raw.match(/## Why\n([\s\S]*?)(?=$)/)?.[1]?.trim() ?? '';
    } catch { /* lesson vanished — nothing to hand over */ return; }
    graduated.add(lesson.file);
    cmd.events.emit('memory-bank/graduate', {
      title: lesson.title,
      domain: lesson.domain,
      source: lesson.source,
      what,
      why,
      skillName: slugify(lesson.domain + ' ' + lesson.title),
    });
    markGraduated(lesson.file);
  }

  function maybeAutoGraduate(): void {
    if (!boolFlag('mb-auto-graduate', true)) return;
    const threshold = numFlag('mb-graduate-after', 3, 1);
    const stats = loadRecallStats();
    const alreadyGraduated = new Set(stats.graduated);
    for (const lesson of listLessons()) {
      if (alreadyGraduated.has(lesson.file) || graduated.has(lesson.file)) continue;
      if (lesson.confidence !== 'high' && lesson.confidence !== 'medium') continue;
      if ((stats.counts[lesson.title] ?? 0) < threshold) continue;
      graduateLessonToLearnLoop(lesson);
      prependL1Entry(today(), nextEventId(), `Auto-graduated lesson to skill: ${lesson.title}`, `Lesson "${lesson.title}" crossed ${threshold} recalls and was handed to learn-loop.`);
    }
  }

  cmd.events.on('self-repair/verdict', (raw) => {
    const v = (raw ?? {}) as Record<string, unknown>;
    if (v.final !== true || v.complete !== true) return;
    const cycleId = typeof v.cycleId === 'string' ? v.cycleId : '';
    if (!cycleId || seenCycleIds.has(cycleId)) return;
    seenCycleIds.add(cycleId);

    const evidence = Array.isArray(v.evidence) ? v.evidence.map(String) : [];
    const files = Array.isArray(v.files) ? v.files.map(String) : [];
    const episode = {
      ts: new Date().toISOString(),
      cycleId,
      evidence,
      files,
    };
    try {
      bootstrapStore();
      fs.appendFileSync(ledgerPath, JSON.stringify(episode) + '\n');
    } catch { /* ledger is best-effort */ }

    const title = `Verified completion: ${cycleId}`;
    const body = `Self-repair final verdict for cycle ${cycleId}.\n` +
      (evidence.length > 0 ? `- Evidence: ${evidence.join(', ')}\n` : '') +
      (files.length > 0 ? `- Files: ${files.slice(0, 10).join(', ')}\n` : '');
    prependL1Entry(today(), nextEventId(), title, body);
  });

  // ── Recall matcher ──────────────────────────────────────────────────────
  function recall(query: string, limit: number): {score: number; layer: string; title: string; detail: string}[] {
    const queryKeys = extractKeywords(query);
    if (queryKeys.length < 2) return [];
    const threshold = numFlag('mb-recall-threshold', 0.35);
    const matches: {score: number; layer: string; title: string; detail: string}[] = [];

    // L1 events
    for (const e of readL1Entries().slice(0, 60)) {
      const keys = extractKeywords(e.title);
      const score = scoreMatch(queryKeys, keys);
      if (score < threshold) continue;
      matches.push({score, layer: 'L1', title: e.title, detail: `${e.date} ${e.line.slice(0, 200)}`});
    }

    // L3 lessons
    for (const l of listLessons()) {
      const keys = extractKeywords(`${l.title} ${l.domain} ${l.source}`);
      const score = scoreMatch(queryKeys, keys);
      if (score < threshold) continue;
      matches.push({
        score, layer: 'L3', title: l.title,
        detail: `${l.domain} · ${l.confidence} · ${l.source}`,
      });
    }

    matches.sort((a, b) => b.score - a.score);
    for (const m of matches.slice(0, limit)) {
      lastUse[m.title] = Date.now();
      if (m.layer === 'L3') bumpRecallCount(m.title);
    }
    maybeAutoGraduate();
    return matches.slice(0, limit);
  }

  // ── Read: session-start digest (one-shot, bounded) ─────────────────────
  let digestInjected = false;
  cmd.hooks({
    appendSystemPrompt: () => {
      if (digestInjected) return undefined;
      digestInjected = true;
      if (!fs.existsSync(l1Path)) return undefined;
      const lines: string[] = [];
      const entries = readL1Entries().slice(0, numFlag('mb-digest-lines', 3, 0));
      if (entries.length > 0) {
        lines.push('PROJECT MEMORY (leads, not facts — verify before acting):');
        for (const e of entries) lines.push(`  ${e.title}`);
      }
      const lessons = listLessons();
      if (lessons.length > 0) {
        lines.push(`  ${lessons.length} lesson(s) in memory: ${lessons.map(l => l.title).slice(0, 5).join('; ')}`);
      }
      if (lines.length === 0) return undefined;
      const digest = lines.join('\n');
      return digest.length > 500 ? digest.slice(0, 500) + '…' : digest;
    },
  });

  // ── Read: per-message recall injection ─────────────────────────────────
  cmd.hooks({
    transformContext: ({messages}) => {
      let lastUser = '';
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && typeof m === 'object' && (m as Record<string, unknown>).role === 'user') {
          const content = (m as Record<string, unknown>).content;
          if (typeof content === 'string') { lastUser = content; break; }
        }
      }
      if (lastUser.length < 8) return messages;
      const hits = recall(lastUser, Math.round(numFlag('mb-max-recall-items', 3, 0)));
      if (hits.length === 0) return messages;
      const block = ['\n[memory] Prior durable facts (leads — verify before acting):']
        .concat(hits.map(h => `- ${h.layer}: ${h.title} — ${h.detail.slice(0, 160)}`))
        .join('\n');
      const result = [...messages];
      result.splice(Math.max(0, result.length - 2), 0, {role: 'user', content: block} as never);
      return result;
    },
  });

  // ── Write-bar hook for bank_write tool ──────────────────────────────────
  cmd.hooks({
    beforeToolCall: async ({toolName, input}) => {
      if (toolName !== 'bank_write') return undefined;
      const inp = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      const kind = String(inp.kind ?? '');
      if (kind === 'lesson') {
        const domain = String(inp.domain ?? '');
        const confidence = String(inp.confidence ?? '');
        const source = String(inp.source ?? '');
        if (!domain || !['high', 'medium', 'low'].includes(confidence) || !source) {
          return {
            block: true,
            additionalContext: 'BLOCKED: lesson writes require domain, confidence (high|medium|low), and source.',
          };
        }
      }
      if (kind === 'registry') {
        const section = String(inp.section ?? '');
        const cells = Array.isArray(inp.cells) ? inp.cells.map(String) : [];
        if (!L2_SECTIONS.includes(section) || cells.length === 0) {
          return {
            block: true,
            additionalContext: 'BLOCKED: registry writes require a valid section and non-empty cells (pointers, not copies).',
          };
        }
      }
      return undefined;
    },
  });

  // ── Tools ───────────────────────────────────────────────────────────────
  cmd.addTool({
    schema: {
      name: 'bank_recall',
      description: 'Search the project memory store (.agents/memory) for durable facts. Returns leads, not facts — verify before acting.',
      input_schema: {
        type: 'object',
        properties: {
          query: {type: 'string', description: 'Keywords to search for.'},
          limit: {type: 'number', description: 'Max results (default 5).'},
        },
        required: ['query'],
      },
    },
    readOnly: true,
    run: async ({input}) => {
      const query = String(input.query ?? '');
      const limit = typeof input.limit === 'number' ? input.limit : 5;
      const hits = recall(query, Math.min(limit, 15));
      if (hits.length === 0) {
        return {ok: true, content: [{type: 'text', text: 'No memory matches.'}]};
      }
      const text = hits.map(h => `[${h.layer}] ${h.title}\n  ${h.detail.slice(0, 200)}`).join('\n');
      return {ok: true, content: [{type: 'text', text}]};
    },
  });

  cmd.addTool({
    schema: {
      name: 'bank_write',
      description: 'Write a gated memory entry to the project store. kind: event (L1), registry (L2 row), or lesson (L3). The write-bar is enforced — only durable, cross-session facts belong.',
      input_schema: {
        type: 'object',
        properties: {
          kind: {type: 'string', enum: ['event', 'registry', 'lesson'], description: 'Which layer to write.'},
          title: {type: 'string', description: 'Event title or lesson title.'},
          body: {type: 'string', description: 'Event body (L1) or lesson What section (L3).'},
          domain: {type: 'string', description: 'Lesson domain (L3, required).'},
          confidence: {type: 'string', enum: ['high', 'medium', 'low'], description: 'Lesson confidence (L3, required).'},
          source: {type: 'string', description: 'Lesson source: design-decision, postmortem, user-feedback, etc. (L3, required).'},
          why: {type: 'string', description: 'Lesson Why section (L3).'},
          section: {type: 'string', description: 'L2 section name (registry, required).'},
          cells: {type: 'array', items: {type: 'string'}, description: 'L2 table row cells (registry, required).'},
        },
        required: ['kind'],
      },
    },
    run: async ({input}) => {
      const kind = String(input.kind ?? '');
      bootstrapStore();

      if (kind === 'event') {
        const title = String(input.title ?? '').slice(0, 80);
        const body = String(input.body ?? '');
        if (!title) return {ok: false, error: 'title is required for event writes'};
        prependL1Entry(today(), nextEventId(), title, body);
        return {ok: true, content: [{type: 'text', text: `L1 event written: ${title}`}]};
      }

      if (kind === 'registry') {
        const section = String(input.section ?? '');
        const cells = Array.isArray(input.cells) ? input.cells.map(String) : [];
        const err = addL2Row(section, cells);
        if (err) return {ok: false, error: err};
        return {ok: true, content: [{type: 'text', text: `L2 row added to ${section}.`}]};
      }

      if (kind === 'lesson') {
        const err = writeLesson({
          domain: String(input.domain ?? ''),
          title: String(input.title ?? ''),
          confidence: (String(input.confidence ?? 'low')) as 'high' | 'medium' | 'low',
          source: String(input.source ?? ''),
          what: String(input.body ?? ''),
          why: String(input.why ?? ''),
        });
        if (err) return {ok: false, error: err};
        return {ok: true, content: [{type: 'text', text: `L3 lesson written.`}]};
      }

      return {ok: false, error: `Unknown kind: ${kind}`};
    },
  });

  // ── Commands ────────────────────────────────────────────────────────────
  cmd.addCommand({
    name: 'bank',
    description: 'Memory bank: status, remember, forget, recall, maintain, graduate, digest',
    argumentHint: '<status|remember <note>|forget <#id>|recall <query>|maintain|graduate <lesson>|digest>',
    handler: ({args}) => {
      const trimmed = args.trim();
      const [sub, ...rest] = trimmed.split(/\s+/);
      const restText = rest.join(' ');
      bootstrapStore();

      if (!sub || sub === 'status') {
        const l1 = readL1Entries().length;
        const l2 = readL2().split('\n').filter(l => l.trim().startsWith('|') && !l.includes('---')).length - 4;
        const l3 = listLessons().length;
        const ledger = readLedger().filter(e => !isTombstone(e.data)).length;
        return {message: `Memory bank: ${l1} L1 events · ${Math.max(l2, 0)} L2 rows · ${l3} L3 lessons · ${ledger} verified episodes\nStore: ${storeDir}`};
      }

      if (sub === 'remember') {
        if (!restText) return {message: 'Usage: /bank remember <durable note>'};
        // Write-bar: durable + cross-session heuristic (length + specificity).
        if (restText.length < 12) {
          return {message: 'Rejected: too short to be a durable fact. Notes must be specific (≥ 12 chars).'};
        }
        prependL1Entry(today(), nextEventId(), restText.slice(0, 80), restText);
        return {message: `Remembered: ${restText.slice(0, 100)}`};
      }

      if (sub === 'forget') {
        const target = restText;
        if (!target) return {message: 'Usage: /bank forget <#id|cycleId>'};
        const lines = readLedger();
        let lineNo = -1;
        if (/^#?\d+$/.test(target)) {
          const n = parseInt(target.replace('#', ''), 10);
          const found = lines.find(e => e.line === n && !isTombstone(e.data));
          if (found) lineNo = found.line;
        } else {
          const found = lines.find(e =>
            !isTombstone(e.data) &&
            String(e.data.cycleId || '').includes(target));
          if (found) lineNo = found.line;
        }
        if (lineNo < 0) return {message: `No episode matches "${target}".`};
        const raw = fs.readFileSync(ledgerPath, 'utf-8').split('\n');
        raw[lineNo - 1] = JSON.stringify({_tombstone: true, _deleted: new Date().toISOString(), _target: target});
        fs.writeFileSync(ledgerPath, raw.join('\n'));
        return {message: `Forgot episode #${lineNo}.`};
      }

      if (sub === 'recall') {
        if (!restText) return {message: 'Usage: /bank recall <query>'};
        const hits = recall(restText, 15);
        if (hits.length === 0) return {message: `No memory matches for "${restText}".`};
        return {message: hits.map(h => `[${h.layer}] ${h.title}\n  ${h.detail.slice(0, 200)}`).join('\n\n')};
      }

      if (sub === 'maintain') {
        return {
          prompt: [
            'Run the memory-maintenance sweep on .agents/memory/ using read-only inspection first:',
            '1. Read the store README contract, L1-EVENTS.md, L2-REGISTRY.md, and every L3 lesson.',
            '2. Dedupe: merge near-duplicate L3 lessons into the strongest one; update L2 rows whose pointers moved.',
            '3. Graduation: any L3 lesson that reads like a stable rule should become a skill. DO NOT write .agents/skills/ directly — emit a memory-bank/graduate event (or use /bank graduate <lesson>) so learn-loop creates and manages the skill. learn-loop is the single skill manager.',
            '4. Decay: for low/medium-confidence lessons unused for a long time, lower confidence or propose removal — never delete without a reason recorded in L1.',
            '5. Compact: if L1 exceeds 30 entries, move the oldest verbatim to L1-ARCHIVE.md.',
            '6. Do NOT edit AGENTS.md. Propose AGENTS.md lines separately in your final message for user approval.',
            'Use bank_write for store changes and bank_recall to verify no duplicates exist. End with a summary of what changed and what you propose.',
          ].join('\n'),
        };
      }

      if (sub === 'graduate') {
        const target = restText;
        if (!target) return {message: 'Usage: /bank graduate <lesson-file-or-title>'};
        const lessons = listLessons();
        const lesson = lessons.find(l => l.file === target || l.title === target);
        if (!lesson) return {message: `No lesson matches "${target}".`};
        const skillName = slugify(lesson.domain + ' ' + lesson.title);

        // Delegate skill creation to learn-loop — it is the single skill
        // manager and owns the full lifecycle (promote, sync, merge, decay).
        graduateLessonToLearnLoop(lesson);
        prependL1Entry(today(), nextEventId(), `Graduated lesson to skill: ${skillName}`, `Lesson "${lesson.title}" was handed to learn-loop to manage as .agents/skills/${skillName}/SKILL.md.`);
        return {message: `Graduated "${lesson.title}" → learn-loop will manage .agents/skills/${skillName}/SKILL.md.`};
      }

      if (sub === 'digest') {
        const entries = readL1Entries().slice(0, 5);
        if (entries.length === 0) return {message: 'No L1 events yet.'};
        return {message: entries.map(e => `${e.date} ${e.title}`).join('\n')};
      }

      return {message: 'Usage: /bank status|remember|forget|recall|maintain|graduate|digest'};
    },
  });

  // ── Initialize ──────────────────────────────────────────────────────────
  bootstrapStore();
}
