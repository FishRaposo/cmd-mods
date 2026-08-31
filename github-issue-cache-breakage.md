# [BUG] `appendSystemPrompt` with per-turn content silently destroys provider prompt caching

### Summary

Custom mods that return per-turn dynamic content from the `appendSystemPrompt` hook
silently destroy provider prompt caching. Everything `appendSystemPrompt` emits is
prepended as a prefix before the whole conversation, and provider prompt caches
(Anthropic / OpenAI / DeepSeek-style prefix caching) key on the longest common
prefix — so one changed character invalidates the cache and forces the provider to
re-process the entire history (system prompt + every prior turn) on that turn.

There is no mod-side cache API, and nothing in the ModApi documents or enforces
that `appendSystemPrompt` output must be byte-stable across turns. It is the
natural hook to reach for when a mod "just wants to add context" — and it is the
worst possible place for content that changes.

A related, separate failure mode: splicing dynamic messages one slot too deep in
`transformContext` (at `length - 2` instead of `length - 1`) spreads a cache miss
across two trailing messages instead of confining it to the final one.

### Expected Behavior

- `appendSystemPrompt` is documented as a **static or one-shot** hook: output must
  be byte-identical across turns (or stable per discrete state), or injected once
  behind a guard flag and then return `undefined`.
- Per-turn dynamic context is supported through a first-class, cache-safe mechanism
  (today the de-facto pattern is tail-append via `transformContext`).
- In dev mode, the harness warns when a registered `appendSystemPrompt` output
  changes between turns, so mod authors catch cache-breaking prompt churn early.

### Actual Behavior

- The `appendSystemPrompt` contract is silent on cache stability; mod authors
  reasonably use it for per-turn content (round counters, threshold advisories)
  and get **near-zero `cacheReadTokens`** with no diagnostic.
- Any single character change in the system-prompt prefix invalidates the cached
  prefix for the entire conversation history on that turn.
- Incorrect message splice depth in `transformContext` (e.g. `length - 2` instead
  of `length - 1`) spreads a cache miss across two trailing messages instead of
  confining it to the final one — even when the system prompt itself is stable.

### Steps to reproduce the issue

1. Install or author a mod whose `appendSystemPrompt` hook returns content that
   changes each turn (e.g. embed `Round N/M` in a briefing prompt, or flip
   advisory text at a threshold crossing).
2. Run a multi-turn session against a provider that supports prefix caching.
3. Observe usage on `model_request_end` — e.g. via a pure observer mod that reads
   `cacheReadTokens` / `cacheWriteTokens` and registers no prompt hooks.
4. Compare against a byte-stable system prompt (static / one-shot
   `appendSystemPrompt` output, dynamic content appended to the message tail
   via `transformContext` instead).

**Result:** system-prompt churn correlates with near-zero cache reads; byte-stable
system prompt + tail injection yields consistent cache hits.

Optional related repro: in `transformContext`, splice a dynamic recall message at
`messages.length - 2` instead of `length - 1` and observe the cache miss span two
trailing messages rather than one.

### Command Code Version

0.1.2 _(auto-update channel; last observed ~2026-08-23 — replace with output of `cmd --version`)_

### Operating System

Windows

### Terminal/IDE

Command Code Desktop / CLI

### Shell

PowerShell

### Session file (optional)

_No response_

### Fix prompt (optional)

Document and harden the mod caching contract:

1. **Document `appendSystemPrompt`:** output must be byte-identical across turns
   (or stable per discrete state), or one-shot guarded; per-turn content belongs
   on the message tail, not the system prefix.
2. **Consider a first-class cache-safe per-turn injection API** — standardize the
   tail-append pattern mod authors already use in `transformContext`.
3. **Add a dev-mode diagnostic:** serialize-and-compare `appendSystemPrompt` output
   per turn; warn when it changes.

Relevant harness surface: `appendSystemPrompt`, `transformContext`, ModApi docs,
and optional dev-mode diagnostics. Verify with a two-mod setup: one that injects
dynamic system text (should warn / miss cache) and one observer that only reads
`cacheReadTokens` on `model_request_end`.

### Additional context

**Evidence from our mod suite** (all occurrences fixed in the mods on 2026-08-23,
not the harness — see [command-code-mods CHANGELOG 1.1.0](https://github.com/FishRaposo/command-code-mods/blob/main/CHANGELOG.md)):

1. **Per-round counter in a briefing prompt (`command-center`).** A plan-briefing
   state machine embedded `Round N/M` in its BRIEFING system prompt. It changed
   every round, forcing a full-history re-process per round (up to `maxRounds`
   times per briefing). Fixed by removing the counter from `appendSystemPrompt`
   and tail-injecting it via `transformContext`.
2. **Advisory warnings that change at threshold crossings (`quality-guards`).**
   Four guardrail warnings (drift, test-budget, token-budget, run-length) lived
   in `appendSystemPrompt`. Their text changed at every warning crossing, so the
   system prompt stopped being a stable prefix and forced full-history
   re-processes. Fixed by moving the same thresholds/counters to a
   `transformContext` tail injection.
3. **Recall injection splicing one message too deep (`learn-loop`, `memory-bank`).**
   Separate from `appendSystemPrompt`: recall rode `transformContext` but was
   spliced at `length - 2` instead of `length - 1`, spreading a cache miss across
   two trailing messages instead of confining it to the final one.

A pure observer mod (`cache-tracker`, added afterward) confirmed the correlation
end-to-end: system-prompt churn → near-zero cache reads; byte-stable system prompt
→ consistent cache hits. Measured interactive sessions on DeepSeek V4 after the
fix showed ~48.7% hit rate over 25 turns (see suite README).

**Root cause**

- No mod-side cache API; cache performance is entirely at the mercy of provider
  prefix caching.
- `appendSystemPrompt` contract undocumented on stability requirements.
- No diagnostic when registered prompt output changes between turns.
- No guidance that `transformContext` splices should stay at the tail
  (`length - 1`) to confine misses.

**Workaround shipped in affected mods**

- `appendSystemPrompt` carries only static / one-shot / per-state-stable content
  (e.g. memory-bank's session-start digest is one-shot behind a guard flag;
  command-center's BRIEFING/COMPILING/REVIEW prompts are byte-stable within each
  state).
- Per-turn dynamic content (round counter, advisories) moved to `transformContext`
  tail injection so the cached prefix stays byte-identical.
- Recall/injection splices at `length - 1` to confine cache misses to a single
  final message.
- Cache observability lives in a separate observer mod that registers no prompt
  hooks, so instrumentation never changes the measured value.

**Mods affected:** `command-center`, `quality-guards`, `learn-loop`, `memory-bank`
