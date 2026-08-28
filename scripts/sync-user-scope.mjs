#!/usr/bin/env node
// Sync the mod source files to the user-scope install so installed copies
// stay byte-identical to the repo source. Mirrors the AGENTS.md verification
// gate "Copy the changed files to the user-scope install (`~/.commandcode/mods/`)".
//
// Usage:
//   node scripts/sync-user-scope.mjs          # sync (default)
//   node scripts/sync-user-scope.mjs --check  # exit 1 if any drift, 0 if clean
//   node scripts/sync-user-scope.mjs --help   # usage
//
// Why this script exists: the mod AGENTS.md tells contributors to copy changed
// files to ~/.commandcode/mods/ before considering a change done, but doing it
// by hand is error-prone (easy to forget a file, easy to copy the wrong path).
// This script makes the gate mechanical and auditable, and `--check` lets CI
// (or pre-commit) catch drift without writing.
//
// Exit codes:
//   0 = clean (or successful sync)
//   1 = drift detected (--check only) or sync failed
//   2 = invalid arguments

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modsDir = join(root, "mods");
const libDir = join(root, "lib");
const installDir = process.env.COMMANDCODE_MODS_DIR
  ?? join(homedir(), ".commandcode", "mods");
const installLibDir = process.env.COMMANDCODE_MODS_LIB_DIR
  ?? join(homedir(), ".commandcode", "lib");

const args = process.argv.slice(2);
let mode = "sync"; // "sync" | "check" | "help"
for (const arg of args) {
  if (arg === "--check") mode = "check";
  else if (arg === "--help" || arg === "-h") mode = "help";
  else {
    console.error(`sync-user-scope: unknown argument '${arg}'`);
    process.exit(2);
  }
}

if (mode === "help") {
  console.log(`Usage: node scripts/sync-user-scope.mjs [--check] [--help]

Sync command-code-mods source files to the user-scope install.

Modes:
  (default)   Copy any source file whose hash differs from the installed copy.
              Files that are missing on the install side are created.
  --check     Exit 1 if any source file differs from its installed copy or is
              missing. No writes. Use this in CI or pre-commit.
  --help      Show this message.

Source files synced:
  mods/*.ts       → ${installDir}
  lib/*.ts        → ${installLibDir}
lib/ files are the shared helpers that mods import (e.g. ../lib/lastUserTaskLabel.ts),
so they must land next to the mods at ~/.commandcode/lib/, NOT in ~/.commandcode/mods/
(the harness auto-loads every .ts in the mods dir as a mod; lib/ is not a mod-loading dir).
Override the lib install dir with the COMMANDCODE_MODS_LIB_DIR env var.`);
  process.exit(0);
}

function sha256(path) {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

function listSource(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
}

const sources = [
  ...listSource(modsDir).map((name) => ({ kind: "mod", source: join(modsDir, name), name, dest: join(installDir, name) })),
  ...listSource(libDir).map((name) => ({ kind: "lib", source: join(libDir, name), name, dest: join(installLibDir, name) })),
];

if (sources.length === 0) {
  console.error(`sync-user-scope: no .ts files found under ${modsDir}`);
  process.exit(1);
}

let drift = 0;
let copied = 0;
let alreadyCurrent = 0;

for (const file of sources) {
  const dest = file.dest;
  const sourceHash = sha256(file.source);
  let destHash = null;
  if (existsSync(dest)) destHash = sha256(dest);

  if (destHash === sourceHash) {
    alreadyCurrent += 1;
    continue;
  }

  if (mode === "check") {
    console.error(`drift: ${file.kind}/${file.name} (${destHash ? "modified" : "missing"})`);
    drift += 1;
    continue;
  }

  // sync mode
  try {
    if (!existsSync(dirname(dest))) mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file.source, dest);
    const postHash = sha256(dest);
    if (postHash !== sourceHash) {
      console.error(`sync-user-scope: ${file.kind}/${file.name} hash mismatch after copy (expected ${sourceHash.slice(0, 8)}, got ${postHash.slice(0, 8)})`);
      drift += 1;
    } else {
      copied += 1;
    }
  } catch (error) {
    console.error(`sync-user-scope: failed to copy ${file.kind}/${file.name}: ${error.message}`);
    drift += 1;
  }
}

if (mode === "check") {
  if (drift > 0) {
    console.error(`sync-user-scope: ${drift} file(s) out of sync with the install dirs`);
    process.exit(1);
  }
  console.log(`OK: ${sources.length} file(s) byte-identical (${installDir}, ${installLibDir})`);
  process.exit(0);
}

console.log(`sync-user-scope: ${copied} copied, ${alreadyCurrent} current, ${drift} failed → ${installDir}, ${installLibDir}`);
process.exit(drift > 0 ? 1 : 0);
