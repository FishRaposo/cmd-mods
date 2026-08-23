# cmd-mods — agent guidance

This repo is a composable suite of Command Code mods. Each mod is a single
TypeScript file in `mods/` registered through the ModApi, and each is
standalone-installable: duplicated regex tables and helpers across mods are
intentional, and the cross-mod contracts are the event schemas (see README),
not shared code.

## The changelog is part of the change

Every user-visible or behavior-affecting change must update `CHANGELOG.md`
in the same commit — no separate "docs" commits. The changelog is organized
**per mod**, not per commit: entries live under the mod they affect (see
`quality-guards`, `command-center`, etc. in the existing file). Add a new
entry to the relevant mod's section, with a short "why/what" line. Version
headers change only at milestone releases; day-to-day fixes and
optimizations accumulate under the current **Unreleased** heading until the
next bump. When in doubt, follow the format of the existing entries.

## Cache discipline (non-negotiable)

The system prompt must stay byte-identical across turns. Provider prompt
caching keys on the longest common prefix, and everything
`appendSystemPrompt` emits sits before the whole conversation — one changed
character re-processes the entire history.

- Dynamic or per-turn content (round counters, timestamps, counters,
  threshold-crossing warnings, recall digests) belongs in `transformContext`
  (append to the tail of the message array, never splice mid-array),
  `onStop` reasons, or tool `additionalContext`.
- `appendSystemPrompt` content must be static or one-shot (inject once via
  a guard flag, then return `undefined`).
- New code must respect this split; reviewers should treat system-prompt
  churn as a defect.
- Instrumentation must not change the measured: cache observability lives in
  the `cache-tracker` mod, which registers no prompt hooks — it only
  observes `model_request_end` usage and reports via the TUI footer,
  `/cache`, and `~/.commandcode/cache-tracker.jsonl` (one line per run).
  Flush in `onRunEnd` — `onSessionEnd` does not reliably fire in headless
  one-shot processes.

## Verification gates

Before considering a change done:

1. `node scripts/check-contracts.mjs` — mechanical cross-mod contract check.
2. Ensure the changed mods load cleanly (`commandcode mods list` must show
   zero load warnings).
3. Copy the changed files to the user-scope install
   (`~/.commandcode/mods/`) so the installed copies stay byte-identical to
   the repo source.
4. A headless smoke run (`commandcode -p "Reply with exactly SMOKE_OK and
   nothing else"`) to confirm the full suite runs end-to-end.

## Repo conventions

- `main` is the default branch; commit messages are conventional
  (`fix(mod): …`, `perf(mod): …`, `chore: …`).
- Runtime state never enters history — `.agents/`, `.commandcode/`,
  `_templates/` and similar are gitignored.
- The `package.json` `files` whitelist ships only distributable source;
  new files must be added there if they belong in the package.
- Event contracts: namespaced event names (`self-repair/verdict`,
  `memory-bank/graduate`) — emit and consume through `cmd.events`, never
  through shared modules.
