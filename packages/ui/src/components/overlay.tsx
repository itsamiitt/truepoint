"use client";
// overlay.tsx — Dialog (centered modal) + Drawer (edge slide-over). Rendered in a portal on document.body
// (a `transform`/`filter` ancestor re-parents `position: fixed`, so inline rendering could trap the modal
// inside a card), scrim + card, closed by Esc and outside-click. Styling in primitives.css.
//
// Both are REAL modals, not just styled ones: focus moves in on open, Tab is trapped inside, Escape closes
// only the top-most layer (see overlayStack.ts), and focus returns to the opener on close. `aria-modal`
// without a trap tells assistive tech to ignore the page while real Tab focus leaks straight into it —
// which is worse than no ARIA at all, and is exactly what shipped before this.
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../cn.ts";
import { isTopLayer, popLayer, pushLayer } from "./overlayStack.ts";

/** What the trap can land on. `[tabindex="-1"]` is excluded: programmatically focusable ≠ tab-reachable. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * The shared modal behavior: layer registration (Esc ownership + ref-counted scroll lock), focus-in on
 * open, a Tab trap, and focus-return on close. `onClose` is read through a ref so an inline
 * `onClose={() => …}` at the call site does not re-run the effect — re-running it would re-focus the
 * first control on every parent render, yanking the caret out of whatever field the user is typing in.
 */
function useModal(open: boolean, onClose: () => void, cardRef: RefObject<HTMLElement | null>) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const card = cardRef.current;
    const handle = Symbol("tp-modal");
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pushLayer(handle, { lock: true });

    // Focus the first control, or the card itself when the body has none (card carries tabIndex={-1}).
    if (card) (focusables(card)[0] ?? card).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isTopLayer(handle)) {
          e.stopPropagation();
          onCloseRef.current();
        }
        return;
      }
      if (e.key !== "Tab" || !card) return;
      const items = focusables(card);
      if (items.length === 0) {
        e.preventDefault();
        card.focus();
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const active = document.activeElement;
      // Wrap at the edges; also pull focus back in if it somehow escaped the card.
      if (e.shiftKey && (active === first || !card.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !card.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      popLayer(handle);
      opener?.focus();
    };
  }, [open, cardRef]);
}

/** SSR-safe portal mount: the server renders nothing; overlays only ever open in the browser. */
function usePortalTarget(): HTMLElement | null {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.body);
  }, []);
  return target;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  maxWidth,
  "aria-label": ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  maxWidth?: number;
  /** Accessible name for a title-less dialog. With `title` set the dialog is named by it automatically. */
  "aria-label"?: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const target = usePortalTarget();
  useModal(open, onClose, cardRef);
  if (!open || !target) return null;
  return createPortal(
    <>
      <div className="tp-ui-scrim" aria-hidden />
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a convenience; Esc is the keyboard path */}
      <div
        className="tp-ui-dialog"
        // biome-ignore lint/a11y/useSemanticElements: custom modal — native <dialog> swaps focus/backdrop machinery
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        aria-label={title == null ? ariaLabel : undefined}
        aria-describedby={description != null ? descId : undefined}
        onClick={onClose}
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only — keeps card clicks from closing */}
        <div
          ref={cardRef}
          tabIndex={-1}
          className="tp-ui-dialog-card"
          role="document"
          onClick={(e) => e.stopPropagation()}
          style={maxWidth != null ? { maxWidth } : undefined}
        >
          {title != null ? (
            <div className="tp-ui-dialog-head">
              <h2 className="tp-ui-dialog-title" id={titleId}>
                {title}
              </h2>
            </div>
          ) : null}
          {description != null ? (
            <p className="tp-ui-dialog-desc" id={descId}>
              {description}
            </p>
          ) : null}
          {children != null ? <div className="tp-ui-dialog-body">{children}</div> : null}
          {footer != null ? <div className="tp-ui-dialog-foot">{footer}</div> : null}
        </div>
      </div>
    </>,
    target,
  );
}

export function Drawer({
  open,
  onClose,
  title,
  side = "right",
  width,
  children,
  footer,
  "aria-label": ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  side?: "right" | "left";
  width?: number;
  children?: ReactNode;
  footer?: ReactNode;
  /** Accessible name for a title-less drawer. With `title` set the drawer is named by it automatically. */
  "aria-label"?: string;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const target = usePortalTarget();
  useModal(open, onClose, cardRef);
  if (!open || !target) return null;
  return createPortal(
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a convenience; Esc is the keyboard path */}
      <div className="tp-ui-scrim" aria-hidden onClick={onClose} />
      <aside
        ref={cardRef}
        tabIndex={-1}
        className={cn("tp-ui-drawer", `tp-ui-drawer--${side}`)}
        // biome-ignore lint/a11y/useSemanticElements: drawer keeps <aside>; native <dialog> swaps focus machinery
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        aria-label={title == null ? ariaLabel : undefined}
        style={width != null ? { maxWidth: width } : undefined}
      >
        {title != null ? (
          <div className="tp-ui-drawer-head">
            <h2 className="tp-ui-drawer-title" id={titleId}>
              {title}
            </h2>
            <button type="button" className="tp-ui-iconbtn" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </div>
        ) : null}
        <div className="tp-ui-drawer-body">{children}</div>
        {footer != null ? <div className="tp-ui-drawer-foot">{footer}</div> : null}
      </aside>
    </>,
    target,
  );
}
