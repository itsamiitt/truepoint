// SearchDrawer.tsx — the collapsible filter rail that hosts the People/Accounts switch and whichever
// pane's filter panel is active.
//
// Collapsed is a 40px STRIP, not zero width: the toggle has to stay in one place or reopening the rail
// becomes a hunt. Below 768px the rail leaves the grid entirely and slides over the results as an overlay
// drawer with a scrim, because a 264px column on a 375px screen is not a rail, it is the whole screen.
//
// Presentation + local focus management only. The collapsed/overlay state and its persistence live in
// useDrawerCollapsed; both panes render this same component so the drawer behaves identically on either tab.
"use client";

import { TpIconButton } from "@leadwolf/ui";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import styles from "./search.module.css";

const RAIL_BODY_ID = "search-filter-rail";
// Focus is returned to the toggle by id rather than by ref: TpIconButton does not declare a `ref` prop, and
// teaching the design system one for a single caller is a wider change than this needs.
const TOGGLE_ID = "search-filter-toggle";

export function SearchDrawer({
  collapsed,
  isOverlay,
  onToggle,
  onClose,
  tabs,
  children,
}: {
  collapsed: boolean;
  isOverlay: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** The People/Accounts switch, pinned above the filter groups. */
  tabs: ReactNode;
  /** The active pane's filter panel. */
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Opening the overlay moves focus into the panel; closing returns it to the control that opened it.
  // Without the return hop a keyboard user is dropped at the top of the document every time they dismiss
  // the drawer. (The inline rail needs neither — focus never left the page flow.)
  const wasOpenOverlay = useRef(false);
  useEffect(() => {
    const openOverlay = isOverlay && !collapsed;
    if (openOverlay && !wasOpenOverlay.current) {
      bodyRef.current?.focus();
    } else if (!openOverlay && wasOpenOverlay.current) {
      document.getElementById(TOGGLE_ID)?.focus();
    }
    wasOpenOverlay.current = openOverlay;
  }, [isOverlay, collapsed]);

  return (
    <>
      {isOverlay && !collapsed ? (
        <button
          type="button"
          className={styles.scrim}
          aria-label="Close filters"
          onClick={onClose}
        />
      ) : null}

      <div className={styles.railCol} data-collapsed={collapsed} data-overlay={isOverlay}>
        {/* The toggle lives INSIDE the card while the rail is open (beside the People/Accounts switch —
            no dead band above the card); collapsed, the card is gone, so the strip carries the opener.
            One at a time, same id — the focus-return effect above finds whichever is mounted. */}
        {collapsed ? (
          <div className={styles.railTop}>
            <TpIconButton
              id={TOGGLE_ID}
              label="Show filters"
              aria-expanded={false}
              aria-controls={RAIL_BODY_ID}
              onClick={onToggle}
            >
              <PanelLeftOpen size={16} />
            </TpIconButton>
          </div>
        ) : null}

        {/* `inert` is what actually removes the collapsed panel from the tab order and the accessibility
            tree — CSS visibility alone leaves it announced in some engines. */}
        <div
          id={RAIL_BODY_ID}
          ref={bodyRef}
          className={styles.railBody}
          tabIndex={-1}
          inert={collapsed ? true : undefined}
        >
          <div className={styles.railBar}>
            <div className={styles.tabs}>{tabs}</div>
            <TpIconButton
              id={collapsed ? undefined : TOGGLE_ID}
              label="Hide filters"
              aria-expanded={true}
              aria-controls={RAIL_BODY_ID}
              onClick={onToggle}
            >
              <PanelLeftClose size={16} />
            </TpIconButton>
          </div>
          {children}
        </div>
      </div>
    </>
  );
}

/** The opener rendered in a pane's results header; visible only while the rail is off-canvas (≤768px). */
export function SearchDrawerOpener({ onOpen }: { onOpen: () => void }) {
  return (
    <TpIconButton label="Show filters" className={styles.overlayOpener} onClick={onOpen}>
      <PanelLeftOpen size={16} />
    </TpIconButton>
  );
}
