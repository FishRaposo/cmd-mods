# AGENTS.md — mods/

## Purpose

Per-folder tier rules for the mod sources. This file loads on demand when work touches a mod's source; the root `AGENTS.md` stays the always-loaded owner of operating policy.

## Rules

- **One mod, one file.** Every mod is a single TypeScript file with `export default function (cmd: ModApi): void`, registered through the ModApi. The file is standalone-installable — the harness auto-loads every `.ts` in the install dir as a mod.
- **Standalone-installable, but import the shared helper.** Duplicated regex tables and helpers across mods are intentional (per the root AGENTS.md), and the cross-mod contracts are the event schemas, not shared code. The one exception: `lastUserTaskLabel` / `SESSION_META_SIGNALS` must be imported from `lib/lastUserTaskLabel.ts`, never inlined — the shared helper exists so self-repair and quality-guards can't drift.
- **Flag-prefix map is the manifest.** Every mod keeps a `FLAG_PREFIXES` entry in `scripts/check-contracts.mjs`; a new mod that doesn't update the map fails the contract check.
- **Harness-neutral twins are declared, not assumed.** A mod that mechanically twins a templates-kit protocol declares it in its header ("Harness-neutral twin: …"). The contract check validates both sides of the map.

## Related

- `mods/index.md` — folder map.
- `AGENTS.md` — root tier (always-loaded operating policy).
- `scripts/check-contracts.mjs` — the enforcing check.
- `lib/lastUserTaskLabel.ts` — the shared helper (imported, never inlined).
