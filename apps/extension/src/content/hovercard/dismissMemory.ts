// dismissMemory.ts — PURE session memory for the card's ✕. Closing the card is a statement about a SUBJECT,
// not about a moment: before this, dismissing on /in/x and clicking through to /in/x/details re-showed the
// card on the same person (every nav-key change re-evaluates), which turns the dismiss into a whack-a-mole.
// Scope is deliberately small: per-subject, in-memory, gone on page reload — a new subject always shows, and
// nothing is persisted (a durable "never show again" is a settings decision, not a side effect of one ✕).
export class DismissMemory {
  private readonly dismissed = new Set<string>();

  dismiss(subjectKey: string): void {
    this.dismissed.add(subjectKey);
  }

  isDismissed(subjectKey: string): boolean {
    return this.dismissed.has(subjectKey);
  }

  /** An explicit user gesture toward the subject (Save, panel open) un-dismisses it — they re-engaged. */
  revive(subjectKey: string): void {
    this.dismissed.delete(subjectKey);
  }
}
