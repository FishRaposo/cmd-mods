# Contributing to cmd-mods

Thanks for helping make this suite better. It's small by design, so the bar
is simple and mechanical.

## The changelog is part of the change

Every user-visible or behavior-affecting change updates `CHANGELOG.md` in the
**same commit** — no separate "docs" commits. Entries are organized per mod
under the current **Unreleased** heading. Version headers bump only at
milestone releases.

## Commit style

- Conventional prefixes: `fix(mod): …`, `perf(mod): …`, `feat(mod): …`, `chore: …`.
- One cohesive change per commit — each mod's changes land in their own
  diffable commit.

## Architecture rules

- **Each mod is standalone-installable.** Duplicated regex tables and helpers
  across mods are intentional — the cross-mod contract is the event schema
  (see README), never shared code.
- **Namespaced events only.** Emit and consume through `cmd.events` with
  namespaced names (`self-repair/verdict`, `memory-bank/graduate`).
- **Cache discipline.** The system prompt must stay byte-identical across
  turns: `appendSystemPrompt` content is static or one-shot; dynamic content
  rides `transformContext` (tail append), `onStop` reasons, or tool
  `additionalContext`. Injected messages use array content blocks —
  `content: [{type: 'text', text}]` — never raw strings.
- **Ownership markers.** A mod that writes to shared locations must stamp an
  owner marker and refuse to clobber artifacts it doesn't own.

## Verification before opening a PR

1. `node scripts/check-contracts.mjs` — must pass (CI also runs this).
2. The changed mods load cleanly (`commandcode mods list` shows zero load
   warnings).
3. A headless smoke run completes:
   `commandcode -p "Reply with exactly SMOKE_OK and nothing else"`.

## What makes a good mod change

- Fixes the root cause, not the symptom — and documents the root cause.
- Guards the guardrails: budget caps, min/max flag validation, and
  refuse-and-suggest on conflicts.
- Receipts for autonomous actions: what ran, why it belonged, how it was
  verified, how to undo it.
