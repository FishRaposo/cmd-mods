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
  'protocol-loader.ts': 'pl-',
  'error-tracker.ts': 'et-',
};

// Events the harness itself emits natively (AgentEvent catalog + host lifecycle),
// which mods may listen to without any in-suite emitter.
const HARNESS_NATIVE_EVENTS = new Set([
  'run_start', 'run_end', 'turn_start', 'turn_end',
  'message_start', 'message_end', 'message_update',
  'text_delta', 'thinking_start', 'thinking_delta', 'thinking_end',
  'model_request_start', 'model_request_end',
  'tool_queued', 'tool_denied', 'tool_hook_blocked', 'tool_running',
  'tool_update', 'tool_completed', 'tool_errored',
  'subagent_start', 'subagent_stop', 'subagent_progress',
  'api_retry', 'interrupted', 'continuation_recovery',
  'tool_input_coerced', 'tool_input_repaired',
  'mod_error', 'run_error',
  'skill_loaded', 'session_titled', 'permission_mode_changed',
  'config_setting_changed', 'notice',
  'compaction_start', 'compaction_done',
  'session_start', 'session_shutdown',
]);

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
  if (!emits.has(event) && !HARNESS_NATIVE_EVENTS.has(event)) {
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

// ── 7. Protocol-twin declarations ──────────────────────────────────────────
// Mirrors the templates kit's twin map (lib/system/protocol-lint.mjs): each
// mod that mechanically twins a kit protocol must declare it in its header as
// "Harness-neutral twin:" so both repos validate their own side of the
// relationship without importing each other. If a twin's name or trigger
// changes in one repo, the other's header becomes checkable drift instead of
// silent divergence.
const KIT_PROTOCOL_TWINS = {
  'self-repair.ts': ['completion-gate', 'resume-continuity'],
  'quality-guards.ts': ['resume-continuity'],
  'autopilot.ts': ['verified-followthrough'],
  'learn-loop.ts': ['learning-loop'],
  'command-center.ts': ['plan-briefing'],
  'memory-bank.ts': ['memory-maintenance'],
};
const ALL_TWIN_PROTOCOLS = new Set([
  'completion-gate', 'resume-continuity', 'verified-followthrough',
  'learning-loop', 'plan-briefing', 'memory-maintenance',
]);
for (const [file, expected] of Object.entries(KIT_PROTOCOL_TWINS)) {
  const src = sources.get(file);
  if (!src) continue;
  const header = src.slice(0, 4000);
  for (const protocol of expected) {
    if (!header.includes(protocol)) {
      problems.push(`${file}: header must declare harness-neutral twin "${protocol}" (templates kit twin map)`);
    }
  }
}
for (const [file, src] of sources) {
  const header = src.slice(0, 4000);
  for (const m of header.matchAll(/(?:harness-neutral twin|shared with the protocol|protocol owns this)[\s\S]{0,120}?([a-z][a-z0-9-]*\.md)\b/gi)) {
    const protocol = m[1].replace(/\.md$/, '');
    if (!ALL_TWIN_PROTOCOLS.has(protocol)) {
      problems.push(`${file}: header references protocol "${protocol}" that is not in the canonical twin set`);
    }
  }
  if (header.includes('harness-neutral twin') || header.includes('Harness-neutral twin')) {
    const named = KIT_PROTOCOL_TWINS[file] ?? [];
    if (named.length === 0) {
      problems.push(`${file}: declares a harness-neutral twin but the twin map lists no kit protocols for this mod`);
    }
  }
}

if (problems.length > 0) {
  console.error(`CONTRACT CHECK FAILED (${problems.length}):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`contract check OK — ${sources.size} mods, ${emits.size} internal events, all paired; command/tool/renderer names unique; flag prefixes valid; exec timeouts present`);
