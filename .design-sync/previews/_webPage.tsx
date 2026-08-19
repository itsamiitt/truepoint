// Shared preview frame for apps/web feature surfaces.
//
// Not a component and not a card: files prefixed with `_` are preview helpers, so package-build logs a
// harmless "stale preview" line for it.
//
// Why this exists separately from _appPage.tsx: web's root layout mounts `Providers` (the TanStack Query
// client) on top of the toast provider, and 39 web surfaces call `useQueryClient()`, which THROWS without
// it. The admin and forge bundles do not export `Providers` at all — a shared frame that imported it would
// fail to compile in those projects — so the web frame is its own file rather than a conditional.
//
// ONE STORY PER SURFACE, deliberately: these components take no props and fetch through their own hooks, so
// the only axis that could vary between cells is what the transport answers, and the fixture router is
// module-level and shared by every cell rendering in the same card.

import { Providers, ToastProvider } from "@leadwolf/ui";
import type { ReactNode } from "react";

/** The frame the app shell provides: providers, surface colour, padding, and a scroll boundary. */
export function Page({ children, height = 900 }: { children: ReactNode; height?: number }) {
  return (
    <Providers>
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
    </Providers>
  );
}

/** A sized, transform-anchored stage for the fixed-position overlays (dialogs, drawers) inside a card. */
export function Stage({ children, height = 520 }: { children: ReactNode; height?: number }) {
  return (
    <Providers>
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
    </Providers>
  );
}

/** A neutral card surface for previews whose component is a small control rather than a full surface. */
export function Frame({ children, width }: { children: ReactNode; width?: number }) {
  return (
    <Providers>
      <ToastProvider>
        <div
          style={{
            width,
            padding: 16,
            background: "var(--tp-surface)",
            border: "1px solid var(--tp-hairline-2, #eceef1)",
            borderRadius: "var(--tp-radius-card, 10px)",
          }}
        >
          {children}
        </div>
      </ToastProvider>
    </Providers>
  );
}
