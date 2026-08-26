// resultHeadline.ts — the one line above the grid that says what is on it, in the vocabulary the rest of the
// surface uses (decisions.md 2026-08-25): SAVED (in this workspace) and NOT SAVED (in the TruePoint database).
// The old line — "N in your workspace · M more in the database" — named the mechanism; this names the state.
// Pure, so the scope variants, the count floors and the database-only case are a unit test.
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
  /** The database half has pages the grid cannot reach (it is one capped page) — render as a floor. */
  availableIsFloor?: boolean;
  /** A database-only filter is active: the saved half could not be searched at all, and any saved people
   *  on the grid arrived through the database half, marked. The line says where the list came from. */
  workspaceSkipped?: boolean;
}

const n = (v: number) => v.toLocaleString();

export function resultHeadline(i: HeadlineInput): string {
  if (i.loading) return "Loading…";
  const available = `${n(i.available)}${i.availableIsFloor ? "+" : ""}`;
  if (i.workspaceSkipped) {
    const found = `${available} found in the TruePoint database`;
    return i.saved > 0 ? `${found} · ${n(i.saved)} already saved` : found;
  }
  const saved = `${n(i.saved)}${i.savedIsFloor ? "+" : ""} saved`;
  switch (i.scope) {
    case "mine":
      return saved;
    case "exclude":
      return `${available} ${i.available === 1 && !i.availableIsFloor ? "person" : "people"} not yet saved`;
    default:
      return i.available > 0 ? `${saved} · ${available} more available` : saved;
  }
}
