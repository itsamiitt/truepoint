// Shared preview shell for the prospect slice — the providers the app's (shell) layout supplies.
//
// Not a component and not a card: files prefixed with `_` are preview helpers (same convention as
// _glyphs.tsx), so package-build logs a harmless "stale preview" line for it.
//
// Why it exists: 14 of the 27 prospect components call useToast(), which throws outside <ToastProvider>,
// and three read the RevealStore. In the app both come from the shell, so a standalone card has to compose
// them — that is the true render, not a workaround. ProspectPage wraps its own RevealStore, so it only
// needs `toast`.
import { Providers, RevealStoreProvider, ToastProvider, useRevealStore } from "@leadwolf/ui";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * Expand every collapsed facet group under the returned ref, once, on mount.
 *
 * FilterPanel's groups are `useState(false)` accordions with no open prop, so a card would otherwise show
 * five headers and nothing else — the facets are the whole point of the component. Clicking the real
 * headers is the same force-open technique NOTES.md records for Popover/Combobox: it drives the component
 * through its own API rather than faking an expanded look.
 */
export function useExpandGroups<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    for (const b of ref.current?.querySelectorAll<HTMLButtonElement>(
      "section > button[aria-expanded='false']",
    ) ?? []) {
      b.click();
    }
  }, []);
  return ref;
}

/**
 * Bulk-hydrate owned reveal data, the way ProspectPage does for its visible rows on load. Without this the
 * store is empty and a revealed row can only show the coarse "Revealed" badge — the value it already owns
 * would be missing, which is the opposite of what the surface does in the app.
 */
function Hydrate({ ids, children }: { ids: string[]; children: ReactNode }) {
  const { hydrate } = useRevealStore();
  const key = ids.join(",");
  useEffect(() => {
    if (key) hydrate(key.split(","));
  }, [hydrate, key]);
  return <>{children}</>;
}

export function Shell({
  children,
  reveal = false,
  hydrate,
}: {
  children: ReactNode;
  /** Mount the RevealStore — required by RevealCell, RevealDialog, and anything that renders them. */
  reveal?: boolean;
  /** Contact ids whose already-owned reveal data should be loaded before the card paints. */
  hydrate?: string[];
}) {
  const inner = hydrate?.length ? <Hydrate ids={hydrate}>{children}</Hydrate> : children;
  // Providers is the app's own client provider stack (TanStack Query). It wraps everything because the
  // query client is mounted by the ROOT layout in the app, above the shell — and because a component that
  // calls useQueryClient() throws outside it, which is exactly how 17 prospect cards went blank at once.
  return (
    <Providers>
      <ToastProvider>
        {reveal || hydrate?.length ? <RevealStoreProvider>{inner}</RevealStoreProvider> : inner}
      </ToastProvider>
    </Providers>
  );
}

/**
 * Click one button under the returned ref on mount — the force-open lever for menus whose `open` state is
 * internal and whose `toggle` is only handed to an inline trigger render-prop (NOTES.md records the same
 * pattern for Popover/DropdownMenu/Combobox). Defaults to the first icon-only button, which is what these
 * toolbars use as a menu trigger.
 */
export function useOpenMenu<T extends HTMLElement>(match?: (b: HTMLButtonElement) => boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const buttons = [...(ref.current?.querySelectorAll("button") ?? [])];
    const target = match
      ? buttons.find(match)
      : buttons.find((b) => b.querySelector("svg") && !b.textContent?.trim());
    // Deferred a tick: the trigger has to be mounted and bound before the click registers.
    const id = setTimeout(() => target?.click(), 0);
    return () => clearTimeout(id);
  }, [match]);
  return ref;
}

/** A neutral surface for cards whose component is a small control rather than a full panel. */
export const pad: React.CSSProperties = {
  padding: 16,
  background: "var(--tp-surface)",
  borderRadius: "var(--tp-radius-card, 10px)",
};

/** A sized, transform-anchored stage for the slice's fixed-position overlays (Drawers, Dialogs). */
export function Stage({ children, height = 520 }: { children: ReactNode; height?: number }) {
  return (
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
  );
}
