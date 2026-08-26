// overlayStack.ts — one module-level registry that every layered surface (Dialog, Drawer, DropdownMenu,
// Popover, Combobox) joins while open. It exists to answer two questions no component can answer alone:
//
//   1. "Is Escape mine?" — layers stack (a menu opens inside a dialog), and one Escape press must close
//      ONLY the top-most layer. Before this, overlay.tsx listened on `document`, floating.tsx on `window`,
//      neither stopped propagation, and a single Escape closed a menu AND the dialog under it.
//   2. "May I unlock body scroll?" — the lock is reference-counted across MODAL layers. Before this, two
//      open overlays shared one saved `overflow` value and the first to close unlocked the page behind
//      the one still open.
//
// Handles are plain symbols so a layer can never collide with or forge another's identity.

interface Layer {
  handle: symbol;
  /** Modal layers (Dialog/Drawer) lock body scroll; floating layers (menus, popovers) do not. */
  lock: boolean;
}

let layers: Layer[] = [];
let prevBodyOverflow = "";

function lockedCount(): number {
  return layers.reduce((n, l) => n + (l.lock ? 1 : 0), 0);
}

export function pushLayer(handle: symbol, opts: { lock: boolean }): void {
  if (opts.lock && lockedCount() === 0) {
    prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  layers.push({ handle, lock: opts.lock });
}

export function popLayer(handle: symbol): void {
  const layer = layers.find((l) => l.handle === handle);
  layers = layers.filter((l) => l.handle !== handle);
  if (layer?.lock && lockedCount() === 0) {
    document.body.style.overflow = prevBodyOverflow;
  }
}

/** True when `handle` is the most recently opened layer still on the stack — the one Escape belongs to. */
export function isTopLayer(handle: symbol): boolean {
  return layers.length > 0 && layers[layers.length - 1]?.handle === handle;
}
