# Index: mods/

## Purpose

Navigation map for the mod sources — the nine standalone TypeScript files that make up the suite. Each mod is a single file with `export default function (cmd: ModApi): void`, registered through the ModApi.

## Files

| Path | Purpose | Edit? |
|---|---|---|
| `self-repair.ts` | The completion judge — self-review gate, verdict emission, checkpoints, git state, task continuity, resume recovery. | With mod behavior change |
| `quality-guards.ts` | Advisory safety warnings — failure coaching, loop detection, overwrite guard, git guard, build guard, test/token budgets, drift, run-length. | With mod behavior change |
| `autopilot.ts` | Verified-momentum engine — tiered follow-ups (green/yellow/red), budget-capped initiative, referee handshake, receipts. | With mod behavior change |
| `command-center.ts` | Structured planning — decision funnel → plan artifact → review. | With mod behavior change |
| `memory-bank.ts` | Durable, gated project memory — L1/L2/L3 store, recall injection, write-bar, auto-graduation. | With mod behavior change |
| `learn-loop.ts` | Skill lifecycle manager — candidate → shadow → active → archived, shadow trials, promotion, merge/decay. | With mod behavior change |
| `cache-tracker.ts` | Prompt-cache observability — live hit-rate footer, per-run JSONL ledger. Registers no prompt hooks. | With mod behavior change |
| `protocol-loader.ts` | Loads `.agents/protocols/*.md` on demand, like skills — discover, match, activate, inject. | With mod behavior change |
| `error-tracker.ts` | Suite-wide error observability — per-mod/per-tool error tracking, footer badge, JSONL ledger. | With mod behavior change |

## Source of truth

- Mod identity and registration: `package.json` → `commandcode.mods` (the `./mods/*.ts` glob).
- Operating policy: the suite's root `AGENTS.md` (always-loaded).
- Shared helpers: `lib/lastUserTaskLabel.ts` (imported by mods, never a mod itself).
- Contract surface: `scripts/check-contracts.mjs` (event pairing, uniqueness, flag prefixes, exec timeouts, protocol twins).

## Add files here when

- A new mod is added to the suite. It must be a single `.ts` file with `export default function (cmd: ModApi): void`, a `FLAG_PREFIXES` entry in `scripts/check-contracts.mjs`, and a row in this table.
- A mod is renamed or removed — update this table, the flag map, and the contract check in the same change.

## Do not put here

- Non-mod code (shared helpers live in `lib/`; maintenance scripts live in `scripts/`).
- Runtime state (use `.commandcode/` in the consumer's project).
- Test files (the suite has no `tests/` dir; behavior is verified by the kit's `node --test` suite and the headless smoke run).

## Maintenance

- Keep the Files table in sync with the actual `mods/*.ts` list; the contract check's `FLAG_PREFIXES` map must cover every mod.
- Keep each mod standalone-installable: duplicated regex tables and helpers across mods are intentional, and the cross-mod contracts are the event schemas, not shared code.
- Re-run `node scripts/check-contracts.mjs` and the headless smoke run before considering a change done.
