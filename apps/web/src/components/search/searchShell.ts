// searchShell.ts — the contract between the Search composer and whichever pane it mounts.
//
// The composer owns the drawer's open/collapsed state and the People/Accounts switch; each pane renders the
// shell grid and hands the drawer its own filter panel. Passing one object rather than five props keeps the
// pane signatures stable as the shell grows, and keeps the panes from inventing their own drawer state —
// there is exactly one, and it is the composer's.
import type { ReactNode } from "react";
import type { DrawerState } from "./useDrawerCollapsed";
import type { ProfileKind } from "./useProfileParam";
import type { UseWorkspaceScope } from "./useWorkspaceScope";

export interface SearchShell extends DrawerState {
  /** The People/Accounts switch, rendered by the composer so both panes show an identical control. */
  tabs: ReactNode;
  /**
   * Open a profile drawer for one row. The panes call this instead of routing, because the design system
   * forbids navigating away from a list to show a detail — and because the composer, not the pane, owns
   * which drawer is mounted (it is a URL param, so the open profile is shareable).
   */
  openProfile: (kind: ProfileKind, key: string) => void;
  /**
   * All / In-workspace / New-to-me. Owned by the composer because it is shared by both tabs (a rep's "only
   * show me what I don't already have" is a habit that carries across People and Accounts) and because it
   * resolves into WHICH ENGINE RUNS rather than into a filter clause — see WorkspaceScopeControl.
   */
  workspace: UseWorkspaceScope;
}
