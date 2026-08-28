# Changelog

All notable changes to the command-code-mods suite are tracked here, one entry per mod.
This file is the single source of truth for what changed and when — keep it
updated with every merged change.

## [Unreleased]

### Tooling

- **Per-folder convention** — `mods/index.md` (structural map of the nine mod sources) and `mods/AGENTS.md` (per-folder tier rules for the mod sources) now ship with the suite. `scripts/check-contracts.mjs` extends with an 8th check: any per-folder `index.md` / `AGENTS.md` in the suite must be free of operational placeholders and kit-path leaks (the same rule the templates kit's `check-templates.mjs` applies to its own per-folder files). The scan is by name, so a future per-folder file (e.g. `scripts/index.md`) is picked up automatically. `scripts/check-contracts.test.mjs` pins the helpers with four cases. The root `AGENTS.md`, the mod sources, and `lib/` are unchanged — this is additive.
- **scripts/sync-user-scope.mjs** — the AGENTS.md verification gate
  ("copy the changed files to `~/.commandcode/mods/`) now has a mechanical
  implementation. `node scripts/sync-user-scope.mjs` copies any `mods/*.ts`
  whose hash differs from the installed copy; `--check` exits 1 on drift
  without writing (CI / pre-commit gate). It also syncs `lib/*.ts` to
  `~/.commandcode/lib/` — the shared helpers that mods import
  (`../lib/lastUserTaskLabel.ts` resolves to `~/.commandcode/lib/`, which is
  not a mod-loading dir, so it must live there, not in `~/.commandcode/mods/`).
  Override the dirs with `COMMANDCODE_MODS_DIR` / `COMMANDCODE_MODS_LIB_DIR`.
  Wired into `package.json` as `npm run sync`
  and `npm run sync:check`.

### New mods

- **protocol-loader** — loads `.agents/protocols/*.md` on demand, like skills:
  discovers the tree in cwd and ancestor workspaces, trigger-matches each
  protocol's "Run when …" frontmatter against typed prompts, activates the best
  match, and rides the message tail via `transformContext` (system prompt stays
  byte-stable). `/protocol <name>` is the explicit `/name` analog; `/protocols`
  lists discovered protocols with load state; `/protocol-clear` resets the
  session. Makes the wrapper-skill shim optional on Command Code while leaving
  harnesses without native triggering on the AGENTS.md rule as the baseline.
- **error-tracker** — suite-wide error observability, pure observer (no prompt
  hooks). Tracks `mod_error` (per mod → hook), `tool_errored` (per tool),
  `run_error`, `api_retry`, and `interrupted` across the whole suite, shows a
  footer badge, and appends one redacted JSONL line per error to
  `~/.commandcode/error-tracker.jsonl` (locked appends, retention-capped).
  `/errors` reports session aggregates + recent history; `/errors-clear`
  resets. New `et-status` / `et-limit` flags. `tool_errored` failures are
  attributed to their tool via the `tool_queued` call-id map. check-contracts
  now whitelists the full harness-native event catalog (mod_error, run_error,
  api_retry, interrupted, compaction, and friends), so error listeners no
  longer trip the "nothing emits it" check.

### Fixes

- **self-repair** — `lastUserTaskLabel` and `SESSION_META_SIGNALS` extracted
  to a shared `lib/lastUserTaskLabel.ts`; the mod now imports them. The
  previous inlined copy was byte-identical to quality-guards' copy, so any
  change to the meta-talk heuristic had to be made in two files. Drift
  between the two was the failure mode this extraction prevents.
- **quality-guards** — same `lastUserTaskLabel` extraction; this mod also
  imports the shared helper now. Drift/run-length signals stay sourced from
  the user's real prompt and continue to share the heuristic with self-repair.
- **self-repair / quality-guards** (new shared helper) — `lib/lastUserTaskLabel.ts`
  is the single source of truth for "what is the user actually working on
  right now?" Both mods consume the same `SESSION_META_SIGNALS` regex and the
  same extraction loop. The lib file is **not** synced to the mod install
  dir (the harness auto-loads every `.ts` under `~/.commandcode/mods/` as
  a mod; the shared helper is imported by mods at TypeScript build time, not
  loaded directly). `scripts/sync-user-scope.mjs` enforces this by syncing
  only `mods/*.ts`.
- **self-repair** — the "current task" label now comes from the user's real
  prompt (`lastUserTaskLabel` over `state.messages`), never from scanning the
  assistant's summary for "verb + phrase." sentences. The old extractor
  captured report tails ("add a dev-mode churn diagnostic).", "updated to
  point at the checker.") as task labels; those phantom labels changed every
  stop, reset the resume budget, and fed both the drift reminders and the
  sudden-stop resume loop. Also: `lastIntent` truncates at a word boundary;
  `extractNextAction` refuses session-meta fragments; the sudden-stop resume
  branches no longer fire when the assistant is itself discussing session
  state (resumes/checkpoints/drift), which previously echoed "interrupted
  mid-task — continue from exactly where you stopped" as self-sustaining
  automated turns.
- **quality-guards** — same user-prompt-sourced task label for the drift and
  run-length warnings; meta-talk about the session is no longer labeled a task.

### Kit parity

- **command-center** — the default plan artifact home is now the project's
  `docs/plans/` when a docs tree exists (the templates kit convention), falling
  back to `~/.commandcode/plans/`; the `cc-plan-path` flag remains an explicit
  override. Aligns the mod with `plan-briefing` protocol output locations.
- **memory-bank** — header now documents `episodes.jsonl` parity with the
  templates kit's memory template and names the kit's `memory-maintenance` /
  `learning-loop` protocols as the harness-neutral twins of recall and graduation.
- **self-repair** — header comment maps the self-review gate and checkpoint/resume
  to the kit's `completion-gate.md` (critical-review + evidence steps) and
  `resume-continuity.md` protocols; the mod is the mechanical Command Code layer,
  the protocols are the portable ones.
- **autopilot** — header comment names the kit's `verified-followthrough.md`
  protocol as the harness-neutral twin of the tiered backlog + mandate + receipts.
- **learn-loop** / **command-center** / **quality-guards** — headers now declare
  their harness-neutral twins (`learning-loop.md`, `plan-briefing.md`,
  `resume-continuity.md`) so the full twin relationship is visible from every mod.
- **check-contracts** — new section 7 validates protocol-twin declarations
  mechanically: every mod the templates kit's twin map names must declare its
  protocol twin in its header, and headers may not reference protocols outside
  the canonical twin set. Two repos, no cross-repo import — each validates its
  own side of the relationship.

### Parallel-session safety

- **learn-loop** — every store write (index, episodes, skill-dir moves,
  decay/prune/delete sweeps, promote, merge, learning_manage) now runs
  under a cross-process file lock (mutually-exclusive mkdir, reentrant,
  stale-steal after 10s). Two parallel sessions can no longer interleave
  read-modify-write cycles on `index.json` and lose artifacts.
- **memory-bank** — L1 prepend+compact, L2 add/update/remove, lesson
  graduation sweep, ledger appends/tombstones, and recall-stats all
  serialized with the same lock protocol.
- **self-repair** — checkpoint save AND the load's copy/rename/unlink
  dance are serialized; two sessions can no longer race the backup file.
- **autopilot** / **cache-tracker** — receipt and stats JSONL appends
  serialized per file so parallel sessions can't interleave lines.
- **command-center** — plan filenames now carry a millisecond-unique
  component, so two sessions briefing the same objective write distinct
  artifacts instead of clobbering each other.
- Lock protocol verified by a two-process stress test (60/60 increments
  with zero lost updates).

### Fixes

- **learn-loop** — the second audit found small index read-modify-write
  sites still unlocked: `/pin`, `/unpin`, `/shadow`, `/reject`, `/demote`,
  `/rollback`, `/archive`, the 3+ corrections candidate seed, the
  `memory-bank/graduate` handler, and the shadow-verdict updater. All now
  hold the index lock.
- **quality-guards / self-repair** — `extractTaskLabel` no longer mislabels
  document phrases ("updated in the same commit.") as tasks, which stopped
  spurious drift reminders.

### Repo

- **Repository identity** — the public repository and active source checkout were
  renamed from `cmd-mods` to `command-code-mods`; historical changelog references
  retain the old name only as lineage.

- **README rewritten as a portfolio piece** — pitch, mermaid pipeline
  diagram, per-mod capability tables, design principles, engineering
  discipline, measured cache performance.
- **CI** — GitHub Actions `contracts` workflow runs the cross-mod contract
  check on every push and pull request.
- **CONTRIBUTING.md** — commit style, architecture rules, verification
  gates, and what makes a good mod change.
- **package.json** — keywords, repository/homepage metadata, CONTRIBUTING.md
  in the files whitelist.

### Fixes

- **command-center, quality-guards, learn-loop, memory-bank** — injected
  context messages now use array content blocks (`content: [{type: 'text',
  text}]`) instead of raw strings. The harness's wire projection assumes
  `message.content` is always an array and crashed with
  `message.content.filter is not a function` when a string-content message
  reached it — intermittently, on interactive turns that triggered recall
  or warnings. Verified by reading the session transcript (the crash was
  in the harness's own projection path, mods never wrote to the durable
  store).
- **memory-bank** — recall injection was dead: `transformContext` only read
  string message content, but every message on the wire is array content, so
  `lastUser` stayed empty and recall never fired. Now array-aware. Also:
  `/bank status` L2 count no longer assumes exactly four header rows, and
  recall `lastUse` timestamps persist into `recall-stats.json` for
  maintenance decay.
- **autopilot** — red-command guard no longer fires between actions: it
  previously blocked the user's own `git push` all session in momentum
  mode; scope is now the action lifetime only. Failed child-cycle verdicts
  now record a terminal `repair-failed` receipt, mark the backlog entry
  done, and step `greenChain` back instead of leaking guard state.
- **self-repair** — removed dead nested `topicTurns >= 3` check in the
  task-change branch of `onStop`.

### Mods

- **cache-tracker** — new: prompt-cache hit-rate observability. A pure
  observer of `model_request_end` usage (`cacheReadTokens` /
  `cacheWriteTokens` from the provider's input-token details): live footer
  status, `/cache` for session/all-time history, `/cache-reset`, and one
  JSONL line per session in `~/.commandcode/cache-tracker.jsonl`.
  Registers no prompt hooks, so it can never affect the cache it measures.

### Features

- **memory-bank** — `bank_write` registry gains `action: add|update|remove`
  so L2 pointer rows can be updated or retired, per the store contract.
- **autopilot** — `/next-do` on a yellow action now records user approval
  and makes it executable (approval is the one channel that legitimizes a
  yellow).
- **self-repair** — new `/self-repair` status command: cycle, self-review
  gate state, files touched/modified, resumes used, evidence count,
  checkpoint path.
- **quality-guards** — new `/quality` status command: feature toggles,
  consecutive failures, turns since green test, turns in run, current task,
  files read, last build state.

## [1.1.0] — 2026-08-23

### Cache-hit optimization

Mods no longer churn the system prompt. The harness has no mod-side cache
API, so hit rates come from provider-level prefix caching — which means the
system prompt must stay byte-identical across turns and every byte of
dynamic content must ride the message tail.

- **quality-guards** — moved the four advisory warnings (drift, test-budget,
  token-budget, run-length) from `appendSystemPrompt` to a `transformContext`
  tail injection. Identical thresholds, counters, and once-per-threshold
  resets; the system prompt is now a stable prefix instead of changing at
  every warning crossing (which previously forced full-history re-processes).
- **command-center** — removed the `Round N/M` counter from the BRIEFING
  system prompt and tail-inject it instead, so the prompt is byte-identical
  for every turn of the state instead of changing every round.
- **learn-loop** — recall injection now splices at `length - 1` instead of
  `length - 2`, confining cache misses to the single final message.
- **memory-bank** — same recall splice fix as learn-loop.

### Mods

- **self-repair** — the completion judge: self-review gate, verdict emission,
  checkpoints, crash recovery, task continuity.
- **autopilot** — verified-momentum engine that spends a small, bounded trust
  budget on safe follow-ups after self-repair proves the task done.
- **quality-guards** — behavioral guardrails: failure coaching, loop
  detection, overwrite/git guards, build guard, budgets.
- **command-center** — structured plan briefing → compilation → review state
  machine.
- **memory-bank** — durable, gated project memory (`.agents/memory/`: L1
  events / L2 registry / L3 lessons) with recall and skill graduation.
- **learn-loop** — autonomous skills manager (`.agents/learning/`): seeds
  candidates from user corrections, distills, trials shadows, promotes on
  verified verdicts, merges, archives — with a receipt for every move.

## [1.0.0] — 2026-08-23

### First public release

Six mods composing one workflow — command-center (intent), quality-guards
(safety), self-repair (truth), autopilot (follow-through), memory-bank
(memory), learn-loop (learning). The core invariant: **self-repair is the
only completion judge** — autopilot only gains initiative after a verified
completion verdict.

### Baseline review — fixes applied per mod

- **self-repair** — closed evidence-collection edge cases; flag minimums;
  removed dead code.
- **autopilot** — ended action lifetime on child-cycle verdicts (the real
  bug: stale action state leaked past an action's lifetime); hardened flags.
- **quality-guards** — once-per-task run-length warning; flag minimums
  (`qg-max-failures: 0` no longer escalates on anything).
- **command-center** — flag minimums; string-safe boolean parsing.
- **memory-bank** — guarded graduation reads; flag minimums; archive typo.
- **learn-loop** — registered the dead `ll-usage-receipts` flag; `/reject`
  and `/rollback` now remove a skill's live install; merge rewrites in place
  and always persists the index; corrected `active/` directory layout.

### Repo hygiene

- Hardened `.gitignore` before the first commit so runtime state
  (`.agents/`, `.commandcode/`, templates) never enters history.
- `scripts/check-contracts.mjs` — mechanical cross-mod contract check:
  event pairing, unique command/tool/renderer names, flag prefixes, exec
  timeouts.
- MIT `LICENSE`, `.gitattributes` (LF line endings), README install docs
  grounded in the real CLI (no invented flags).
- Published on the `main` branch; `package.json` `files` whitelist ships
  only `mods/` and `README.md`.

### Note on verification

Changes are mechanically verified (contract check, per-mod load gate, mod
list with zero warnings, headless smoke run). Behavioral acceptance —
including the cache hit-rate gain from [1.1.0] — lands in live sessions;
each major milestone is re-verified before release.
