// Shared helper: extract the current task label from the user's real prompt.
//
// Both self-repair (sr-task-continuity, sr-resume) and quality-guards
// (qg-drift, qg-run-length) need to know "what is the user actually working
// on right now?" — and both previously inlined the same logic. Duplication
// means any change to the heuristic (e.g. adding a new meta-talk term to
// SESSION_META_SIGNALS) has to be made in two files, and the two will drift.
//
// The current task label is the LAST user message in the conversation that:
//   1. Carries actual text (skips tool-result user messages which have no text).
//   2. Is not session-state talk (resumes, checkpoints, drift reminders).
//   3. Is long enough to be a real task (≥12 chars; "yes", "1-2", "approve"
//      are continuations, not new tasks).
//
// Truncated at a word boundary at 80 chars so the label fits in status
// footers and recap prompts without mid-word artifacts.
//
// Returns null when the latest user text is meta-talk (resumes, drift
// reminders, etc.) so callers can fall through to a different signal.

export const SESSION_META_SIGNALS =
  /\b(interrupt|resume|resuming|checkpoint|mid.?task|replay|fragment|drift|advisory|mod-managed|do not restart|continue from exactly|from where you stopped|from where you left off|work appears incomplete|no restart)\b/i;

export function lastUserTaskLabel(messages: readonly unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | null | undefined;
    if (!m || m.role !== 'user') continue;
    const content = m.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((p: unknown) => typeof p === 'object' && p !== null &&
          (p as Record<string, unknown>).type === 'text')
        .map((p: unknown) => String((p as Record<string, unknown>).text || ''))
        .join(' ');
    }
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length === 0) continue; // tool-result user messages carry no text
    if (SESSION_META_SIGNALS.test(clean)) return null;
    if (clean.length < 12) continue; // "yes", "approve", "1-2" are continuations
    return clean.length > 80 ? `${clean.slice(0, 80).replace(/\s+\S*$/, '')}…` : clean;
  }
  return null;
}
