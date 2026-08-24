#!/usr/bin/env node
// Mechanical cross-mod contract check for the command-code-mods suite.
// Dependency-free: parses mods/*.ts source with regexes and validates
//   1. event emit ↔ on pairing (every emitted namespaced event has a listener)
//   2. unique slash-command names across mods
//   3. unique tool names across mods
//   4. unique renderer names across mods
//   5. flag-prefix convention (each mod's flags carry its own prefix)
//   6. every child_process exec call passes a timeout
// Exit 0 = all contracts hold; exit 1 = violations printed.

import {readdirSync, readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modsDir = join(root, 'mods');

const FLAG_PREFIXES = {
  'self-repair.ts': 'sr-',
  'autopilot.ts': 'auto-',
  'quality-guards.ts': 'qg-',
  'command-center.ts': 'cc-',
  'memory-bank.ts': 'mb-',
  'learn-loop.ts': 'll-',
  'cache-tracker.ts': 'ct-',
};

const sources = new Map();
for (const f of readdirSync(modsDir).filter(f => f.endsWith('.ts'))) {
  sources.set(f, readFileSync(join(modsDir, f), 'utf-8'));
}

const problems = [];

// ── 1. Event pairing ──────────────────────────────────────────────────────
const emits = new Map(); // event -> [file]
const ons = new Map();   // event -> [file]
for (const [file, src] of sources) {
  for (const m of src.matchAll(/\.emit\(\s*['"`]([^'"`]+)['"`]/g)) {
    if (!emits.has(m[1])) emits.set(m[1], []);
    emits.get(m[1]).push(file);
  }
  for (const m of src.matchAll(/\.on\(\s*['"`]([^'"`]+)['"`]/g)) {
    if (!ons.has(m[1])) ons.set(m[1], []);
    ons.get(m[1]).push(file);
  }
}
for (const [event, emitters] of emits) {
  if (!ons.has(event)) {
    problems.push(`event "${event}" emitted by ${emitters.join(', ')} but has NO listener in the suite`);
  }
}
for (const [event, listeners] of ons) {
  if (!emits.has(event) && !['tool_queued', 'tool_completed', 'tool_errored', 'turn_start', 'turn_end', 'run_start', 'run_end', 'subagent_start', 'subagent_stop', 'subagent_progress', 'skill_loaded', 'model_request_start', 'model_request_end'].includes(event)) {
    problems.push(`event "${event}" has listeners (${listeners.join(', ')}) but nothing in the suite emits it`);
  }
}

// ── 2-4. Command / tool / renderer name uniqueness ────────────────────────
function collect(regex, kind) {
  const seen = new Map();
  for (const [file, src] of sources) {
    for (const m of src.matchAll(regex)) {
      const key = m[1];
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(file);
    }
  }
  for (const [key, files] of seen) {
    if (files.length > 1) {
      problems.push(`duplicate ${kind} "${key}" registered by ${files.join(', ')}`);
    }
  }
}
collect(/addCommand\(\s*\{\s*name:\s*['"]([^'"]+)['"]/g, 'command');
collect(/addTool\(\s*\{[\s\S]{0,200}?name:\s*['"]([^'"]+)['"]/g, 'tool');
collect(/addRenderer\(\s*['"]([^'"]+)['"]/g, 'renderer');

// ── 5. Flag-prefix convention ─────────────────────────────────────────────
for (const [file, prefix] of Object.entries(FLAG_PREFIXES)) {
  const src = sources.get(file);
  if (!src) continue;
  for (const m of src.matchAll(/addFlag\(\s*['"]([^'"]+)['"]/g)) {
    if (!m[1].startsWith(prefix)) {
      problems.push(`${file}: flag "${m[1]}" does not use the "${prefix}" prefix`);
    }
  }
}

// ── 6. exec calls carry a timeout ─────────────────────────────────────────
for (const [file, src] of sources) {
  for (const m of src.matchAll(/execSync\(/g)) {
    const callStart = m.index;
    const tail = src.slice(callStart, callStart + 400);
    if (!/timeout\s*:/.test(tail)) {
      const line = src.slice(0, callStart).split('\n').length;
      problems.push(`${file}:${line}: execSync without an explicit timeout`);
    }
  }
}

if (problems.length > 0) {
  console.error(`CONTRACT CHECK FAILED (${problems.length}):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`contract check OK — ${sources.size} mods, ${emits.size} internal events, all paired; command/tool/renderer names unique; flag prefixes valid; exec timeouts present`);
