// entry.tsx — the design-sync entry for apps/forge, the operator console.
//
// Everything below is the app's REAL component, imported from apps/forge unmodified. What changes is only
// what sits under them: ./stubs/* replace the token client and Next's router at bundle time (see the alias
// map in manifest.json), so the console runs against ../fixtures instead of the forge-api. No component is
// reimplemented or forked here.
//
// Scope: the six feature surfaces (the console IS these six boards) plus the shell that frames them. The
// route `page.tsx` files are excluded — each is a two-line wrapper that renders the feature component
// below it, so carding them would duplicate every card with an identical render.

export { OverviewPage } from "../../../apps/forge/src/features/overview/components/OverviewPage";
export { CapturesPage } from "../../../apps/forge/src/features/captures/components/CapturesPage";
export { ParsersPage } from "../../../apps/forge/src/features/parsers/components/ParsersPage";
export { ReviewPage } from "../../../apps/forge/src/features/review/components/ReviewPage";
export { SourceFetchesPage } from "../../../apps/forge/src/features/source-fetches/components/SourceFetchesPage";
export { SyncStatusPage } from "../../../apps/forge/src/features/sync-status/components/SyncStatusPage";
export { ForgeShell } from "../../../apps/forge/src/components/shell/ForgeShell";
