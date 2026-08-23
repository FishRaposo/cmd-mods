import type {ModApi} from '@commandcode/harness';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Learn Loop — the learning slot of the truth pipeline ────────────────────
//
// learn-loop distills project workflow patterns from raw episodes
// (project-scoped <project>/.agents/learning/). It records everything,
// distills later, and manages the candidate → shadow → active artifact
// lifecycle.
//
// It sits BESIDE memory-bank, which owns durable project facts in
// .agents/memory/ with a write-bar. The split:
//   memory-bank = memory    (gated verified facts: what the project IS)
//   learn-loop  = learning  (ungated raw feed: how the work goes — issues,
//                            corrections, workflows — distilled into patterns)
//
// They share no state, no commands, and no store. Both may recall
// contextually — memory-bank injects [memory] leads, learn-loop injects
// pattern leads — and both stay quiet and capped.

// ── Types ────────────────────────────────────────────────────────────────────

interface Episode {
  task_signature: string;
  files: string[];
  tools: string[];
  verify: string[];
  outcome: string;
  user_corrections: string[];
  subagents: string[];
  skill_used: string | null;
  model: string;
  confidence: number;
  ts: string;
  distilled?: boolean;
}

interface Artifact {
  kind: 'skill' | 'taste' | 'warning' | 'guard';
  status: 'candidate' | 'shadow' | 'active' | 'archived' | 'rejected';
  path: string;
  scope: 'user' | 'project' | 'global';
  tags: string[];
  description: string;
  confidence: number;
  shadow_runs: number;
  green: number;
  red: number;
  rejections: number;
  episodes: number[];
  created: string;
  last_verified: string;
  last_used: string;
  pinned: boolean;
  version?: number;
  use_count: number;
  installed_at?: string;
  rejection_reason?: string;
}

interface IndexData {
  artifacts: Record<string, Artifact>;
  episode_count: number;
  last_curator_run: string;
  digests: DigestEntry[];
}

interface DigestEntry {
  date: string;
  summary: string;
}

interface EpisodeInFlight {
  task_signature: string;
  files: Set<string>;
  tools: Set<string>;
  verify: Set<string>;
  user_corrections: string[];
  subagents: Set<string>;
  skill_used: string | null;
  failures: number;
  model: string;
  draftCreated: boolean;
  distilled: boolean;
}

interface EpisodeLine {
  line: number;
  id: number;
  data: Record<string, unknown>;
}

// ── Paths ────────────────────────────────────────────────────────────────────
// Project-scoped, shared .agents convention: <project>/.agents/learning/
// Reassigned at factory start from cmd.cwd (module scope has no cmd).
let LEARNING_DIR = path.join(os.homedir(), '.commandcode', 'learning');
let EPISODES_PATH = path.join(LEARNING_DIR, 'episodes.jsonl');
let INDEX_PATH = path.join(LEARNING_DIR, 'index.json');
let CANDIDATES_DIR = path.join(LEARNING_DIR, 'candidates');
let ACTIVE_DIR = path.join(LEARNING_DIR, 'active');
let GRAVEYARD_DIR = path.join(LEARNING_DIR, 'graveyard');
// Real skill output: Command Code auto-loads .agents/skills/. Promotion
// installs the SKILL.md here so it becomes a live, loadable skill.
let SKILLS_OUTPUT_DIR = path.join(os.homedir(), '.agents', 'skills');
// Autonomous-action receipts: one JSONL line per autonomous move.
let AUTONOMY_PATH = path.join(LEARNING_DIR, 'autonomy.jsonl');
// Persistent merge-pair dismissals: agent judgment "these are different jobs".
let MERGE_DISMISSALS_FILE = path.join(LEARNING_DIR, 'merge-dismissals.json');

// ── Cross-process file lock ──────────────────────────────────────────────
// Parallel Command Code sessions run in separate processes but share this
// project's store files. Read-modify-write sequences (loadIndex→saveIndex,
// episode appends, skill-dir moves) must not interleave. The lock is a
// mutually-exclusive mkdir with an atomic rename — no dependency, works
// across processes, and the metadata file records who holds it.
//
// Reentrant per process: nested acquire() calls from the same process share
// one lock handle (a depth counter), so saveIndex inside a locked region
// doesn't self-deadlock. Cross-process waiters retry for up to ~10s, then
// steal a lock whose holder is gone (stale) — the mutex never hard-blocks.
const LOCK_KEYS = new Map<string, {depth: number}>();
const LOCK_WAIT_MS = 10000;
const LOCK_RETRY_MS = 40;

function lockTarget(key: string): string {
  return path.join(LEARNING_DIR, '.locks', `${slugifyLock(key)}.lock`);
}

function slugifyLock(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
}

function lockHolder(lockDir: string): string {
  try {
    return fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf-8').trim();
  } catch {
    return '?';
  }
}

function acquireLock(key: string): (() => void) | null {
  const existing = LOCK_KEYS.get(key);
  if (existing) {
    existing.depth += 1;
    return () => {
      existing.depth -= 1;
      if (existing.depth <= 0) LOCK_KEYS.delete(key);
    };
  }
  const target = lockTarget(key);
  try { ensureDir(path.dirname(target)); } catch { /* best-effort */ }
  const started = Date.now();
  const tmp = target + '.tmp-' + process.pid;
  while (true) {
    try {
      fs.mkdirSync(tmp, {recursive: false});
      try {
        fs.renameSync(tmp, target);
      } catch {
        // Another process won the race or holds the lock.
        fs.rmSync(tmp, {recursive: true, force: true});
        if (Date.now() - started > LOCK_WAIT_MS) {
          // Stale-steal: holder pid no longer alive.
          const holder = lockHolder(target);
          if (/^\d+$/.test(holder) && !isProcessAlive(Number(holder))) {
            fs.rmSync(target, {recursive: true, force: true});
            continue;
          }
          return null;
        }
        sleepMs(LOCK_RETRY_MS);
        continue;
      }
    } catch {
      if (Date.now() - started > LOCK_WAIT_MS) return null;
      sleepMs(LOCK_RETRY_MS);
      continue;
    }
    try {
      fs.writeFileSync(path.join(target, 'owner.json'),
        JSON.stringify({pid: process.pid, ts: new Date().toISOString()}));
    } catch { /* lock is held even without metadata */ }
    const handle = {depth: 1};
    LOCK_KEYS.set(key, handle);
    return () => {
      handle.depth -= 1;
      if (handle.depth > 0) return;
      LOCK_KEYS.delete(key);
      try { fs.rmSync(target, {recursive: true, force: true}); } catch { /* stale later */ }
    };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleepMs(ms: number): void {
  const until = Date.now() + ms;
  // Busy-wait is fine here: contention is rare, and SyncFS calls must not
  // yield to timers (node timers don't fire during tight sync loops).
  while (Date.now() < until) { /* spin */ }
}

function withLock<T>(key: string, fn: () => T): T | null {
  const release = acquireLock(key);
  if (!release) return null;
  try {
    return fn();
  } finally {
    release();
  }
}

function writeReceipt(entry: Record<string, unknown>): void {
  try {
    ensureDir(LEARNING_DIR);
    fs.appendFileSync(AUTONOMY_PATH, JSON.stringify({ts: new Date().toISOString(), ...entry}) + '\n');
  } catch { /* receipts are best-effort */ }
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'are',
  'was', 'not', 'but', 'you', 'all', 'can', 'had', 'her', 'was', 'one',
  'our', 'out', 'has', 'been', 'when', 'your', 'how', 'will', 'each',
  'about', 'which', 'their', 'said', 'would', 'make', 'like', 'just',
  'into', 'them', 'than', 'then', 'its', 'over', 'also', 'after',
  'what', 'only', 'other', 'more', 'some', 'could', 'these', 'very',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
}

function loadIndex(): IndexData {
  try {
    if (fs.existsSync(INDEX_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
      return {
        artifacts: parsed.artifacts && typeof parsed.artifacts === 'object' ? parsed.artifacts : {},
        episode_count: typeof parsed.episode_count === 'number' ? parsed.episode_count : 0,
        last_curator_run: typeof parsed.last_curator_run === 'string' ? parsed.last_curator_run : '',
        digests: Array.isArray(parsed.digests) ? parsed.digests : [],
      };
    }
  } catch { /* corrupted, start fresh */ }
  return {artifacts: {}, episode_count: 0, last_curator_run: '', digests: []};
}

function saveIndex(idx: IndexData): void {
  ensureDir(LEARNING_DIR);
  const tmp = INDEX_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2));
  fs.renameSync(tmp, INDEX_PATH);
}

function appendEpisode(ep: Episode): void {
  // Locked: two parallel sessions flushing at once would interleave the
  // append and the index count bump, dropping episodes or corrupting the
  // file. Best-effort under contention (skip rather than corrupt).
  withLock('episodes', () => {
    ensureDir(LEARNING_DIR);
    fs.appendFileSync(EPISODES_PATH, JSON.stringify(ep) + '\n');
    const idx = loadIndex();
    idx.episode_count += 1;
    saveIndex(idx);
  });
}

function readEpisodeLines(): EpisodeLine[] {
  try {
    if (!fs.existsSync(EPISODES_PATH)) return [];
    const lines = fs.readFileSync(EPISODES_PATH, 'utf-8').split('\n');
    const out: EpisodeLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (!text.trim()) continue;
      try {
        out.push({line: i + 1, id: i + 1, data: JSON.parse(text)});
      } catch { /* skip corrupt line */ }
    }
    return out;
  } catch { return []; }
}

function isTombstone(data: Record<string, unknown>): boolean {
  return data._tombstone === true;
}

function replaceEpisodeLine(line: number, data: Record<string, unknown>): void {
  withLock('episodes', () => {
    try {
      if (!fs.existsSync(EPISODES_PATH)) return;
      const raw = fs.readFileSync(EPISODES_PATH, 'utf-8').split('\n');
      if (line < 1 || line > raw.length) return;
      raw[line - 1] = JSON.stringify(data);
      const tmp = EPISODES_PATH + '.tmp';
      fs.writeFileSync(tmp, raw.join('\n'));
      fs.renameSync(tmp, EPISODES_PATH);
    } catch { /* ok */ }
  });
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function extractKeywords(text: string): string[] {
  const words = text.toLowerCase().split(/[\s\-_.,;:!?()[\]{}"'`~@#$%^&*+=<>/\\|]+/);
  return words
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 20);
}

function extractTaskSignature(userText: string, cwd: string): string {
  const shortCwd = path.basename(cwd);
  const verbs = [
    'fix', 'debug', 'build', 'add', 'create', 'implement', 'refactor',
    'migrate', 'deploy', 'test', 'update', 'remove', 'configure', 'setup',
    'write', 'generate', 'analyze', 'optimize', 'review', 'document',
  ];
  const lower = userText.toLowerCase();
  const verb = verbs.find(v => lower.startsWith(v)) || 'task';

  const clean = userText
    .replace(/^(can you |please |help me |i need (to |you to )?)/i, '')
    .replace(/[^a-z0-9\s-]/gi, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 80);

  return `${shortCwd}:${verb}:${clean}`;
}

function extractFilePath(input: unknown): string | null {
  if (typeof input === 'object' && input !== null && 'file_path' in input) {
    return String((input as Record<string, unknown>).file_path);
  }
  return null;
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

// Tool results are content blocks, not strings — normalize for regex checks.
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

function resolveArtifactFile(art: Artifact): string | null {
  try {
    const base = path.join(LEARNING_DIR, art.path);
    if (!fs.existsSync(base)) return null;
    const st = fs.statSync(base);
    if (st.isFile()) return base;
    if (st.isDirectory()) {
      const files = fs.readdirSync(base).filter(f => f.endsWith('.md') || f.endsWith('.ts'));
      if (files.length > 0) return path.join(base, files[0]);
    }
  } catch { /* ok */ }
  return null;
}

// ── Real skill file helpers ─────────────────────────────────────────────────
// Promotion of kind=skill artifacts installs a live SKILL.md under
// .agents/skills/ (auto-loaded by Command Code). Taste/warning/guard stay
// internal to the learning store — they are patterns, not skills.

function skillFileFor(id: string): string {
  return path.join(SKILLS_OUTPUT_DIR, id, 'SKILL.md');
}

// Ownership marker: learn-loop only manages skill dirs it installed itself.
// User-installed skills are never touched.
const MANAGED_MARKER = '.managed.json';

function markerFileFor(id: string): string {
  return path.join(SKILLS_OUTPUT_DIR, id, MANAGED_MARKER);
}

function isManagedSkillDir(id: string): boolean {
  const markerPath = markerFileFor(id);
  if (!fs.existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    return marker && marker.owner === 'learn-loop';
  } catch {
    return false;
  }
}

// Returns null if the skill dir is absent or managed by learn-loop.
// Returns an error string if a foreign (user-installed) skill dir exists.
function foreignSkillConflict(id: string): string | null {
  const dir = path.join(SKILLS_OUTPUT_DIR, id);
  if (!fs.existsSync(dir)) return null;
  if (isManagedSkillDir(id)) return null;
  return `foreign skill "${id}" at .agents/skills/${id}/ is not managed by learn-loop — rename it or pick a different artifact name`;
}

function installSkillFile(id: string, content: string): string | null {
  try {
    const conflict = foreignSkillConflict(id);
    if (conflict) return conflict;
    const target = skillFileFor(id);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, content);
    fs.writeFileSync(markerFileFor(id), JSON.stringify({
      owner: 'learn-loop', artifactId: id, installedAt: new Date().toISOString(),
    }));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// Remove the installed skill dir only if it carries the learn-loop marker.
function removeSkillFile(id: string): string | null {
  try {
    const dir = path.join(SKILLS_OUTPUT_DIR, id);
    if (!fs.existsSync(dir)) return null;
    if (!isManagedSkillDir(id)) {
      return `refusing to remove foreign skill "${id}" — not managed by learn-loop`;
    }
    fs.rmSync(dir, {recursive: true, force: true});
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// Sync an artifact's full directory (main file + references/) into the live
// .agents/skills/ location. Returns an error string or null on success.
function syncInstalledSkill(art: Artifact): string | null {
  const id = art.path.split('/').pop() || 'skill';
  try {
    const conflict = foreignSkillConflict(id);
    if (conflict) return conflict;
    const srcDir = path.join(LEARNING_DIR, art.path);
    if (!fs.existsSync(srcDir)) return `artifact dir missing for "${id}"`;

    const targetDir = path.join(SKILLS_OUTPUT_DIR, id);
    if (!fs.existsSync(targetDir)) ensureDir(targetDir);

    // Find the main artifact file (skill.md), build SKILL.md from it.
    const mainFile = resolveArtifactFile(art);
    if (!mainFile) return `cannot find main artifact file for "${id}"`;
    const body = skillBodyOnly(fs.readFileSync(mainFile, 'utf-8'));
    fs.writeFileSync(skillFileFor(id), buildSkillContent(art, body));

    // Copy supporting files/dirs (references, scripts, templates, examples).
    if (fs.statSync(srcDir).isDirectory()) {
      // Prune stale files in the target that no longer exist in the source.
      if (fs.statSync(targetDir).isDirectory()) {
        const kept = new Set<string>();
        for (const entry of fs.readdirSync(srcDir)) {
          if (path.basename(entry) === path.basename(mainFile)) continue;
          kept.add(entry);
        }
        for (const entry of fs.readdirSync(targetDir)) {
          if (entry === 'SKILL.md' || entry === MANAGED_MARKER) continue;
          if (!kept.has(entry)) {
            fs.rmSync(path.join(targetDir, entry), {recursive: true, force: true});
          }
        }
      }
      for (const entry of fs.readdirSync(srcDir)) {
        if (path.basename(entry) === path.basename(mainFile)) continue;
        const from = path.join(srcDir, entry);
        const to = path.join(targetDir, entry);
        if (fs.statSync(from).isDirectory()) {
          fs.cpSync(from, to, {recursive: true});
        } else {
          fs.copyFileSync(from, to);
        }
      }
    }
    // Write/refresh the ownership marker so the install is learn-loop-managed.
    fs.writeFileSync(markerFileFor(id), JSON.stringify({
      owner: 'learn-loop', artifactId: id, installedAt: new Date().toISOString(),
    }));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// Build a spec-compliant SKILL.md body from artifact metadata.
// Standard frontmatter: name, description, version, metadata.tags.
function buildSkillContent(art: Artifact, body: string): string {
  const name = art.path.split('/').pop() || 'skill';
  const description = (art.description || `${name} — learned project skill`).slice(0, 60);
  const version = typeof art.version === 'number' && art.version > 0
    ? `1.${art.version}.0` : '1.0.0';
  const lines = ['---', `name: ${name}`, `description: ${description}`, `version: ${version}`];
  if (art.tags.length > 0) {
    lines.push('metadata:', '  tags:', ...art.tags.map(t => `    - ${t}`));
  }
  lines.push('---', '', body);
  return lines.join('\n');
}

// Strip a SKILL.md frontmatter block, returning the body.
function skillBodyOnly(content: string): string {
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end > 0) return content.slice(end + 4).trimStart();
  }
  return content.trim();
}

function moveDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  ensureDir(path.dirname(dest));
  if (fs.existsSync(dest)) fs.rmSync(dest, {recursive: true, force: true});
  try {
    fs.renameSync(src, dest);
  } catch {
    // Cross-device fallback
    fs.cpSync(src, dest, {recursive: true});
    fs.rmSync(src, {recursive: true, force: true});
  }
}

// ── Mod ──────────────────────────────────────────────────────────────────────

export default function (cmd: ModApi): void {
  // ── Resolve store paths against THIS project ─────────────────────────────
  LEARNING_DIR = path.join(cmd.cwd, '.agents', 'learning');
  EPISODES_PATH = path.join(LEARNING_DIR, 'episodes.jsonl');
  INDEX_PATH = path.join(LEARNING_DIR, 'index.json');
  CANDIDATES_DIR = path.join(LEARNING_DIR, 'candidates');
  ACTIVE_DIR = path.join(LEARNING_DIR, 'active');
  GRAVEYARD_DIR = path.join(LEARNING_DIR, 'graveyard');
  SKILLS_OUTPUT_DIR = path.join(cmd.cwd, '.agents', 'skills');
  AUTONOMY_PATH = path.join(LEARNING_DIR, 'autonomy.jsonl');
  MERGE_DISMISSALS_FILE = path.join(LEARNING_DIR, 'merge-dismissals.json');

  // ── Flags ───────────────────────────────────────────────────────────────
  // addFlag supports only 'boolean' | 'string' — numbers arrive as strings
  // when set via --mod-option, so parse them in numFlag().
  cmd.addFlag('ll-recall-threshold', {type: 'string', default: '0.3',
    description: 'Minimum match score to inject recall context'});
  cmd.addFlag('ll-max-recall-items', {type: 'string', default: '6',
    description: 'Max items in the recall block'});
  cmd.addFlag('ll-decay-days', {type: 'string', default: '90',
    description: 'Days since last use before an active artifact is archived'});
  cmd.addFlag('ll-auto-distill', {type: 'boolean', default: true,
    description: 'Automatically run a distillation turn after signal-rich sessions'});
  cmd.addFlag('ll-auto-promote', {type: 'boolean', default: true,
    description: 'Automatically promote shadows with verified green evidence on self-repair verdicts'});
  cmd.addFlag('ll-max-distills', {type: 'string', default: '1',
    description: 'Max autonomous distillation turns per session'});
  cmd.addFlag('ll-distill-min-tools', {type: 'string', default: '8',
    description: 'Min tool iterations for a verify-driven distillation trigger'});
  cmd.addFlag('ll-min-shadow-runs', {type: 'string', default: '2',
    description: 'Min shadow runs (green>=red, no rejections) before auto-promotion'});
  cmd.addFlag('ll-candidate-ttl-days', {type: 'string', default: '30',
    description: 'Days before an untouched candidate is pruned to the graveyard'});
  cmd.addFlag('ll-write-approval', {type: 'boolean', default: false,
    description: 'Require human approval before learning_manage write actions land (Hermes write_approval parity). Review with /learn pending, /learn approve, /learn reject'});
  cmd.addFlag('ll-auto-merge', {type: 'boolean', default: true,
    description: 'Propose overlapping learned skills for agent-judged merge review at stop time'});
  cmd.addFlag('ll-merge-threshold', {type: 'string', default: '0.6',
    description: 'Minimum mechanical similarity (0-1) for a pair to be proposed. The pre-filter only — the agent reads both skills and makes the final merge call'});
  cmd.addFlag('ll-auto-delete-days', {type: 'string', default: '180',
    description: 'Days an archived artifact lingers before actual deletion'});
  cmd.addFlag('ll-merge-proposals', {type: 'string', default: '2',
    description: 'Max merge pairs proposed per review (keeps the review prompt small)'});
  cmd.addFlag('ll-merge-dismiss-ttl-days', {type: 'string', default: '30',
    description: 'Days a dismissed merge pair stays dismissed before it can be re-proposed'});
  cmd.addFlag('ll-max-skill-lines', {type: 'string', default: '300',
    description: 'Refuse a merge if the resulting skill body exceeds this many lines'});
  cmd.addFlag('ll-usage-receipts', {type: 'boolean', default: false,
    description: 'Write a receipt line for every learned-skill usage signal'});

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

  // ── In-session state (closure-scoped, flushed on onRunEnd) ──────────────
  let episode: EpisodeInFlight | null = null;
  let toolIterations = 0;
  let modelName: string = '';
  let sessionStart: string = '';
  let distillsThisRun = 0;
  const recalledThisRun = new Set<string>();
  const activeSkillsUsedThisRun = new Set<string>();
  // Merge-review bookkeeping: pairs already reviewed this run (so the stop
  // hook doesn't re-propose a pair the agent already judged), and persistent
  // dismissals ("different jobs, don't merge").
  const mergeReviewedThisRun = new Set<string>();
  let mergeDismissals: Record<string, number> = {};
  try {
    if (fs.existsSync(MERGE_DISMISSALS_FILE)) {
      mergeDismissals = JSON.parse(fs.readFileSync(MERGE_DISMISSALS_FILE, 'utf-8'));
    }
  } catch { mergeDismissals = {}; }

  function resetEpisode(): void {
    episode = null;
    toolIterations = 0;
    sessionStart = new Date().toISOString();
    recalledThisRun.clear();
    activeSkillsUsedThisRun.clear();
  }

  function ensureEpisode(userText?: string): EpisodeInFlight {
    if (!episode) {
      const sig = userText
        ? extractTaskSignature(userText, cmd.cwd)
        : `${path.basename(cmd.cwd)}:session`;
      episode = {
        task_signature: sig,
        files: new Set(),
        tools: new Set(),
        verify: new Set(),
        user_corrections: [],
        subagents: new Set(),
        skill_used: null,
        failures: 0,
        model: modelName || 'unknown',
        draftCreated: false,
        distilled: false,
      };
    }
    return episode;
  }

  function flushEpisode(outcome: string): Episode | null {
    if (!episode) return null;
    // Skip duplicate: same signature + outcome as the very last episode line
    const lines = readEpisodeLines();
    const last = lines[lines.length - 1];
    if (last && !isTombstone(last.data)) {
      const sig = typeof last.data.task_signature === 'string' ? last.data.task_signature : '';
      if (sig === episode.task_signature && String(last.data.outcome) === outcome) {
        return null;
      }
    }
    const ep: Episode = {
      task_signature: episode.task_signature,
      files: Array.from(episode.files).slice(0, 30),
      tools: Array.from(episode.tools),
      verify: Array.from(episode.verify),
      outcome,
      user_corrections: episode.user_corrections.slice(-10),
      subagents: Array.from(episode.subagents),
      skill_used: episode.skill_used,
      model: episode.model,
      confidence: 0.0,
      ts: sessionStart,
      distilled: episode.distilled,
    };
    appendEpisode(ep);
    return ep;
  }

  // ── Recall: search artifacts, inject via transformContext ───────────────
  function buildRecallBlock(userText: string): string | null {
    const queryKeys = extractKeywords(userText);
    if (queryKeys.length < 2) return null;
    const threshold = numFlag('ll-recall-threshold', 0.3);
    const maxItems = Math.round(numFlag('ll-max-recall-items', 6));

    const index = loadIndex();
    const matches: {score: number; kind: string; label: string; detail: string}[] = [];

    for (const [id, art] of Object.entries(index.artifacts)) {
      if (art.status !== 'active' && art.status !== 'shadow') continue;
      const artKeys = extractKeywords((art.description || '') + ' ' + (art.tags || []).join(' '));
      const score = scoreMatch(queryKeys, artKeys);
      if (score < threshold) continue;

      const badge = art.status === 'shadow' ? '[shadow]' : '';
      const green = art.green > 0 ? ` · ${art.green} green` : '';
      const red = art.red > 0 ? ` · ${art.red} red` : '';
      const kindLabel = art.kind === 'warning' ? '⚠ Warning' :
        art.kind === 'taste' ? '🎯 Taste' :
        art.kind === 'guard' ? '🛡 Guard' : '📋 Skill';

      matches.push({
        score, kind: art.kind, label: id,
        detail: `${kindLabel} ${badge}: ${(art.description || '').slice(0, 120)}${green}${red}`,
      });
      recalledThisRun.add(id);
    }

    matches.sort((a, b) => b.score - a.score);
    const top = matches.slice(0, maxItems);
    if (top.length === 0) return null;

    const lines = ['\n[learned-patterns] Prior workflow patterns (leads — verify before acting):'];
    for (const m of top) {
      lines.push(`- ${m.detail}`);
    }
    return lines.join('\n');
  }

  // ── Hooks: transformContext (recall injection) ──────────────────────────
  cmd.hooks({
    transformContext: ({messages}) => {
      let lastUser = '';
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && typeof m === 'object' && (m as Record<string, unknown>).role === 'user') {
          const content = (m as Record<string, unknown>).content;
          if (typeof content === 'string') { lastUser = content; break; }
          if (Array.isArray(content)) {
            const textParts = content
              .filter((p: unknown) => typeof p === 'object' && p !== null &&
                (p as Record<string, unknown>).type === 'text')
              .map((p: unknown) => String((p as Record<string, unknown>).text || ''));
            lastUser = textParts.join(' ');
            if (lastUser) break;
          }
        }
      }

      if (!lastUser || lastUser.length < 5) return messages;

      if (!episode) {
        ensureEpisode(lastUser);
      }

      const block = buildRecallBlock(lastUser);
      if (!block) return messages;

      // Array content blocks — the harness's wire projection assumes
      // message.content is always an array; string content crashes it.
      const recallMsg = {role: 'user', content: [{type: 'text', text: block}]};
      // Insert directly before the final user message (cache-optimal tail
      // position): only the last array entry falls outside the cached
      // prefix, instead of the last two from a length-2 splice.
      const insertIdx = Math.max(0, messages.length - 1);
      const result = [...messages];
      result.splice(insertIdx, 0, recallMsg as never);
      return result;
    },
  });

  // ── Hooks: transformInput (detect user corrections) ─────────────────────
  cmd.hooks({
    transformInput: ({text}) => {
      const lower = text.toLowerCase();

      // Usage signal 3: explicit skill references in user text.
      // The harness emits skill_loaded for inferred activations, but an
      // explicit slash reference can be missed when an inferred expansion
      // already matched, so count it directly. Handles /name and the
      // namespaced /skill:name (or /skill name) forms.
      const found = new Set<string>();
      for (const m of text.matchAll(/(?:^|\s)\/([a-z0-9][a-z0-9-]{0,62})\b/g)) {
        found.add(m[1]);
      }
      const nsMatch = text.match(/(?:^|\s)\/skill\s*[:：]\s*([a-z0-9][a-z0-9-]{0,62})\b/i);
      if (nsMatch) { found.delete('skill'); found.add(nsMatch[1]); }
      for (const name of found) recordSkillUse(name, 'slash-reference');

      const correctionSignals = [
        /no[,.\s]+\w+ly\s+/i, /don'?t\s+\w+/i, /never\s+\w+/i,
        /instead[,.\s]+/i, /prefer\s+/i, /always\s+\w+/i,
        /wrong[,.\s]+/i, /incorrect/i, /shouldn'?t/i,
        /do it (differently|like this)/i, /not like that/i,
        /that'?s not (what|how|right)/i,
      ];
      const isCorrection = correctionSignals.some(r => r.test(lower));

      if (isCorrection && episode) {
        const clean = text.slice(0, 200).replace(/\n/g, ' ');
        episode.user_corrections.push(clean);

        // 3+ corrections on the same pattern → auto-draft a candidate.
        // Correction signal is real evidence: draft straight to shadow.
        if (episode.user_corrections.length >= 3 && !episode.draftCreated) {
          episode.draftCreated = true;
          const sig = slugify(episode.task_signature.split(':').slice(1).join('-'));
          const joined = episode.user_corrections.map(c => `- ${c}`).join('\n');

          // Kind heuristic: corrections about build/test/tool/workflow → skill;
          // style/approach language → taste (the old behavior).
          const styleWords = /\b(prefer|always|never|instead|shouldn'?t|like this|that way|this way)\b/i;
          const workflowWords = /\b(test|build|command|tool|script|run|compile|deploy|setup|config|steps?)\b/i;
          const kind: Artifact['kind'] =
            workflowWords.test(joined) && !styleWords.test(joined) ? 'skill' : 'taste';
          const candidateId = `${kind}-${sig}`;
          const idx = loadIndex();

          if (!idx.artifacts[candidateId]) {
            const content = kind === 'skill'
              ? `# ${sig || 'Learned workflow'} (auto-drafted)\n\n## When to use\n${episode.user_corrections[episode.user_corrections.length - 1].slice(0, 200)}\n\n## Steps\n${joined}\n`
              : '# Taste rule (auto-drafted)\n\n' + joined + '\n';
            const art: Artifact = {
              kind,
              status: 'shadow',
              path: `candidates/${candidateId}`,
              scope: 'user',
              tags: extractKeywords(episode.task_signature),
              description: `User correction pattern: ${episode.user_corrections[episode.user_corrections.length - 1].slice(0, 80)}`,
              confidence: 0.1,
              shadow_runs: 1,
              green: 1,
              red: 0,
              rejections: 0,
              episodes: [],
              created: new Date().toISOString(),
              last_verified: '',
              last_used: '',
              pinned: false,
            };
            ensureDir(path.join(CANDIDATES_DIR, candidateId));
            fs.writeFileSync(path.join(CANDIDATES_DIR, candidateId, kind === 'skill' ? 'skill.md' : 'taste.md'), content);
            idx.artifacts[candidateId] = art;
            saveIndex(idx);
            cmd.ui.setStatus(buildStatus());
            writeReceipt({
              action: 'seed',
              id: candidateId,
              kind,
              reason: '3+ user corrections in session',
              evidence: {corrections: episode.user_corrections.length},
            });
          }
          cmd.ui.notify(
            `I've noticed you correct this pattern often. Drafting a ${kind} ` +
            `candidate (shadowed): ${candidateId}.`,
          );
        }
      }
      return {action: 'continue'};
    },
  });

  // ── Observer: event recording ───────────────────────────────────────────
  // tool_queued carries the ORIGINAL input; tool_completed does not carry input.
  cmd.on('tool_queued', event => {
    if (event.type !== 'tool_queued') return;
    const ep = ensureEpisode();
    const name = typeof event.toolName === 'string' ? event.toolName : '';
    ep.tools.add(name);
    toolIterations++;

    const input = (event as Record<string, unknown>).input;
    const fp = extractFilePath(input);
    if (fp) ep.files.add(fp);

    // Detect verification commands from the queued input. Explicit runner
    // names only — avoid \btest\b matching "latest" or prose.
    const cmdText = extractCmd(input);
    if (/\b(npm|pnpm|yarn|bun|npx|cargo|make|dotnet|go)\b[^\n]*\b(test|check|typecheck|lint)\b/i.test(cmdText) ||
        /\b(pytest|vitest|jest|mocha|ava|playwright|cypress|tsc|eslint)\b/.test(cmdText)) {
      ep.verify.add(cmdText.slice(0, 120));
    }
  });

  cmd.on('tool_errored', event => {
    if (event.type !== 'tool_errored') return;
    const ep = ensureEpisode();
    ep.failures++;
    const name = typeof event.toolName === 'string' ? event.toolName : '';
    ep.tools.add(name);
    toolIterations++;
  });

  cmd.on('subagent_start', event => {
    if (event.type !== 'subagent_start') return;
    const ep = ensureEpisode();
    ep.subagents.add(String((event as Record<string, unknown>).subagentType || 'unknown'));
  });

  cmd.on('subagent_stop', event => {
    if (event.type !== 'subagent_stop') return;
    const ep = ensureEpisode();
    ep.subagents.add(String((event as Record<string, unknown>).subagentType || 'unknown'));
  });

  cmd.on('subagent_progress', event => {
    if (event.type !== 'subagent_progress') return;
    const ep = ensureEpisode();
    const name = String((event as Record<string, unknown>).toolName || '');
    ep.tools.add(`agent:${name}`);
  });

  cmd.on('skill_loaded', event => {
    if (event.type !== 'skill_loaded') return;
    const name = String((event as Record<string, unknown>).name || '');
    const ep = ensureEpisode();
    ep.skill_used = name;
    recordSkillUse(name, 'skill_loaded');
  });

  // ── Usage tracking: multiple signals feed last_used/use_count ─────────────
  // skill_loaded (harness event, fires on inferred/expansion activation),
  // activate_skill tool calls (the model explicitly activating a skill), and
  // explicit /skill-name references in user text. A skill only decays if
  // NONE of these signals fired within the decay window.
  function recordSkillUse(name: string, source: string): void {
    if (!name || !isManagedSkillDir(name)) return;
    withLock('index', () => {
      const idx = loadIndex();
      const art = idx.artifacts[name];
      if (art && art.kind === 'skill' && art.status === 'active') {
        art.last_used = new Date().toISOString();
        art.use_count = (art.use_count ?? 0) + 1;
        activeSkillsUsedThisRun.add(name);
        saveIndex(idx);
        if (boolFlag('ll-usage-receipts', false)) {
          writeReceipt({action: 'skill-use', id: name, source});
        }
      }
    });
  }

  cmd.on('model_request_start', event => {
    if (event.type !== 'model_request_start') return;
    modelName = String((event as Record<string, unknown>).model || modelName);
    if (episode) episode.model = modelName;
  });

  // ── Decay: archive stale active artifacts ───────────────────────────────
  function applyDecay(): void {
    const days = numFlag('ll-decay-days', 90, 1);
    if (days <= 0) return;
    const cutoff = Date.now() - days * 86400000;
    withLock('index', () => {
      const idx = loadIndex();
      let changed = false;
      for (const [id, art] of Object.entries(idx.artifacts)) {
        if (art.status !== 'active' || art.pinned) continue;
        // Never-used skills age from creation, not last_used — otherwise they
        // are accidentally immortal.
        const lastActivity = art.last_used || art.created;
        if (!lastActivity) continue;
        if (Date.parse(lastActivity) < cutoff) {
          art.status = 'archived';
          art.rejection_reason = `decay: unused for ${days}d`;
          // Archived skills leave .agents/skills/ — they are no longer live.
          if (art.kind === 'skill') {
            const rmErr = removeSkillFile(id);
            if (!rmErr) writeReceipt({action: 'archive', id, reason: 'decay', days});
          }
          changed = true;
        }
      }
      if (changed) saveIndex(idx);
    });
  }

  // ── Deletion: purge archived artifacts after the deletion window ─────────
  function applyDeletion(): void {
    const days = numFlag('ll-auto-delete-days', 180);
    if (days <= 0) return;
    const cutoff = Date.now() - days * 86400000;
    withLock('index', () => {
      const idx = loadIndex();
      const toDelete: {id: string; art: Artifact}[] = [];

      for (const [id, art] of Object.entries(idx.artifacts)) {
        if (art.pinned) continue;
        if (art.status !== 'archived') continue;
        // Age from last_used when known, else from creation — never skip
        // never-used artifacts.
        const lastActivity = art.last_used || art.created;
        if (!lastActivity) continue;
        if (Date.parse(lastActivity) < cutoff) {
          toDelete.push({id, art});
        }
      }

      for (const {id, art} of toDelete) {
        // Foreign guard: only remove live dirs we own.
        if (art.kind === 'skill') {
          const rmErr = removeSkillFile(id);
          if (rmErr) continue;  // never delete a foreign dir
        }
        // Move the learning-store content to the graveyard for final rollback.
        const srcDir = path.join(LEARNING_DIR, art.path);
        if (fs.existsSync(srcDir)) {
          const graveRel = path.join('graveyard', id, `deleted-${Date.now().toString(36)}`)
            .split(path.sep).join('/');
          moveDir(srcDir, path.join(LEARNING_DIR, graveRel));
        }
        delete idx.artifacts[id];
        writeReceipt({
          action: 'delete-unused',
          id,
          reason: `archived and unused for ${days}d`,
          evidence: {last_used: art.last_used, use_count: art.use_count},
        });
      }

      if (toDelete.length > 0) {
        saveIndex(idx);
        cmd.ui.setStatus(buildStatus());
      }
    });
  }

  // ── Prune: graveyard stale candidates and failed shadows ────────────────
  function applyPruning(): void {
    const ttlDays = numFlag('ll-candidate-ttl-days', 30, 1);
    const now = Date.now();
    withLock('index', () => {
      const idx = loadIndex();
      const toPrune: {id: string; art: Artifact; reason: string}[] = [];

      for (const [id, art] of Object.entries(idx.artifacts)) {
        if (art.pinned) continue;
        if (art.status === 'candidate' && art.shadow_runs === 0) {
          const created = Date.parse(art.created);
          if (Number.isFinite(created) && now - created > ttlDays * 86400000) {
            toPrune.push({id, art, reason: 'stale'});
          }
        } else if (art.status === 'shadow' && art.red > art.green && art.red >= 3) {
          toPrune.push({id, art, reason: 'failed shadow trials'});
        }
      }

      for (const {id, art, reason} of toPrune) {
        const graveRel = path.join('graveyard', id, Date.now().toString(36))
          .split(path.sep).join('/');
        const srcDir = path.join(LEARNING_DIR, art.path);
        if (fs.existsSync(srcDir)) {
          moveDir(srcDir, path.join(LEARNING_DIR, graveRel));
        }
        art.status = 'rejected';
        art.rejection_reason = `pruned: ${reason}`;
        art.path = graveRel;
        writeReceipt({
          action: `prune-${reason === 'stale' ? 'stale' : 'failed'}`,
          id,
          reason,
          evidence: {created: art.created, shadow_runs: art.shadow_runs, green: art.green, red: art.red},
        });
      }

    if (toPrune.length > 0) {
      saveIndex(idx);
      cmd.ui.setStatus(buildStatus());
    }
    });
  }

  // ── Merge: consolidate overlapping learned skills ────────────────────────
  // Deterministic similarity: tag overlap + normalized title word overlap +
  // content term overlap. Conservative: pinned artifacts never participate,
  // results above the line cap are refused, and the absorbed artifact is
  // graveyarded (rollback-able) rather than deleted.

  function tokenSet(text: string): Set<string> {
    return new Set(
      text.toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ').split(/\s+/)
        .filter(w => w.length > 2 && !STOPWORDS.has(w)),
    );
  }

  function mergeSimilarity(a: Artifact, b: Artifact): number {
    const aFile = resolveArtifactFile(a);
    const bFile = resolveArtifactFile(b);
    const aContent = aFile ? skillBodyOnly(fs.readFileSync(aFile, 'utf-8')) : '';
    const bContent = bFile ? skillBodyOnly(fs.readFileSync(bFile, 'utf-8')) : '';

    const aTags = new Set(a.tags.map(t => t.toLowerCase()));
    const bTags = new Set(b.tags.map(t => t.toLowerCase()));
    const tagOverlap = aTags.size + bTags.size > 0
      ? [...aTags].filter(t => bTags.has(t)).length / Math.max(aTags.size, bTags.size)
      : 0;

    const aTitle = tokenSet(a.path.split('/').pop() || '');
    const bTitle = tokenSet(b.path.split('/').pop() || '');
    const titleOverlap = aTitle.size + bTitle.size > 0
      ? [...aTitle].filter(t => bTitle.has(t)).length / Math.max(aTitle.size, bTitle.size)
      : 0;

    const aTerms = tokenSet(aContent);
    const bTerms = tokenSet(bContent);
    const termOverlap = aTerms.size + bTerms.size > 0
      ? [...aTerms].filter(t => bTerms.has(t)).length / Math.max(aTerms.size, bTerms.size)
      : 0;

    return 0.4 * tagOverlap + 0.2 * titleOverlap + 0.4 * termOverlap;
  }

  function mergeArtifacts(keepId: string, absorbId: string, automatic: boolean): {ok: boolean; error?: string} {
    // Locked: merge moves directories and rewrites the index — two parallel
    // sessions merging at once would corrupt paths (index pointing at
    // graveyarded dirs). Under contention, fail clean and let the caller retry.
    const res = withLock('index', () => mergeArtifactsInner(keepId, absorbId, automatic));
    return res ?? {ok: false, error: 'learning store is busy (another session is writing) — retry'};
  }

  function mergeArtifactsInner(keepId: string, absorbId: string, automatic: boolean): {ok: boolean; error?: string} {
    const idx = loadIndex();
    const keep = idx.artifacts[keepId];
    const absorb = idx.artifacts[absorbId];
    if (!keep || !absorb) return {ok: false, error: 'one or both artifacts not found'};
    if (keep.kind !== absorb.kind) return {ok: false, error: 'cannot merge different artifact kinds'};
    if (keep.pinned || absorb.pinned) return {ok: false, error: 'pinned artifacts never participate in merges'};
    if (keep.status !== 'active' || absorb.status !== 'active') {
      return {ok: false, error: 'both artifacts must be active to merge'};
    }

    const keepFile = resolveArtifactFile(keep);
    const absorbFile = resolveArtifactFile(absorb);
    if (!keepFile || !absorbFile) return {ok: false, error: 'artifact files missing'};

    // Foreign-skill guard: a live dir we don't own must never be merged into.
    const foreignErr = foreignSkillConflict(keepId) || foreignSkillConflict(absorbId);
    if (foreignErr) return {ok: false, error: foreignErr};

    const keepBody = skillBodyOnly(fs.readFileSync(keepFile, 'utf-8'));
    const absorbBody = skillBodyOnly(fs.readFileSync(absorbFile, 'utf-8'));
    const absorbUnique = tokenSet(absorbBody);
    const keepTerms = tokenSet(keepBody);
    const uniqueContent = absorbBody
      .split(/\n(?=##\s)/)  // split into section blocks
      .filter(block => {
        const terms = tokenSet(block);
        const overlap = [...terms].filter(t => keepTerms.has(t)).length / Math.max(terms.size, 1);
        return overlap < 0.5;  // keep only genuinely novel sections
      })
      .join('\n\n')
      .trim();

    const mergedBody = uniqueContent
      ? `${keepBody}\n\n## From merged skill: ${absorbId}\n${uniqueContent}`
      : keepBody;
    if (mergedBody.split('\n').length > numFlag('ll-max-skill-lines', 300)) {
      return {ok: false, error: `merged body would exceed ${numFlag('ll-max-skill-lines', 300)} lines`};
    }

    // Graveyard the survivor's pre-merge state (rollback safety) and the absorbed artifact.
    const stamp = Date.now().toString(36);
    const keepDir = path.join(LEARNING_DIR, keep.path);
    if (fs.existsSync(keepDir)) {
      const backupRel = path.join('graveyard', keepId, `pre-merge-${stamp}`).split(path.sep).join('/');
      ensureDir(path.dirname(path.join(LEARNING_DIR, backupRel)));
      // Copy, not move: the survivor stays in place so its supporting files
      // (references/, scripts/) keep their live layout.
      fs.cpSync(keepDir, path.join(LEARNING_DIR, backupRel), {recursive: true});
    }
    const absorbDir = path.join(LEARNING_DIR, absorb.path);
    if (fs.existsSync(absorbDir)) {
      const graveRel = path.join('graveyard', absorbId, `merged-${stamp}`).split(path.sep).join('/');
      moveDir(absorbDir, path.join(LEARNING_DIR, graveRel));
      absorb.path = graveRel;
    }
    absorb.status = 'archived';
    absorb.rejection_reason = `merged into ${keepId}`;

    // Rewrite the survivor's main file IN PLACE — path, kind layout, and
    // supporting files all stay exactly where they were.
    fs.writeFileSync(keepFile, mergedBody);
    keep.version = (keep.version ?? 0) + 1;
    keep.use_count = (keep.use_count ?? 0) + (absorb.use_count ?? 0);
    keep.tags = [...new Set([...keep.tags, ...absorb.tags])];

    // Re-sync the live install so the merged content is what agents load.
    const syncErr = syncInstalledSkill(keep);

    // Persist no matter what: an early return here would leave the index
    // pointing at directories that were already moved into the graveyard.
    saveIndex(idx);
    writeReceipt({
      action: 'merge',
      automatic,
      keep: keepId,
      absorb: absorbId,
      similarity: mergeSimilarity(keep, absorb),
      version: keep.version,
      ...(syncErr ? {syncError: syncErr} : {}),
    });
    cmd.ui.setStatus(buildStatus());
    return syncErr
      ? {ok: false, error: `merge recorded, but live sync failed: ${syncErr}`}
      : {ok: true};
  }

  // ── Merge proposals: mechanical pre-filter + agent judgment ──────────────
  // mergeSimilarity is only a candidate finder. The actual merge decision is
  // a judgment call: the agent reads both full skills and decides merge /
  // dismiss / ask. Dismissals persist (with a TTL) so a judged-dead pair is
  // not re-proposed every run.
  function findMergeProposals(): {keep: string; absorb: string; sim: number}[] {
    const threshold = numFlag('ll-merge-threshold', 0.6);
    const maxPairs = Math.round(numFlag('ll-merge-proposals', 2));
    const idx = loadIndex();
    const actives = Object.entries(idx.artifacts).filter(
      ([, a]) => a.status === 'active' && a.kind === 'skill' && !a.pinned,
    );
    const pairs: {keep: string; absorb: string; sim: number}[] = [];
    for (let i = 0; i < actives.length; i++) {
      for (let j = i + 1; j < actives.length; j++) {
        const [idA, artA] = actives[i];
        const [idB, artB] = actives[j];
        if (isMergeDismissed(idA, idB)) continue;
        if (mergeReviewedThisRun.has(pairKey(idA, idB))) continue;
        const sim = mergeSimilarity(artA, artB);
        if (sim >= threshold) {
          const keep = (artA.use_count ?? 0) >= (artB.use_count ?? 0) ? idA : idB;
          const absorb = keep === idA ? idB : idA;
          pairs.push({keep, absorb, sim});
        }
      }
    }
    pairs.sort((a, b) => b.sim - a.sim);
    return pairs.slice(0, maxPairs);
  }

  function pairKey(a: string, b: string): string {
    return [a, b].sort().join('|');
  }

  function isMergeDismissed(a: string, b: string): boolean {
    const ttl = numFlag('ll-merge-dismiss-ttl-days', 30) * 86400000;
    const key = pairKey(a, b);
    const ts = mergeDismissals[key];
    return ts !== undefined && Date.now() - ts < ttl;
  }

  function dismissMergePair(a: string, b: string): void {
    mergeDismissals[pairKey(a, b)] = Date.now();
    try {
      fs.writeFileSync(MERGE_DISMISSALS_FILE, JSON.stringify(mergeDismissals, null, 2));
    } catch { /* best-effort */ }
  }

  function buildMergeReviewPrompt(pairs: {keep: string; absorb: string; sim: number}[]): string {
    return [
      'MERGE REVIEW — pairs of learned skills overlap mechanically. Your judgment call.',
      'Read BOTH full skill bodies for each pair before deciding (find each artifact\'s path via /learn status, then read_file its main file under .agents/learning/).',
      '',
      ...pairs.map((p, i) => `${i + 1}. ${p.keep} + ${p.absorb} (mechanical similarity ${p.sim.toFixed(2)})`),
      '',
      'For each pair, decide exactly one:',
      '  merge   — same job, better as one coherent skill. Call learning_manage with action "merge", keep + absorb ids. Survivor = the more-used skill, unless the less-used one has a clearly better name.',
      '  dismiss — same vocabulary, different jobs. Run /merge-dismiss <idA> <idB>; the pair will not be re-proposed for the TTL window.',
      '  ask     — genuinely uncertain. Do nothing except state your one-line recommendation to the user.',
      '',
      'If unsure: prefer dismiss over merge, and ask over both. Distinctive skills are never merge candidates regardless of token overlap.',
      'Finish with one short line naming your decisions, e.g. "learn-loop: merged A+B, dismissed C+D".',
    ].join('\n');
  }

  // ── Hooks: onRunEnd (flush episode, decay, prune) ───────────────────────
  cmd.hooks({
    onRunEnd: async () => {
      // Determine outcome
      let outcome = 'completed';
      if (episode) {
        if (episode.failures > 0 && episode.user_corrections.length > 0) {
          outcome = 'green_after_corrections';
        } else if (episode.failures > 0) {
          outcome = 'completed_with_failures';
        } else if (episode.verify.size > 0) {
          outcome = 'green';
        }
      }

      flushEpisode(outcome);
      applyDecay();
      applyPruning();
      applyDeletion();
      mergeReviewedThisRun.clear();

      resetEpisode();
    },
  });

  // ── Distillation prompt (shared by /learn and the autonomous turn) ──────
  function buildDistillPrompt(patchTarget?: string): string {
    return patchTarget
      ? `Review the conversation and update the existing artifact "${patchTarget}" with new evidence, pitfalls, or refinements. Prefer targeted patches — use learning_manage with action "patch" (token-efficient: only the changed text), or action "edit" for major rewrites. If this session exposed a failure mode the artifact does not cover, add it to its Pitfalls section and note the fix that worked.`
      : [
        'Review the recent conversation and identify any reusable patterns worth capturing as skills, taste rules, or warnings.',
        'Use learning_manage to create candidates. Prefer patching existing artifacts over creating new ones.',
        'Refer to the review policy: capture non-trivial workflows (5+ tool calls), user corrections, error recovery patterns. Do NOT capture missing binaries, transient failures, or one-off narratives.',
        'New candidates you create land as candidates, not shadows — they must earn shadow status by proving themselves, unless this session already produced direct evidence for them (then use learning_manage action "shadow" on them).',
        '',
        'IMPORTANT for kind=skill candidates: the content field must be a complete SKILL.md body following the house structure:',
        '  # <Title>',
        '  ## When to Use — trigger conditions',
        '  ## Procedure — step-by-step, most common path first',
        '  ## Pitfalls — known failure modes and their fixes',
        '  ## Verification — how to confirm it worked',
        'Keep the description ≤60 characters. Put supporting material (examples, docs) in separate files via learning_manage action "write_file" (e.g. "references/examples.md") — not inline in the main body.',
        'The mod wraps the body with frontmatter on /promote and installs it to .agents/skills/ where Command Code loads it as a real skill.',
        '',
        'If the session hit errors or dead ends before finding the working path, capture the recovery sequence — that is the highest-value content.',
        ...(activeSkillsUsedThisRun.size > 0 && (episode?.failures ?? 0) > 0
          ? [
              '',
              `REFINEMENT TARGETS: these learned skills were used this session AND the session hit failures: ${[...activeSkillsUsedThisRun].join(', ')}. Patch them via learning_manage action "patch" with the failure modes you hit and the fixes that worked — refinement-on-use is the highest-value update.`,
            ]
          : []),
        '',
        'Finish your turn with one short line stating exactly which artifacts you created or patched (e.g. "learn-loop: patched skill auth-debugging").',
      ].join('\n');
  }

  // ── The autonomous distillation turn: onStop continuation ───────────────
  cmd.hooks({
    onStop: async ({stopReason}) => {
      // A user interrupt is an explicit abort: no merge review or
      // distillation over it.
      if (stopReason === 'interrupted') return undefined;

      // ── Merge review: agent judgment, never mechanical merges ─────────────
      // Runs as a stop continuation. The similarity score only *proposes*
      // pairs; the agent reads both full skills and decides merge/dismiss/ask.
      if (boolFlag('ll-auto-merge', true)) {
        const pairs = findMergeProposals();
        if (pairs.length > 0) {
          for (const p of pairs) mergeReviewedThisRun.add(pairKey(p.keep, p.absorb));
          writeReceipt({
            action: 'merge-review',
            pairs: pairs.map(p => ({keep: p.keep, absorb: p.absorb, sim: p.sim})),
          });
          return {continue: true, reason: buildMergeReviewPrompt(pairs)};
        }
      }

      if (!boolFlag('ll-auto-distill', true)) return undefined;
      const maxDistills = Math.round(numFlag('ll-max-distills', 1));
      if (distillsThisRun >= maxDistills) return undefined;
      if (!episode || episode.distilled) return undefined;

      // Signal-rich gate: corrections are the strongest signal; error
      // recovery (failures that were eventually worked through) is the
      // highest-value capture; verify activity plus a substantial tool
      // count is the weaker trigger.
      const minTools = Math.round(numFlag('ll-distill-min-tools', 8));
      const signalRich =
        episode.user_corrections.length >= 1 ||
        episode.failures >= 2 ||
        (episode.verify.size > 0 && toolIterations >= minTools);
      if (!signalRich) return undefined;

      episode.distilled = true;
      distillsThisRun += 1;
      writeReceipt({
        action: 'distill',
        reason: episode.user_corrections.length >= 1
          ? 'user corrections present'
          : episode.failures >= 2
            ? 'error recovery pattern'
            : 'verify activity + tool count',
        evidence: {
          corrections: episode.user_corrections.length,
          failures: episode.failures,
          verify: episode.verify.size,
          toolIterations,
        },
      });

      return {continue: true, reason: buildDistillPrompt()};
    },
  });

  // ── Autonomous promotion: verified verdicts promote qualified shadows ──
  cmd.events.on('self-repair/verdict', (raw) => {
    if (!boolFlag('ll-auto-promote', true)) return;
    const v = (raw ?? {}) as Record<string, unknown>;
    if (v.final !== true || v.complete !== true) return;
    if (typeof v.version === 'number' && v.version < 2) return;

    const idx = loadIndex();
    const minRuns = Math.round(numFlag('ll-min-shadow-runs', 2));
    const promoted: {id: string; runs: number; green: number; red: number}[] = [];

    for (const [id, art] of Object.entries(idx.artifacts)) {
      if (art.status !== 'shadow') continue;
      if (art.pinned) continue;
      if (art.shadow_runs < minRuns) continue;
      if (art.red > art.green) continue;
      if (art.rejections > 0) continue;
      const res = promoteArtifact(id, {
        autonomous: true,
        cycleId: String(v.cycleId ?? ''),
      });
      if (res.ok) {
        promoted.push({id, runs: art.shadow_runs, green: art.green, red: art.red});
      }
    }

    if (promoted.length > 0) {
      const summary = promoted
        .map(p => `  - ${p.id} (${p.runs} runs, ${p.green} green${p.red > 0 ? `, ${p.red} red` : ''})`)
        .join('\n');
      cmd.ui.notify(`learn-loop: auto-promoted verified shadows:\n${summary}`);
    }
  });

  // ── Memory-bank graduation: learn-loop is the single skill manager ──────
  // memory-bank emits a lesson it wants turned into a loadable skill; here it
  // becomes a normal learn-loop artifact (candidate → shadow → active) and is
  // then subject to the same usage/merge/decay lifecycle as everything else.
  cmd.events.on('memory-bank/graduate', (raw) => {
    if (!boolFlag('ll-auto-promote', true)) return;
    const g = (raw ?? {}) as Record<string, unknown>;
    const title = String(g.title ?? '');
    const domain = String(g.domain ?? '');
    const source = String(g.source ?? '');
    const what = String(g.what ?? '');
    const why = String(g.why ?? '');
    const skillName = String(g.skillName ?? slugify(`${domain} ${title}`));

    if (!title || !what) return;

    const body = [
      `# ${title}`,
      '',
      '## When to Use',
      what,
      '',
      '## Why',
      why || `Graduated from project memory (domain: ${domain}, source: ${source}).`,
    ].join('\n');

    // Prefer patching an existing artifact; otherwise create a fresh candidate.
    const idx = loadIndex();
    let art = idx.artifacts[skillName];
    if (art) {
      if (art.kind !== 'skill') {
        art = undefined;
      } else {
        const file = resolveArtifactFile(art);
        if (!file) return;
        fs.writeFileSync(file, body);
        art.description = title.slice(0, 60);
        art.tags = [...new Set([...(art.tags || []), domain, ...extractKeywords(title)])];
        art.last_verified = new Date().toISOString();
        art.version = (art.version ?? 0) + 1;
        art.confidence = Math.max(art.confidence, 0.3);
        saveIndex(idx);
        if (art.status === 'active') syncInstalledSkill(art);
        else {
          // Memory graduation is verified evidence — promote straight through.
          art.status = 'active';
          const oldPath = art.path;
          const newRel = path.join('active', 'skill', skillName).split(path.sep).join('/');
          if (oldPath !== newRel) {
            moveDir(path.join(LEARNING_DIR, oldPath), path.join(LEARNING_DIR, newRel));
          }
          art.path = newRel;
          saveIndex(idx);
          syncInstalledSkill(art);
        }
        cmd.ui.setStatus(buildStatus());
        writeReceipt({
          action: 'memory-graduate-update',
          id: skillName,
          domain,
          source,
        });
        return;
      }
    }

    const safeName = slugify(skillName) || 'memory-skill';
    if (idx.artifacts[safeName]) {
      // Another artifact occupies the canonical name — re-point at it.
      art = idx.artifacts[safeName];
    }
    if (!art) {
      art = {
        kind: 'skill',
        status: 'active', // memory graduation already passed the write-bar
        path: `active/skill/${safeName}`,
        scope: 'project',
        tags: [domain, ...extractKeywords(title)],
        description: title.slice(0, 60),
        confidence: 0.5,
        shadow_runs: 0,
        green: 0,
        red: 0,
        rejections: 0,
        episodes: [],
        created: new Date().toISOString(),
        last_verified: new Date().toISOString(),
        last_used: '',
        pinned: false,
        version: 1,
        use_count: 0,
      };
      const artDir = path.join(LEARNING_DIR, art.path);
      ensureDir(artDir);
      fs.writeFileSync(path.join(artDir, 'skill.md'), body);
      idx.artifacts[safeName] = art;
    }
    saveIndex(idx);
    const syncErr = syncInstalledSkill(art);
    cmd.ui.setStatus(buildStatus());
    writeReceipt({
      action: 'memory-graduate',
      id: safeName,
      domain,
      source,
      skillErr: syncErr ?? null,
    });
    if (syncErr) {
      cmd.ui.notify(`learn-loop: memory graduation for "${safeName}" could not be installed: ${syncErr}`);
    }
  });

  // ── Hooks: onSessionStart / onSessionEnd ────────────────────────────────
  cmd.hooks({
    onSessionStart: () => {
      resetEpisode();
      cmd.ui.setStatus(buildStatus());
    },
    onSessionEnd: () => {
      cmd.ui.setStatus(null);
    },
  });

  // ── Footer status ───────────────────────────────────────────────────────
  function buildStatus(): string {
    const idx = loadIndex();
    const actives = Object.values(idx.artifacts).filter(a => a.status === 'active');
    const shadows = Object.values(idx.artifacts).filter(a => a.status === 'shadow');
    const candidates = Object.values(idx.artifacts).filter(
      a => a.status === 'candidate',
    );
    const skills = actives.filter(a => a.kind === 'skill').length;
    const taste = actives.filter(a => a.kind === 'taste').length;
    const warnings = actives.filter(a => a.kind === 'warning').length;
    const auto = boolFlag('ll-auto-distill', true) || boolFlag('ll-auto-promote', true) ? 'auto ✓' : 'auto ✗';

    return `learning: ${auto} · ${idx.episode_count} eps · ${candidates.length} cand · ${shadows.length} shadow · ${skills}s/${taste}t/${warnings}w`;
  }

  // ── Slash commands ──────────────────────────────────────────────────────

  cmd.addCommand({
    name: 'learn',
    description: 'Trigger a distillation turn to create/patch skills from recent episodes',
    argumentHint: '[--patch <name> | pending | approve <id> | reject <id> | status]',
    handler: ({args}) => {
      // Write-approval subcommands
      const pendingMatch = args.match(/^\s*(pending)\s*$/i);
      const approveMatch = args.match(/^\s*approve\s+(\S+)/i);
      const rejectMatch = args.match(/^\s*reject\s+(\S+)/i);

      const pendingDir = path.join(LEARNING_DIR, 'pending');
      if (pendingMatch) {
        if (!fs.existsSync(pendingDir)) {
          return {message: 'No pending skill writes (write-approval is off or nothing staged).'};
        }
        const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json')).sort();
        if (files.length === 0) return {message: 'No pending skill writes.'};
        const lines = files.map(f => {
          const id = f.replace(/\.json$/, '');
          try {
            const inp = JSON.parse(fs.readFileSync(path.join(pendingDir, f), 'utf-8'));
            const summary = String(inp.content ?? '').split('\n')[0].slice(0, 80);
            return `${id}  ${String(inp.action)} ${String(inp.name ?? '')} — ${summary}`;
          } catch {
            return `${id}  (unreadable)`;
          }
        });
        return {message: 'Pending skill writes:\n' + lines.join('\n')};
      }

      if (approveMatch) {
        const id = approveMatch[1];
        const file = path.join(pendingDir, `${id}.json`);
        if (!fs.existsSync(file)) return {message: `Pending write "${id}" not found.`};
        const inp = JSON.parse(fs.readFileSync(file, 'utf-8'));
        fs.rmSync(file);
        writeReceipt({action: 'approved', pendingId: id});
        const res = executeManage(inp) as {ok: boolean; error?: string; content?: unknown};
        if (res.ok) {
          return {message: `Approved ${id}. ${JSON.stringify(res.content ?? '')}`};
        }
        return {message: `Approved ${id}, but execution failed: ${res.error ?? 'unknown error'}`};
      }

      if (rejectMatch) {
        const id = rejectMatch[1];
        const file = path.join(pendingDir, `${id}.json`);
        if (!fs.existsSync(file)) return {message: `Pending write "${id}" not found.`};
        fs.rmSync(file);
        writeReceipt({action: 'rejected', pendingId: id});
        return {message: `Rejected ${id}.`};
      }

      const patchTarget = args.match(/--patch\s+(\S+)/)?.[1];
      if (patchTarget) return {prompt: buildDistillPrompt(patchTarget)};

      // Lifecycle overview
      const statusMatch = args.match(/^\s*status\s*$/i);
      if (statusMatch) {
        const idx = loadIndex();
        const lines: string[] = [];
        for (const [id, art] of Object.entries(idx.artifacts)) {
          const icon = art.status === 'active' ? '●' :
            art.status === 'shadow' ? '◐' :
            art.status === 'archived' ? '✕' :
            art.status === 'rejected' ? '✗' : '○';
          lines.push(`${icon} [${art.kind}] ${id} — ${art.status} · v${art.version ?? 0} · uses ${art.use_count ?? 0} · last ${art.last_used ? art.last_used.slice(0, 10) : 'never'}${art.pinned ? ' · pinned' : ''}`);
        }
        const lines2 = lines.length > 0 ? lines : ['No managed artifacts yet.'];

        // Foreign skills: user-installed, never managed
        const foreign: string[] = [];
        if (fs.existsSync(SKILLS_OUTPUT_DIR)) {
          for (const entry of fs.readdirSync(SKILLS_OUTPUT_DIR)) {
            const dir = path.join(SKILLS_OUTPUT_DIR, entry);
            if (fs.statSync(dir).isDirectory() && !isManagedSkillDir(entry)) {
              foreign.push(entry);
            }
          }
        }
        const foreignLine = foreign.length > 0
          ? '\nuser-installed (not managed): ' + foreign.join(', ')
          : '';

        // Merge proposals
        const actives = Object.entries(idx.artifacts).filter(([, a]) => a.status === 'active' && a.kind === 'skill' && !a.pinned);
        const proposals: string[] = [];
        for (let i = 0; i < actives.length; i++) {
          for (let j = i + 1; j < actives.length; j++) {
            const sim = mergeSimilarity(actives[i][1], actives[j][1]);
            if (sim >= numFlag('ll-merge-threshold', 0.6)) {
              proposals.push(`${actives[i][0]} + ${actives[j][0]} (similarity ${sim.toFixed(2)})`);
            }
          }
        }
        const proposalLine = proposals.length > 0
          ? '\nmerge candidates (mechanical pre-filter — the agent decides): ' + proposals.join(' · ')
          : '';

        return {message: `Managed artifacts (${Object.keys(idx.artifacts).length}):\n` + lines2.join('\n') + foreignLine + proposalLine};
      }

      return {prompt: buildDistillPrompt()};
    },
  });

  cmd.addCommand({
    name: 'recall',
    description: 'Search episodes, skills, taste, and warnings by keyword',
    argumentHint: '<query>',
    handler: ({args}) => {
      const query = args.trim();
      if (!query) return {message: 'Usage: /recall <query>'};

      const keys = extractKeywords(query);
      const idx = loadIndex();
      const lines: string[] = [];

      // Search artifacts
      for (const [id, art] of Object.entries(idx.artifacts)) {
        const artKeys = extractKeywords((art.description || '') + ' ' + (art.tags || []).join(' '));
        const score = scoreMatch(keys, artKeys);
        if (score < 0.2) continue;
        const statusIcon = art.status === 'active' ? '●' :
          art.status === 'shadow' ? '◐' :
          art.status === 'archived' ? '✕' :
          art.status === 'rejected' ? '✗' : '○';
        lines.push(`${statusIcon} [${art.kind}] ${id} — ${(art.description || '').slice(0, 100)}`);
      }

      // Search recent episodes (stable ids, skipping tombstones)
      const recent = readEpisodeLines()
        .filter(e => !isTombstone(e.data))
        .slice(-200)
        .reverse();
      for (const line of recent) {
        const data = line.data;
        const sig = typeof data.task_signature === 'string' ? data.task_signature : '';
        const epKeys = extractKeywords(sig);
        const score = scoreMatch(keys, epKeys);
        if (score < 0.2) continue;
        const outcome = typeof data.outcome === 'string' ? data.outcome : '';
        const ts = typeof data.ts === 'string' ? data.ts : '';
        const outcomeIcon = outcome.includes('green') ? '✓' : '✗';
        lines.push(`${outcomeIcon} ep#${line.id} ${sig} (${outcome}, ${ts.slice(0, 10)})`);
      }

      if (lines.length === 0) return {message: `No matches for "${query}".`};
      return {message: lines.slice(0, 20).join('\n')};
    },
  });

  cmd.addCommand({
    name: 'remember',
    description: 'Manually create an episode from a user observation',
    argumentHint: '<note>',
    handler: ({args}) => {
      const note = args.trim();
      if (!note) return {message: 'Usage: /remember <note>'};

      const ep: Episode = {
        task_signature: `user:${slugify(note)}`,
        files: [],
        tools: [],
        verify: [],
        outcome: 'user_observation',
        user_corrections: [note],
        subagents: [],
        skill_used: null,
        model: modelName || 'unknown',
        confidence: 1.0,
        ts: new Date().toISOString(),
      };
      appendEpisode(ep);
      return {message: `Recorded: "${note.slice(0, 100)}"`};
    },
  });

  cmd.addCommand({
    name: 'forget',
    description: 'Delete an episode (for incorrect recordings)',
    argumentHint: '<#id-or-signature>',
    handler: ({args}) => {
      const target = args.trim();
      if (!target) return {message: 'Usage: /forget <#id-or-signature>'};

      const lines = readEpisodeLines();
      let lineNo = -1;
      if (/^#?\d+$/.test(target)) {
        const n = parseInt(target.replace('#', ''), 10);
        const found = lines.find(e => e.id === n);
        if (found) lineNo = found.line;
      } else {
        const found = lines.find(e =>
          !isTombstone(e.data) &&
          String(e.data.task_signature || '').includes(target));
        if (found) lineNo = found.line;
      }

      if (lineNo < 0) return {message: `No episode matches "${target}".`};

      // Tombstone the line so later episode ids stay stable
      replaceEpisodeLine(lineNo, {
        _tombstone: true,
        _deleted: new Date().toISOString(),
        _target: target,
      });
      const deletedId = lines.find(e => e.line === lineNo)?.id;
      return {message: `Forgot episode #${deletedId ?? lineNo}.`};
    },
  });

  cmd.addCommand({
    name: 'pin',
    description: 'Protect an artifact from auto-decay/archival',
    argumentHint: '<artifact-id>',
    handler: ({args}) => {
      const id = args.trim();
      if (!id) return {message: 'Usage: /pin <artifact-id>'};
      const idx = loadIndex();
      const art = idx.artifacts[id];
      if (!art) return {message: `Artifact "${id}" not found.`};
      art.pinned = true;
      saveIndex(idx);
      return {message: `Pinned "${id}". Protected from auto-decay.`};
    },
  });

  cmd.addCommand({
    name: 'unpin',
    description: 'Remove decay protection from an artifact',
    argumentHint: '<artifact-id>',
    handler: ({args}) => {
      const id = args.trim();
      if (!id) return {message: 'Usage: /unpin <artifact-id>'};
      const idx = loadIndex();
      const art = idx.artifacts[id];
      if (!art) return {message: `Artifact "${id}" not found.`};
      art.pinned = false;
      saveIndex(idx);
      return {message: `Unpinned "${id}".`};
    },
  });

  cmd.addCommand({
    name: 'candidates',
    description: 'List all current candidates with status and evidence counts',
    handler: () => {
      const idx = loadIndex();
      const candidates = Object.entries(idx.artifacts)
        .filter(([, a]) => a.status === 'candidate' || a.status === 'shadow')
        .sort(([, a], [, b]) => b.confidence - a.confidence);

      if (candidates.length === 0) return {message: 'No candidates. Use /learn to create some.'};

      const lines = candidates.map(([id, a]) => {
        const bar = '█'.repeat(Math.round(a.confidence * 10)) +
          '░'.repeat(10 - Math.round(a.confidence * 10));
        return [
          `${a.status === 'shadow' ? '◐' : '○'} [${a.kind}] ${id}  ${bar} ${a.confidence.toFixed(2)}`,
          `   evidence: ${a.shadow_runs} runs · ${a.green} green · ${a.red} red · ${a.rejections} reject`,
          `   action: /promote ${id} | /shadow ${id} | /reject ${id}`,
        ].join('\n');
      });

      return {message: `Candidates (${candidates.length}):\n\n` + lines.join('\n\n')};
    },
  });

  cmd.addCommand({
    name: 'shadow',
    description: 'Move a candidate into shadow mode (influences context, tracks stats)',
    argumentHint: '<candidate-id>',
    handler: ({args}) => {
      const id = args.trim();
      if (!id) return {message: 'Usage: /shadow <candidate-id>'};
      const idx = loadIndex();
      const art = idx.artifacts[id];
      if (!art) return {message: `Candidate "${id}" not found.`};
      if (art.status !== 'candidate') {
        return {message: `"${id}" is ${art.status}, not a candidate.`};
      }
      art.status = 'shadow';
      art.shadow_runs = 0;
      saveIndex(idx);
      return {message: `"${id}" is now shadowing. It will influence context and track results.`};
    },
  });

  // Shared promotion path: /promote (user decision) and the autonomous
  // verdict sweep both call this. Autonomous mode applies the stricter
  // ll-min-shadow-runs gate and writes a receipt.
  function promoteArtifact(
    id: string,
    opts: {autonomous?: boolean; cycleId?: string} = {},
  ): {ok: boolean; message: string} {
    // Locked: promotion moves candidate dirs into active/ AND rewrites the
    // index — an interleaving session could observe (or create) a path the
    // index no longer owns.
    const res = withLock('index', () => promoteArtifactInner(id, opts));
    return res ?? {ok: false, message: 'Learning store is busy (another session is writing) — retry.'};
  }

  function promoteArtifactInner(
    id: string,
    opts: {autonomous?: boolean; cycleId?: string},
  ): {ok: boolean; message: string} {
    const idx = loadIndex();
    const art = idx.artifacts[id];
    if (!art) return {ok: false, message: `Artifact "${id}" not found.`};
    if (art.status !== 'shadow' && art.status !== 'candidate') {
      return {ok: false, message: `"${id}" is ${art.status}. Promote only from shadow or candidate.`};
    }

    // Gate check: a shadowed artifact must have been exercised;
    // a direct candidate promotion is an explicit user decision and skips the gate.
    const minRuns = opts.autonomous ? Math.round(numFlag('ll-min-shadow-runs', 2)) : 1;
    const checks: string[] = [];
    if (art.status === 'shadow') {
      if (art.shadow_runs < minRuns) checks.push(`Needs ${minRuns}+ shadow run(s)`);
      if (art.red > art.green) checks.push('More red runs than green');
    }
    if (art.rejections > 0) checks.push('Has unresolved rejections');

    if (checks.length > 0) {
      const msg = `Gate check failed for "${id}":\n${checks.map(c => '  ✗ ' + c).join('\n')}`;
      if (opts.autonomous) {
        writeReceipt({
          action: 'promote-skipped',
          id,
          cycleId: opts.cycleId ?? null,
          reason: 'gate check failed',
          evidence: {checks},
        });
      }
      return {ok: false, message: msg};
    }

    const prevStatus = art.status;
    art.status = 'active';
    art.last_verified = new Date().toISOString();

    // Move the artifact out of the candidates dir into active/<kind>/
    if (art.path.startsWith('candidates/')) {
      const newRel = path.join('active', art.kind, id).split(path.sep).join('/');
      moveDir(path.join(LEARNING_DIR, art.path), path.join(LEARNING_DIR, newRel));
      art.path = newRel;
    }

    // For skills: install the live SKILL.md into .agents/skills/ so the
    // promoted skill is actually loaded by Command Code (and any other
    // agent that reads the Agent Skills standard). Supporting files
    // (references/, scripts/, templates/) are synced too.
    let skillErr: string | null = null;
    if (art.kind === 'skill') {
      skillErr = syncInstalledSkill(art);
    }

    // A skill that cannot be installed live is not actually active — roll the
    // status back so the index never claims a live skill that doesn't exist.
    if (skillErr) {
      art.status = prevStatus;
      if (art.path.startsWith('active/')) {
        const oldRel = `candidates/${art.path.split('/').pop()}`;
        try {
          moveDir(path.join(LEARNING_DIR, art.path), path.join(LEARNING_DIR, oldRel));
          art.path = oldRel;
        } catch { /* leave path as-is; status is authoritative */ }
      }
      saveIndex(idx);
      cmd.ui.setStatus(buildStatus());
      if (opts.autonomous) {
        writeReceipt({
          action: 'promote-blocked',
          id,
          cycleId: opts.cycleId ?? null,
          reason: 'skill install failed',
          evidence: {skillErr},
        });
      }
      return {
        ok: false,
        message: `Promotion blocked for "${id}": ${skillErr}`,
      };
    }

    saveIndex(idx);
    cmd.ui.setStatus(buildStatus());

    if (opts.autonomous) {
      writeReceipt({
        action: 'promote',
        id,
        cycleId: opts.cycleId ?? null,
        reason: 'verified shadow evidence on self-repair verdict',
        evidence: {shadow_runs: art.shadow_runs, green: art.green, red: art.red},
      });
    }

    const skillNote = art.kind === 'skill'
      ? `\n→ live skill installed at .agents/skills/${id}/SKILL.md`
      : '';
    return {
      ok: true,
      message: `Promoted "${id}" → active. Gate passed: ${art.shadow_runs} shadow runs, ${art.green} green, ${art.rejections} rejections.${skillNote}`,
    };
  }

  cmd.addCommand({
    name: 'promote',
    description: 'Promote from shadow or candidate to active (requires gate check)',
    argumentHint: '<id>',
    handler: ({args}) => {
      const id = args.trim();
      if (!id) return {message: 'Usage: /promote <id>'};
      return {message: promoteArtifact(id).message};
    },
  });

  cmd.addCommand({
    name: 'reject',
    description: 'Reject a candidate (requires reason)',
    argumentHint: '<id> --reason "..."',
    handler: ({args}) => {
      const parts = args.match(/^(\S+)\s+--reason\s+"([^"]+)"/);
      if (!parts) return {message: 'Usage: /reject <id> --reason "explanation"'};
      const [, id, reason] = parts;

      const idx = loadIndex();
      const art = idx.artifacts[id];
      if (!art) return {message: `Candidate "${id}" not found.`};
      art.status = 'rejected';
      art.rejection_reason = reason;
      art.rejections += 1;

      // A rejected skill leaves .agents/skills/ — it is no longer live.
      // (Refusal for a foreign dir leaves the status recorded but the live
      // install untouched, which is exactly the ownership boundary.)
      let liveErr: string | null = null;
      if (art.kind === 'skill') liveErr = removeSkillFile(id);

      // Move to graveyard under a timestamped version dir
      if (art.path.startsWith('candidates/')) {
        const graveRel = path.join('graveyard', id, Date.now().toString(36))
          .split(path.sep).join('/');
        moveDir(path.join(LEARNING_DIR, art.path), path.join(LEARNING_DIR, graveRel));
        art.path = graveRel;
      }

      saveIndex(idx);
      cmd.ui.setStatus(buildStatus());
      return {message: `Rejected "${id}": ${reason}${liveErr ? `\n⚠ could not remove live skill: ${liveErr}` : ''}`};
    },
  });

  cmd.addCommand({
    name: 'demote',
    description: 'Move active → shadow',
    argumentHint: '<id> --reason "..."',
    handler: ({args}) => {
      const parts = args.match(/^(\S+)\s+--reason\s+"([^"]+)"/);
      if (!parts) return {message: 'Usage: /demote <id> --reason "explanation"'};
      const [, id, reason] = parts;

      const idx = loadIndex();
      const art = idx.artifacts[id];
      if (!art) return {message: `Artifact "${id}" not found.`};
      if (art.status !== 'active') {
        return {message: `"${id}" is ${art.status}. Demote only from active.`};
      }

      art.status = 'shadow';
      art.rejection_reason = reason;
      art.shadow_runs = 0;

      // A demoted skill leaves .agents/skills/ — it is no longer live.
      if (art.kind === 'skill') removeSkillFile(id);

      // Move back to candidates so promote can pick it up again
      if (art.path.startsWith('active/')) {
        const newRel = path.join('candidates', id).split(path.sep).join('/');
        moveDir(path.join(LEARNING_DIR, art.path), path.join(LEARNING_DIR, newRel));
        art.path = newRel;
      }

      saveIndex(idx);
      cmd.ui.setStatus(buildStatus());
      return {message: `Demoted "${id}" → shadow: ${reason}${art.kind === 'skill' ? '\n→ live skill removed from .agents/skills/' : ''}`};
    },
  });

  cmd.addCommand({
    name: 'merge',
    description: 'Merge two active learned skills into one (survivor = first arg)',
    argumentHint: '<keep-id> <absorb-id>',
    handler: ({args}) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length !== 2) return {message: 'Usage: /merge <keep-id> <absorb-id>'};
      const [keepId, absorbId] = parts;
      const res = mergeArtifacts(keepId, absorbId, false);
      if (!res.ok) return {message: `Merge failed: ${res.error}`};
      writeReceipt({action: 'merge-decision', decision: 'merge', keep: keepId, absorb: absorbId});
      return {message: `Merged "${absorbId}" into "${keepId}". Live skill re-synced; absorbed graveyarded (/rollback ${absorbId} restores).`};
    },
  });

  cmd.addCommand({
    name: 'merge-dismiss',
    description: 'Record an agent judgment that two skills are different jobs (pair not re-proposed for the TTL window)',
    argumentHint: '<id-a> <id-b>',
    handler: ({args}) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length !== 2) return {message: 'Usage: /merge-dismiss <id-a> <id-b>'};
      const [a, b] = parts;
      dismissMergePair(a, b);
      mergeReviewedThisRun.add(pairKey(a, b));
      writeReceipt({action: 'merge-decision', decision: 'dismiss', a, b});
      return {message: `Merge pair "${a}" + "${b}" dismissed for ${numFlag('ll-merge-dismiss-ttl-days', 30)} days.`};
    },
  });

  cmd.addCommand({
    name: 'rollback',
    description: 'Revert an artifact to its previous version',
    argumentHint: '<id>',
    handler: ({args}) => {
      const id = args.trim();
      if (!id) return {message: 'Usage: /rollback <id>'};
      const idx = loadIndex();
      const art = idx.artifacts[id];
      if (!art) return {message: `Artifact "${id}" not found.`};

      // Check graveyard for a previous version
      const graveRoot = path.join(GRAVEYARD_DIR, id);
      if (!fs.existsSync(graveRoot)) {
        return {message: `No previous version found for "${id}" in graveyard.`};
      }
      let versions: string[] = [];
      try {
        versions = fs.readdirSync(graveRoot)
          .filter(f => fs.statSync(path.join(graveRoot, f)).isDirectory())
          .sort();
      } catch { /* ok */ }
      if (versions.length === 0) {
        return {message: `No previous version found for "${id}" in graveyard.`};
      }
      const latest = versions[versions.length - 1];

      const newRel = path.join('candidates', id).split(path.sep).join('/');
      moveDir(path.join(graveRoot, latest), path.join(LEARNING_DIR, newRel));
      try {
        if (fs.readdirSync(graveRoot).length === 0) fs.rmdirSync(graveRoot);
      } catch { /* ok */ }

      // The rolled-back artifact is a candidate again — a live skill install
      // from its previous life must go.
      let liveErr: string | null = null;
      if (art.kind === 'skill') liveErr = removeSkillFile(id);

      art.path = newRel;
      art.status = 'candidate';
      art.rejection_reason = undefined;
      saveIndex(idx);
      cmd.ui.setStatus(buildStatus());
      return {message: `Rolled back "${id}" to the version archived at ${latest}. Status: candidate.${liveErr ? `\n⚠ could not remove live skill: ${liveErr}` : ''}`};
    },
  });

  cmd.addCommand({
    name: 'archive',
    description: 'Archive an artifact (keeps it searchable, stops loading)',
    argumentHint: '<id>',
    handler: ({args}) => {
      const id = args.trim();
      if (!id) return {message: 'Usage: /archive <id>'};
      const idx = loadIndex();
      const art = idx.artifacts[id];
      if (!art) return {message: `Artifact "${id}" not found.`};
      art.status = 'archived';
      art.rejection_reason = `manual archive`;
      // An archived skill leaves .agents/skills/ — it is no longer live.
      if (art.kind === 'skill') {
        const rmErr = removeSkillFile(id);
        if (rmErr) return {message: `Archive blocked: ${rmErr}`};
      }
      saveIndex(idx);
      cmd.ui.setStatus(buildStatus());
      return {message: `Archived "${id}". Searchable via /recall, no longer loads into context.`};
    },
  });

  cmd.addCommand({
    name: 'digest',
    description: 'Show the most recent curator digest',
    handler: () => {
      const idx = loadIndex();
      if (idx.digests.length === 0) return {message: 'No digests yet. Learning is just getting started.'};
      const last = idx.digests[idx.digests.length - 1];
      return {message: `—— Learning digest, ${last.date} ——\n\n${last.summary}`};
    },
  });

  // ── Custom tool: learning_manage ────────────────────────────────────────
  cmd.addTool({
    schema: {
      name: 'learning_manage',
      description: 'Create, patch, edit, or delete learning artifacts (skills, taste rules, warnings, guards) and their supporting files. Use "create" to make a new candidate, "patch" for targeted fixes, "edit" to replace full content, "write_file"/"remove_file" for supporting files, "shadow" to trial a candidate, "merge" to consolidate two active skills, "delete" to remove.',
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'patch', 'edit', 'delete', 'list', 'shadow', 'merge', 'write_file', 'remove_file'],
            description: 'What to do with the learning artifact.',
          },
          kind: {
            type: 'string',
            enum: ['skill', 'taste', 'warning', 'guard'],
            description: 'Type of artifact to create/edit.',
          },
          name: {
            type: 'string',
            description: 'Unique name for the artifact (kebab-case, e.g. "auth-jwt-refresh-debugging"). Required for create.',
          },
          scope: {
            type: 'string',
            enum: ['user', 'project', 'global'],
            description: 'Scope: user (personal), project (this repo), or global (any matching project).',
          },
          tags: {
            type: 'array', items: {type: 'string'},
            description: 'Search keywords for matching.',
          },
          description: {
            type: 'string',
            description: 'One-line summary used for discovery and recall. Keep it ≤60 characters for skills.',
          },
          content: {
            type: 'string',
            description: 'Full artifact content (Markdown for skill/taste/warning, TypeScript for guard).',
          },
          old_string: {
            type: 'string',
            description: 'For patch action: exact text to find and replace.',
          },
          new_string: {
            type: 'string',
            description: 'For patch action: replacement text.',
          },
          file_path: {
            type: 'string',
            description: 'For write_file/remove_file: relative path within the artifact directory (e.g. "references/examples.md").',
          },
          file_content: {
            type: 'string',
            description: 'For write_file: the full content to write.',
          },
          evidence: {
            type: 'object',
            description: 'Evidence linking this artifact to episodes and corrections.',
          },
          keep: {
            type: 'string',
            description: 'For merge action: id of the surviving artifact.',
          },
          absorb: {
            type: 'string',
            description: 'For merge action: id of the artifact absorbed into the survivor.',
          },
        },
        required: ['action'],
      },
    },
    run: async ({input}) => {
      // Write-approval gate (Hermes skills.write_approval parity, opt-in).
      // Write actions land in .agents/learning/pending/ and need
      // /learn approve|reject instead of applying immediately.
      if (boolFlag('ll-write-approval', false)) {
        const action = String((input as Record<string, unknown>).action ?? '');
        const WRITE_ACTIONS = ['create', 'patch', 'edit', 'delete', 'write_file', 'remove_file', 'shadow', 'merge'];
        if (WRITE_ACTIONS.includes(action)) {
          return stageForApproval(input as Record<string, unknown>);
        }
      }
      return executeManage(input);
    },
  });

  // ── Write-approval staging (opt-in via ll-write-approval) ────────────────
  function stageForApproval(input: Record<string, unknown>): Record<string, unknown> {
    const pendingDir = path.join(LEARNING_DIR, 'pending');
    ensureDir(pendingDir);
    const id = `w${Date.now().toString(36)}`;
    fs.writeFileSync(path.join(pendingDir, `${id}.json`), JSON.stringify(input, null, 2));
    const action = String(input.action ?? '');
    const name = String(input.name ?? '(new)');
    writeReceipt({action: 'staged', pendingId: id, manageAction: action, id: name});
    return {
      ok: true,
      content: [{
        type: 'text',
        text: `Staged ${action} "${name}" for review (write-approval is on). Use /learn pending to list, then /learn approve ${id} or /learn reject ${id}.`,
      }],
    };
  }

  // ── Execute a staged learning_manage input (replay path for approval) ────
  function executeManage(input: unknown): Record<string, unknown> {
    // Locked: every write action mutates the index and/or artifact files —
    // the whole action runs inside the lock so parallel sessions can't
    // interleave their read-modify-write cycles.
    const res = withLock('index', () => executeManageInner(input));
    return res ?? {ok: false, error: 'Learning store is busy (another session is writing) — retry.'};
  }

  function executeManageInner(input: unknown): Record<string, unknown> {
    const inp = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const action = String(inp.action ?? '');
    const kind = String(inp.kind ?? 'skill');
    const name = String(inp.name ?? '');
    const scope = String(inp.scope ?? 'user');
    const tags = Array.isArray(inp.tags) ? (inp.tags as string[]) : [];
    const description = String(inp.description ?? '');
    const content = String(inp.content ?? '');

      ensureDir(LEARNING_DIR);
      ensureDir(CANDIDATES_DIR);
      ensureDir(ACTIVE_DIR);
      ensureDir(GRAVEYARD_DIR);

      const idx = loadIndex();

      if (action === 'list') {
        const entries = Object.entries(idx.artifacts)
          .map(([id, a]) => `[${a.status}] [${a.kind}] ${id} — ${a.description}`)
          .join('\n');
        return {ok: true, content: [{type: 'text', text: entries || 'No artifacts yet.'}]};
      }

      if (action === 'shadow') {
        if (!name) return {ok: false, error: 'name is required for shadow action'};
        const art = idx.artifacts[name];
        if (!art) return {ok: false, error: `Artifact "${name}" not found`};
        if (art.status !== 'candidate') {
          return {ok: false, error: `"${name}" is ${art.status}, not a candidate.`};
        }
        art.status = 'shadow';
        art.shadow_runs = 0;
        saveIndex(idx);
        cmd.ui.setStatus(buildStatus());
        writeReceipt({action: 'shadow', id: name, reason: 'learning_manage shadow action'});
        return {ok: true, content: [{type: 'text', text: `"${name}" is now shadowing.`}]};
      }

      if (action === 'merge') {
        const keepId = String(inp.keep ?? '');
        const absorbId = String(inp.absorb ?? '');
        if (!keepId || !absorbId) {
          return {ok: false, error: 'keep and absorb ids are required for merge action'};
        }
        const res = mergeArtifacts(keepId, absorbId, false);
        if (!res.ok) return {ok: false, error: res.error};
        writeReceipt({action: 'merge-decision', decision: 'merge', keep: keepId, absorb: absorbId, source: 'learning_manage'});
        return {ok: true, content: [{type: 'text', text: `Merged "${absorbId}" into "${keepId}". Survivor version-bumped and live skill re-synced; absorbed artifact graveyarded (/rollback ${absorbId} restores).`}]};
      }

      if (action === 'create') {
        if (!name) return {ok: false, error: 'name is required for create action'};
        const safeName = slugify(name);
        if (idx.artifacts[safeName]) {
          return {ok: false, error: `Artifact "${safeName}" already exists. Use action "patch" to update it.`};
        }

        // House style: skill descriptions must stay ≤60 chars (Hermes standard).
        if (kind === 'skill' && description.length > 60) {
          return {ok: false, error: `Skill description must be ≤60 characters (got ${description.length}). It is used for discovery and recall — keep it tight.`};
        }

        const art: Artifact = {
          kind: kind as Artifact['kind'],
          status: 'candidate',
          path: `candidates/${safeName}`,
          scope: scope as Artifact['scope'],
          tags,
          description,
          confidence: 0.0,
          shadow_runs: 0,
          green: 0,
          red: 0,
          rejections: 0,
          episodes: [],
          created: new Date().toISOString(),
          last_verified: '',
          last_used: '',
          pinned: false,
          version: 0,
          use_count: 0,
        };

        const candDir = path.join(CANDIDATES_DIR, safeName);
        ensureDir(candDir);

        const ext = kind === 'guard' ? 'ts' : 'md';
        const displayKind = kind === 'guard' ? 'guard' :
          kind === 'warning' ? 'warning' :
          kind === 'taste' ? 'taste' : 'skill';
        fs.writeFileSync(path.join(candDir, `${displayKind}.${ext}`), content);

        if (inp.evidence) {
          fs.writeFileSync(
            path.join(candDir, 'evidence.json'),
            JSON.stringify(inp.evidence, null, 2),
          );
        }

        idx.artifacts[safeName] = art;
        saveIndex(idx);
        cmd.ui.setStatus(buildStatus());

        return {
          ok: true,
          content: [{
            type: 'text',
            text: `Created candidate "${safeName}" [${kind}]. Use /shadow ${safeName} to track it, then /promote ${safeName} when ready.`,
          }],
        };
      }

      if (action === 'patch') {
        const target = String(inp.name ?? '');
        const oldStr = String(inp.old_string ?? '');
        const newStr = String(inp.new_string ?? '');

        if (!target || !oldStr) {
          return {ok: false, error: 'name and old_string are required for patch action'};
        }

        const art = idx.artifacts[target];
        if (!art) return {ok: false, error: `Artifact "${target}" not found`};

        const targetFile = resolveArtifactFile(art);
        if (!targetFile) {
          return {ok: false, error: `Cannot find artifact file for "${target}"`};
        }

        const fileContent = fs.readFileSync(targetFile, 'utf-8');
        if (!fileContent.includes(oldStr)) {
          return {ok: false, error: `old_string not found in "${target}"`};
        }
        fs.writeFileSync(targetFile, fileContent.replace(oldStr, newStr));

        art.confidence = Math.min(1.0, art.confidence + 0.05);
        art.last_verified = new Date().toISOString();
        art.version = (art.version ?? 0) + 1;
        saveIndex(idx);

        // An active skill has a live copy in .agents/skills/ — keep it in sync.
        if (art.kind === 'skill' && art.status === 'active') {
          syncInstalledSkill(art);
        }

        return {
          ok: true,
          content: [{
            type: 'text',
            text: `Patched "${target}". Confidence: ${art.confidence.toFixed(2)}`,
          }],
        };
      }

      if (action === 'edit') {
        const target = String(inp.name ?? '');
        if (!target || !content) {
          return {ok: false, error: 'name and content are required for edit action'};
        }

        const art = idx.artifacts[target];
        if (!art) return {ok: false, error: `Artifact "${target}" not found`};

        const targetFile = resolveArtifactFile(art);
        if (!targetFile) {
          return {ok: false, error: `Cannot find artifact file for "${target}"`};
        }

        fs.writeFileSync(targetFile, content);
        art.last_verified = new Date().toISOString();
        saveIndex(idx);

        if (art.kind === 'skill' && art.status === 'active') {
          syncInstalledSkill(art);
        }

        return {
          ok: true,
          content: [{
            type: 'text',
            text: `Replaced content of "${target}".`,
          }],
        };
      }

      if (action === 'write_file') {
        const target = String(inp.name ?? '');
        const filePath = String(inp.file_path ?? '');
        const fileContent = String(inp.file_content ?? '');
        if (!target || !filePath) {
          return {ok: false, error: 'name and file_path are required for write_file action'};
        }

        const art = idx.artifacts[target];
        if (!art) return {ok: false, error: `Artifact "${target}" not found`};

        const artDir = path.join(LEARNING_DIR, art.path);
        ensureDir(artDir);
        // Supporting files only — block attempts to overwrite the main artifact.
        const isMain = ['skill.md', 'taste.md', 'warning.md', 'guard.ts'].includes(
          path.basename(filePath).toLowerCase());
        if (isMain) {
          return {ok: false, error: 'Use action "edit" to replace the main artifact content'};
        }
        const dest = path.join(artDir, filePath);
        ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, fileContent);

        if (art.kind === 'skill' && art.status === 'active') {
          syncInstalledSkill(art);
        }

        return {
          ok: true,
          content: [{type: 'text', text: `Wrote ${filePath} for "${target}".`}],
        };
      }

      if (action === 'remove_file') {
        const target = String(inp.name ?? '');
        const filePath = String(inp.file_path ?? '');
        if (!target || !filePath) {
          return {ok: false, error: 'name and file_path are required for remove_file action'};
        }

        const art = idx.artifacts[target];
        if (!art) return {ok: false, error: `Artifact "${target}" not found`};

        const artDir = path.join(LEARNING_DIR, art.path);
        const dest = path.join(artDir, filePath);
        if (!fs.existsSync(dest)) {
          return {ok: false, error: `File not found: ${filePath}`};
        }
        fs.rmSync(dest);
        // Prune parent dirs that became empty, so sync doesn't resurrect them.
        let parent = path.dirname(dest);
        const artRoot = path.join(LEARNING_DIR, art.path);
        while (parent !== artRoot && parent.startsWith(artRoot + path.sep)) {
          try {
            if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
            else break;
          } catch { break; }
          parent = path.dirname(parent);
        }
        if (art.kind === 'skill' && art.status === 'active') {
          syncInstalledSkill(art);
        }
        return {
          ok: true,
          content: [{type: 'text', text: `Removed ${filePath} from "${target}".`}],
        };
      }

      if (action === 'delete') {
        if (!name) return {ok: false, error: 'name is required for delete action'};
        const art = idx.artifacts[name];
        if (!art) return {ok: false, error: `Artifact "${name}" not found`};
        if (art.pinned) {
          return {ok: false, error: `Artifact "${name}" is pinned. Use /unpin ${name} first.`};
        }

        // Move to graveyard under a timestamped version dir
        const graveRel = path.join('graveyard', name, Date.now().toString(36))
          .split(path.sep).join('/');
        const srcDir = path.join(LEARNING_DIR, art.path);
        if (fs.existsSync(srcDir)) {
          moveDir(srcDir, path.join(LEARNING_DIR, graveRel));
        }

        // A deleted skill leaves .agents/skills/.
        if (art.kind === 'skill') removeSkillFile(name);

        delete idx.artifacts[name];
        saveIndex(idx);
        cmd.ui.setStatus(buildStatus());

        return {
          ok: true,
          content: [{
            type: 'text',
            text: `Deleted "${name}". Moved to graveyard (rollback available via /rollback ${name}).`,
          }],
        };
      }

      return {ok: false, error: `Unknown action: ${action}`};
  }

  // ── Candidate card renderer ──────────────────────────────────────────────
  try {
    cmd.addRenderer('learn-loop/candidate', (data: any) => {
      const lines: string[] = [];
      const name = data?.name || 'unknown';
      const kind = data?.kind || 'skill';
      const confidence = typeof data?.confidence === 'number' ? data.confidence : 0;
      const green = data?.green || 0;
      const red = data?.red || 0;
      const rejections = data?.rejections || 0;
      const episodes = data?.episodes || 0;
      const verify = data?.verify || 'none';

      const bar = '█'.repeat(Math.round(confidence * 10)) +
        '░'.repeat(10 - Math.round(confidence * 10));
      lines.push(`candidate ${name}`);
      lines.push(`kind: ${kind}`);
      lines.push(`evidence: ${episodes} episodes · ${green} green · ${red} red · ${rejections} rejections`);
      lines.push(`confidence: ${bar} ${confidence.toFixed(2)}`);
      lines.push(`verify: ${verify}`);
      lines.push(`action: /promote ${name} | /shadow ${name} | /reject ${name}`);
      return lines;
    });
  } catch { /* renderer registration can fail in older versions */ }

  // ── Guardrails: beforeToolCall ──────────────────────────────────────────
  cmd.hooks({
    beforeToolCall: async ({toolName, input}) => {
      if (toolName !== 'learning_manage') return undefined;
      const inp = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      const action = String(inp.action ?? '');
      const name = String(inp.name ?? '');

      // Ownership boundary: write actions must never touch user-installed skills.
      if (['create', 'patch', 'edit', 'delete', 'write_file', 'remove_file', 'shadow', 'merge'].includes(action)) {
        const conflict = foreignSkillConflict(name);
        if (conflict) {
          return {
            block: true,
            additionalContext: conflict,
          };
        }
      }

      if (['delete', 'merge', 'patch', 'edit'].includes(action) && name) {
        const idx = loadIndex();
        const art = idx.artifacts[name];
        if (art?.pinned) {
          return {
            block: true,
            additionalContext: `Artifact "${name}" is pinned. Use /unpin ${name} first.`,
          };
        }
      }
      return undefined;
    },
  });

  // ── Hooks: afterToolCall — usage + shadow verification outcomes ─────────
  cmd.hooks({
    afterToolCall: async ({toolName, input, result, isError}) => {
      // Usage signal 2: the model explicitly activating a skill.
      if (toolName === 'activate_skill') {
        const name = typeof input === 'string'
          ? input.trim()
          : ((input as Record<string, unknown> | null)?.name as string | undefined)?.trim() ?? '';
        if (name) recordSkillUse(name, 'activate_skill');
      }

      if (recalledThisRun.size === 0) return undefined;
      if (toolName !== 'shell_command' && toolName !== 'powershell') return undefined;

      const command = extractCmd(input);
      if (!/\b(test|check|build|compile|verify)\b/i.test(command)) return undefined;

      const text = contentText(result);
      const failed = isError ||
        /\b\d+\s+(?:tests?\s+)?fail(?:ed)?\b/i.test(text) ||
        /\bfail(?:ed|ures?)\b/i.test(text) ||
        /\berror\b/i.test(text);
      const passed = !failed && /\b(pass(?:ed)?|success|green|ok)\b/i.test(text);
      if (!failed && !passed) return undefined;

      const idx = loadIndex();
      let changed = false;
      for (const id of recalledThisRun) {
        const art = idx.artifacts[id];
        if (!art || art.status !== 'shadow') continue;
        art.shadow_runs += 1;
        art.last_used = new Date().toISOString();
        if (failed) {
          art.red += 1;
          art.confidence = Math.max(0, art.confidence - 0.05);
        } else {
          art.green += 1;
          art.confidence = Math.min(1.0, art.confidence + 0.05);
        }
        changed = true;
      }
      if (changed) saveIndex(idx);
      return undefined;
    },
  });

  // ── Initialize ──────────────────────────────────────────────────────────
  ensureDir(LEARNING_DIR);
  ensureDir(CANDIDATES_DIR);
  ensureDir(path.join(ACTIVE_DIR, 'skill'));
  ensureDir(path.join(ACTIVE_DIR, 'taste'));
  ensureDir(path.join(ACTIVE_DIR, 'warning'));
  ensureDir(GRAVEYARD_DIR);

  // Set initial footer status (safe in case UI isn't bound yet)
  try { cmd.ui.setStatus(buildStatus()); } catch { /* headless or pre-bind */ }
}
