# cmd-mods

A monorepo of [Command Code](https://commandcode.ai) mods — the self-improving
learning loop, structured planning, persistence, and more. One repo, many mods.

## Mods

| Mod | Description |
|---|---|
| `command-center` | Structured plan briefing → compilation → review state machine. |
| `quality-guards` | Behavioral guardrails: failure coaching, loop detection, overwrite/git guards, build guard, budgets. |
| `self-repair` | The completion judge: self-review gate, verdict emission, checkpoints, crash recovery, task continuity. |
| `autopilot` | Verified-momentum engine: after self-repair proves the task done, spends a small, bounded trust budget on safe local follow-ups (green executes, yellow/red propose). |
| `memory-bank` | Durable, gated project memory: `.agents/memory/` store (L1 events / L2 registry / L3 lessons), verified-episode feed, recall, graduation into `.agents/skills/`. |
| `learn-loop` | Autonomous skills manager. Seeds candidates from user corrections, runs its own distillation turn, trials candidates as shadows, and auto-promotes them on verified self-repair verdicts — with a receipt for every move. |

## The pipeline

These mods compose into one workflow — each owns one job, and each is
useless without the previous one:

```text
command-center  = intent         (plan / milestones / non-goals)
quality-guards  = safety         (advisory mid-work warnings — never blocks)
self-repair     = truth          (the ONLY completion judge; sole verdict emitter)
autopilot       = follow-through (the ONLY final-verdict consumer; never marks own work done)
memory-bank     = memory         (durable project facts — gated, verified feed)
learn-loop      = learning       (autonomous skills manager — seeds, trials, promotes)
```

The core invariant: **self-repair is the only completion judge. Autopilot
only gets initiative after the referee raises the hand.** A verified
completion emits a `self-repair/verdict` event; a mandate grants momentum;
each autopilot action opens a fresh child verification cycle before anything
else may happen.

### Cross-mod contract

All channels ride `cmd.events` (synchronous, in-process):

```text
self-repair/verdict         self-repair → autopilot
  {version: 2, cycleId, complete, final, missing?, evidence[], files[], at}

self-repair/request-cycle   autopilot → self-repair  (open a child cycle)
  {cycleId, actionId, verify[]}

self-repair/cycle-accepted  self-repair → autopilot  (synchronous ack —
                            autopilot refuses to continue without it)

self-repair/ping / pong     autopilot ⇄ self-repair (referee presence probe
                            at first run_start; no pong → momentum disabled)
```

Design rules:

- Verdicts **never survive across runs** — autopilot clears pending state in
  `onRunEnd` and only accepts verdicts timestamped after the current
  `run_start`.
- With `sr-self-review` off, no verdict is ever emitted → autopilot stays
  muted. No referee judgment, no initiative.
- The harness caps 8 consecutive stop-hook continuations per run; each green
  action costs ~2 (its self-review pass + the action turn). Default
  `auto-max-green-chain = 3` keeps momentum safely under the cap.
- Duplicated regex tables across mods are intentional: each mod must be
  standalone-installable. The contract is the event schema, not shared code.

Receipts land in `.commandcode/autopilot/receipts.jsonl`; autonomous
learn-loop moves land in `.agents/learning/autonomy.jsonl`. Learn-loop's
lifecycle — seed (3+ corrections) → distill (`onStop` turn, budgeted) →
shadow (recall + verify stats) → promote (only on final self-repair verdicts)
→ refine (patches from sessions that used a skill and hit failures) →
merge (overlapping actives proposed at stop time; the agent reads both skills
and decides merge / dismiss / ask — the similarity score only pre-filters) →
archive/delete (unused
skills decay out of `.agents/skills/`, then purge after the deletion window)
— is fully toggleable via the `ll-*` flags. Promotion requires a real
`self-repair/verdict`; without the referee installed, learn-loop still seeds
and distills but never promotes.

Learn-loop **only manages skills it installed itself**: every install writes
`.agents/skills/<id>/.managed.json`, and every touch (sync, merge, demote,
archive, delete) verifies that marker first. User-installed skills are
visible in `/learn status` but never modified, merged into, or deleted.

## Install a single mod

Install the suite, then keep only the mods you want via the object form of
`mods.sources` in your Command Code settings (`~/.commandcode/settings.json`
for user scope):

```bash
commandcode mods add -g your-username/cmd-mods
```

```json
{
  "mods": {
    "sources": [
      {"source": "your-username/cmd-mods", "mods": ["learn-loop.ts"]}
    ]
  }
}
```

## Install the full suite

```bash
commandcode mods add -g your-username/cmd-mods
commandcode mods list    # verify: six mods, zero load warnings
```

Drop `-g` to install project-scoped instead of user-scoped. On Windows the
binary is `commandcode` (alias `command-code`); docs elsewhere shorten it
to `cmd`.

## Project structure

```
cmd-mods/
├── mods/                    # All mod files (one .ts per mod)
│   ├── command-center.ts
│   ├── quality-guards.ts
│   ├── self-repair.ts
│   ├── autopilot.ts
│   ├── memory-bank.ts
│   └── learn-loop.ts
├── scripts/
│   └── check-contracts.mjs  # Mechanical cross-mod contract check (node scripts/check-contracts.mjs)
├── package.json             # Manifest — declares mods via glob
└── README.md
```

## License

MIT
