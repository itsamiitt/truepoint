"use client";
// overlay.tsx — Dialog (centered modal) + Drawer (edge slide-over). Both render a scrim + a card, close on Esc
// and outside-click, and lock body scroll while open. Rendered inline with fixed positioning + the --tp-z-*
// scale (matching the existing .tp-slideover/.tp-scrim pattern; no portal needed). Styling in primitives.css.
import { type ReactNode, useEffect } from "react";
import { cn } from "../cn.ts";

/** Esc-to-close + body-scroll lock while `open`. */
function useDismiss(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  maxWidth,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  maxWidth?: number;
}) {
  useDismiss(open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="tp-ui-scrim" aria-hidden />
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a convenience; Esc is the keyboard path */}
      <div className="tp-ui-dialog" role="dialog" aria-modal="true" onClick={onClose}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: stops backdrop close when clicking the card */}
        <div
          className="tp-ui-dialog-card"
          role="document"
          onClick={(e) => e.stopPropagation()}
        >
          {title != null ? (
            <div className="tp-ui-dialog-head">
              <h2 className="tp-ui-dialog-title">{title}</h2>
            </div>
          ) : null}
          {description != null ? <p className="tp-ui-dialog-desc">{description}</p> : null}
          {children != null ? <div className="tp-ui-dialog-body">{children}</div> : null}
          {footer != null ? <div className="tp-ui-dialog-foot">{footer}</div> : null}
        </div>
      </div>
    </>
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
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  side?: "right" | "left";
  width?: number;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  useDismiss(open, onClose);
  if (!open) return null;
  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a convenience; Esc is the keyboard path */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the scrim is a dismiss target only */}
      <div className="tp-ui-scrim" aria-hidden onClick={onClose} />
      <aside
        className={cn("tp-ui-drawer", `tp-ui-drawer--${side}`)}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        style={width != null ? { maxWidth: width } : undefined}
      >
        {title != null ? (
          <div className="tp-ui-drawer-head">
            <h2 className="tp-ui-drawer-title">{title}</h2>
            <button type="button" className="tp-ui-iconbtn" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </div>
        ) : null}
        <div className="tp-ui-drawer-body">{children}</div>
        {footer != null ? <div className="tp-ui-drawer-foot">{footer}</div> : null}
      </aside>
    </>
  );
}
