# appendSystemPrompt with per-turn content breaks provider prompt caching

## Summary

Custom mods that return per-turn dynamic content from the `appendSystemPrompt`
hook silently destroy provider prompt caching. Everything `appendSystemPrompt`
emits is prepended as a prefix before the whole conversation, and provider
prompt caches (Anthropic / OpenAI prefix caching) key on the longest common
prefix — so one changed character invalidates the cache and forces the
provider to re-process the entire history (system prompt + every prior turn)
on that turn.

There is no mod-side cache API, and nothing in the ModApi documents or
enforces that `appendSystemPrompt` output must be byte-stable across turns. It
is the natural hook to reach for when a mod "just wants to add context" — and
it is the worst possible place for content that changes.

## Evidence

Real occurrences in our seven-mod suite (all fixed in the mods, not the
harness):

1. **Per-round counter in a briefing prompt.** A plan-briefing state machine
   embedded `Round N/M` in its system prompt. It changed every round, forcing
   a full-history re-process per round (up to `maxRounds` times per briefing).
2. **Advisory warnings that flip at threshold crossings.** Four guardrail
   warnings (drift, token-budget, test-budget, run-length) were appended to
   the system prompt. Their text changed turn-to-turn at threshold crossings,
   forcing a full-history re-process twice per crossing — once when the
   warning appeared, once when it cleared.
3. **Recall injection splicing one message too deep.** Context was spliced at
   `length - 2` instead of `length - 1`, spreading a cache miss across two
   trailing messages instead of confining it to the final one.

We also shipped a pure observer mod (`cache-tracker`) that reads
`model_request_end` usage (`cacheReadTokens` / `cacheWriteTokens`) and
confirmed the correlation end-to-end: system-prompt churn → near-zero cache
reads; byte-stable system prompt → consistent cache hits.

## Root cause

- The harness has no mod-side cache API; cache performance is entirely at the
  mercy of provider prefix caching.
- The `appendSystemPrompt` hook contract is undocumented on this point: output
  must be static or one-shot (inject once behind a guard flag, then return
  `undefined`). Per-turn content belongs at the tail of the message array.
- There is no diagnostic signal when a registered prompt changes between
  turns — a dev-mode warning (serialize-and-compare the hook output per turn)
  would have caught all three cases instantly.

## Workaround we shipped (in the mods)

- `appendSystemPrompt` now carries only static / one-shot content, guarded by
  a module-scoped flag that flips on first injection.
- All per-turn dynamic content (round counter, advisories) moved to
  `transformContext` tail injection — appended to the end of the message
  array, so the cached prefix stays byte-identical.
- Recall/injection splices at `length - 1` to confine cache misses to a single
  final message.
- Cache observability lives in a separate observer mod that registers no
  prompt hooks, so instrumentation never changes the measured value.

## Ask

1. Document the contract on `appendSystemPrompt`: output must be byte-identical
   across turns, or one-shot guarded; per-turn content belongs on the message
   tail.
2. Consider a first-class, cache-safe way to inject per-turn context (the
   tail-append pattern in `transformContext` is the de-facto mechanism today —
   standardizing it would help mod authors).
3. Consider a dev-mode diagnostic that flags when `appendSystemPrompt` output
   changes between turns.

## Environment

- Command Code harness: auto-updated ~2026-08-23 (auto-update channel)
- Mods affected: `command-center`, `quality-guards`, `learn-loop`, `memory-bank`