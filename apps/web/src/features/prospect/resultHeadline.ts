// resultHeadline.ts — the one line above the grid that says what is on it, in the vocabulary the rest of the
// surface uses (decisions.md 2026-08-25): SAVED (in this workspace) and NOT SAVED (in the TruePoint database).
// The old line — "N in your workspace · M more in the database" — named the mechanism; this names the state.
// Pure, so the three scope variants + the count cap are a unit test.
import type { WorkspaceScope } from "@/components/search";

export interface HeadlineInput {
  scope: WorkspaceScope;
  loading: boolean;
  /** Saved contacts matching (the count endpoint's total, or the loaded rows when it has not answered). */
  saved: number;
  /** The count stopped at its cap, or more pages exist than the number reflects — render as a floor. */
  savedIsFloor: boolean;
  /** Not-saved people currently on the grid (the database half). */
  available: number;
}

const n = (v: number) => v.toLocaleString();

export function resultHeadline(i: HeadlineInput): string {
  if (i.loading) return "Loading…";
  const saved = `${n(i.saved)}${i.savedIsFloor ? "+" : ""} saved`;
  switch (i.scope) {
    case "mine":
      return saved;
    case "exclude":
      return `${n(i.available)} ${i.available === 1 ? "person" : "people"} not yet saved`;
    default:
      return i.available > 0 ? `${saved} · ${n(i.available)} more available` : saved;
  }
}
