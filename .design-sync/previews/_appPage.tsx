// Shared preview helper for whole-page app surfaces (Forge and Admin consoles).
//
// Not a component and not a card: files prefixed with `_` are preview helpers (same convention as
// _glyphs.tsx and _prospectShell.tsx), so package-build logs a harmless "stale preview" line for it.
//
// Why it exists: a console page is written to sit inside its app's shell, which supplies the page
// background, the max-width, and the scroll container. Rendered bare in a card it floats on white with no
// gutter and reads as a fragment rather than a screen. `Page` restores exactly that frame — nothing more,
// so what the card shows is still the real component and not a re-skin.
//
// ONE STORY PER PAGE, deliberately. These pages take no props: every one of them fetches through its own
// hook, so the only axis that could vary between cells is what the transport answers — and the fixture
// router is module-level, shared by every cell rendering in the same card. A per-story override would
// therefore leak across cells and show the wrong state on the wrong card. The loaded state is the one worth
// designing against; the empty/error/loading branches are covered by StateSwitch's own cards.

import { ToastProvider } from "@leadwolf/ui";
import type { ReactNode } from "react";

/**
 * The page frame the app shell provides: surface colour, padding, a scroll boundary — and the ToastProvider.
 *
 * The provider is not decoration. Every console surface that performs a write calls `useToast()` to report
 * the outcome, and that hook THROWS outside its provider: 28 of the admin cards rendered empty until this
 * wrapper existed. In the app the provider comes from the shell above the page, so composing it here is the
 * true render, not a workaround.
 */
export function Page({ children, height = 900 }: { children: ReactNode; height?: number }) {
  return (
    <ToastProvider>
      <div
        style={{
          height,
          overflow: "auto",
          background: "var(--tp-canvas, var(--tp-surface))",
          padding: "24px 28px",
          borderRadius: 8,
        }}
      >
        {children}
      </div>
    </ToastProvider>
  );
}

/**
 * A sized, transform-anchored stage for fixed-position overlays (dialogs) inside a card. Carries the
 * ToastProvider for the same reason Page does — a dialog that saves reports the result through useToast.
 */
export function Stage({ children, height = 520 }: { children: ReactNode; height?: number }) {
  return (
    <ToastProvider>
      <div
        style={{
          position: "relative",
          height,
          transform: "translateZ(0)",
          overflow: "hidden",
          borderRadius: 8,
          background: "var(--tp-surface)",
        }}
      >
        {children}
      </div>
    </ToastProvider>
  );
}

/** A neutral surface for cards whose component is a small control rather than a full page. */
export const pad: React.CSSProperties = {
  padding: 16,
  background: "var(--tp-surface)",
  borderRadius: "var(--tp-radius-card, 10px)",
};
