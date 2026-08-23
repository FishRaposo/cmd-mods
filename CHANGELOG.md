# Changelog

All notable changes to the cmd-mods suite are tracked here, one entry per mod.
This file is the single source of truth for what changed and when — keep it
updated with every merged change.

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
