// WorkspaceScopeControl.tsx — All / Only mine / Exclude mine (search-consolidation 02 §Workspace-status).
//
// This resolves into WHICH ENGINE RUNS rather than into a filter clause, and that is the whole design:
//
//   All            both engines run; results merge, owned first
//   Only mine      the global engine is disabled — the owned engine alone answers
//   Exclude mine   the owned engine is disabled — the global engine runs with the filtered-keyset correction
//
// The two non-default modes therefore query exactly ONE population, which is what makes their sort and their
// count exact. In All mode the merged grid is two concatenated sorted lists (owned rows always above global
// ones) — an honest wart inherited from the People tab, and unfixable without either bridging every owned
// record to Layer 0 or tearing down the leadwolf_app REVOKE wall. Anyone who needs a true sort has the two
// single-population modes; the labelled divider in the grid keeps All mode legible rather than mysterious.
//
// It is NOT a field on the global query contract: "is this in MY workspace" is a fact about the caller, not
// about the company, and putting it in the contract would invite a workspace-dependent predicate into a
// population that has no workspace column.
"use client";

import { SegmentedControl } from "@leadwolf/ui";

export const WORKSPACE_SCOPES = ["all", "mine", "exclude"] as const;
export type WorkspaceScope = (typeof WORKSPACE_SCOPES)[number];

export const DEFAULT_WORKSPACE_SCOPE: WorkspaceScope = "all";

export function parseWorkspaceScope(raw: string | null | undefined): WorkspaceScope {
  return WORKSPACE_SCOPES.includes(raw as WorkspaceScope)
    ? (raw as WorkspaceScope)
    : DEFAULT_WORKSPACE_SCOPE;
}

const ITEMS = [
  { value: "all", label: "All" },
  { value: "mine", label: "In workspace" },
  { value: "exclude", label: "New to me" },
];

export function WorkspaceScopeControl({
  scope,
  onChange,
}: {
  scope: WorkspaceScope;
  onChange: (next: WorkspaceScope) => void;
}) {
  return (
    <SegmentedControl
      items={ITEMS}
      value={scope}
      onChange={(v) => onChange(v as WorkspaceScope)}
      aria-label="Filter by whether records are already in your workspace"
    />
  );
}
