// searchShell.ts — the contract between the Search composer and whichever pane it mounts.
//
// The composer owns the drawer's open/collapsed state and the People/Accounts switch; each pane renders the
// shell grid and hands the drawer its own filter panel. Passing one object rather than five props keeps the
// pane signatures stable as the shell grows, and keeps the panes from inventing their own drawer state —
// there is exactly one, and it is the composer's.
import type { ReactNode } from "react";
import type { DrawerState } from "./useDrawerCollapsed";

export interface SearchShell extends DrawerState {
  /** The People/Accounts switch, rendered by the composer so both panes show an identical control. */
  tabs: ReactNode;
}
