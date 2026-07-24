// Public surface of @leadwolf/app-shell — the Next.js app chrome shared by apps/web, apps/admin and
// apps/forge. Before this package each app carried its own near-identical shell, which is how the three
// surfaces drifted apart. Apps keep what is genuinely theirs: the auth/staff gate, the destination list, and
// their own top-bar widgets.
//
// Consume the stylesheet once per app, after the @leadwolf/ui sheets:
//   @import "@leadwolf/app-shell/shell.css";
export {
  AppShellFrame,
  type SidebarRenderProps,
  type TopBarRenderProps,
} from "./AppShellFrame.tsx";
export { Sidebar } from "./Sidebar.tsx";
export { NavItem } from "./NavItem.tsx";
export { UserRow } from "./UserRow.tsx";
export { TopBar, DensityToggle, ShortcutsButton } from "./TopBar.tsx";
export { CommandPalette, type PaletteAction } from "./CommandPalette.tsx";
export { ShortcutsDialog } from "./ShortcutsDialog.tsx";
export { Brandmark, Wordmark, Logo } from "./Logo.tsx";
export { DensityProvider, useDensity } from "./DensityProvider.tsx";
export { useSidebarPin, type SidebarPinApi } from "./useSidebarPin.ts";
export {
  isActive,
  makeSectionTitleResolver,
  paletteEntriesFrom,
  type NavDestination,
  type PaletteEntry,
} from "./nav.ts";
