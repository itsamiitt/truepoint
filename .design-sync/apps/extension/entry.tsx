// entry.tsx — the design-sync entry for apps/extension, the MV3 browser extension.
//
// The extension's UI layer is four components: the side panel, the toolbar popup, and the two brand pieces
// they share. `main.tsx` in each surface is a createRoot bootstrap, not a component, so it is excluded.
//
// Only ../../shared/client.ts is stubbed (the single chrome.runtime touch point) — see stubs/client.ts.
// Everything else these components import runs for real: the i18n catalogue, the env origins, the IndexedDB
// helpers, and the zod message schemas.

export { Panel } from "../../../apps/extension/src/ui/panel/Panel";
export { Popup } from "../../../apps/extension/src/ui/popup/Popup";
export { CreditsPill } from "../../../apps/extension/src/ui/brand/CreditsPill";
export { Mark } from "../../../apps/extension/src/ui/brand/Mark";

// The IndexedDB handle the panel's Captured tab reads through. Exported so a preview can seed the `recent`
// store the way the service worker does after a capture — without it the panel can only ever show its
// first-run empty state, which is the least informative of its real states. Lowercase, so the converter
// never treats it as a component.
export { db } from "../../../apps/extension/src/shared/idb";
