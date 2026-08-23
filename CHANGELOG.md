# Changelog

All notable changes to the cmd-mods suite are tracked here, one entry per mod.
This file is the single source of truth for what changed and when — keep it
updated with every merged change.

## [Unreleased]

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
