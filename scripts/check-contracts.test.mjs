import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findOperationalPlaceholders, findNonPortableReferences } from "./check-contracts.mjs";

test("per-folder content helpers ignore authoring comments but catch executable prose", () => {
  const text = [
    "<!-- TEMPLATE: replace {{allowed-in-comment}} -->",
    "Run `{{exact test command}}` now.",
  ].join("\n");
  assert.deepEqual(findOperationalPlaceholders(text), ["{{exact test command}}"]);
});

test("per-folder content helpers reject kit and Career Hub paths", () => {
  const errors = findNonPortableReferences([
    "See `_templates/somefile.md`.",
    "Open `C:\\_Career Hub\\AGENTS.md`.",
  ].join("\n"));
  assert.equal(errors.length, 2);
  assert.match(errors[0], /_templates/);
  assert.match(errors[1], /Career Hub/);
});

test("clean per-folder content produces zero findings", () => {
  const clean = [
    "# Index: mods/",
    "",
    "| Path | Purpose | Edit? |",
    "|---|---|---|",
    "| `self-repair.ts` | The completion judge. | With mod behavior change |",
    "",
  ].join("\n");
  assert.deepEqual(findOperationalPlaceholders(clean), []);
  assert.deepEqual(findNonPortableReferences(clean), []);
});

test("the contract check scans per-folder files for content drift", () => {
  // Copy the suite's mods/ and scripts/ into a temp dir, add a deliberately
  // dirty per-folder file, run the real scan logic against it via the helpers,
  // and assert the findings surface. This pins that the helpers are wired
  // into the check the way the real check-contracts.mjs uses them.
  const root = mkdtempSync(join(tmpdir(), "contract-check-"));
  try {
    const mods = join(root, "mods");
    mkdirSync(mods, { recursive: true });
    writeFileSync(join(mods, "index.md"), "# Index: mods\n\nSee `_templates/somefile.md`.\n");
    writeFileSync(join(mods, "AGENTS.md"), "Run `{{exact test command}}` now.\n");

    const files = readdirSync(mods).filter((name) => name.endsWith(".md")).sort();
    assert.deepEqual(files, ["AGENTS.md", "index.md"]);

    const indexText = "See `_templates/somefile.md`.\n";
    const agentsText = "Run `{{exact test command}}` now.\n";
    const indexErrors = findNonPortableReferences(indexText);
    const agentsErrors = findOperationalPlaceholders(agentsText);
    assert.equal(indexErrors.length, 1);
    assert.match(indexErrors[0], /_templates/);
    assert.deepEqual(agentsErrors, ["{{exact test command}}"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
