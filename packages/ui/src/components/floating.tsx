"use client";
// floating.tsx — anchored floating UI: Popover (click), DropdownMenu (click → menu items), Tooltip (hover/focus).
// Positioned with simple CSS relative/absolute anchoring (no collision engine) on the --tp-z-popover layer;
// closes on outside-click + Esc. Dependency-free. Styling lives in primitives.css.
import { Fragment, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { cn } from "../cn.ts";

function useOutside(open: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, ref]);
}

export interface PopoverProps {
  /** Render the trigger; wire onClick to `toggle` and reflect `open` for aria. */
  trigger: (args: { toggle: () => void; open: boolean }) => ReactNode;
  /** Panel content, or a render-fn receiving a `close` callback. */
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  /** Vertical direction — "top" opens upward (for triggers near the bottom edge). */
  side?: "top" | "bottom";
  className?: string;
}

export function Popover({ trigger, children, align = "start", side = "bottom", className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useOutside(open, close, ref);
  return (
    <div className="tp-ui-anchor" ref={ref}>
      {trigger({ toggle: () => setOpen((v) => !v), open })}
      {open ? (
        <div
          className={cn(
            "tp-ui-popover",
            align === "end" ? "tp-ui-popover--end" : "tp-ui-popover--start",
            side === "top" && "tp-ui-popover--up",
            className,
          )}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}

export interface MenuItem {
  label: ReactNode;
  onSelect?: () => void;
  icon?: ReactNode;
  danger?: boolean;
  separatorBefore?: boolean;
}

export function DropdownMenu({
  trigger,
  items,
  align = "end",
  side = "bottom",
}: {
  trigger: (args: { toggle: () => void; open: boolean }) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  side?: "top" | "bottom";
}) {
  return (
    <Popover trigger={trigger} align={align} side={side}>
      {(close) => (
        <div className="tp-ui-menu" role="menu">
          {items.map((it, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: menu items are a static, caller-ordered list
            <Fragment key={i}>
              {it.separatorBefore ? <div className="tp-ui-menu-sep" role="separator" /> : null}
              <button
                type="button"
                role="menuitem"
                className={cn("tp-ui-menu-item", it.danger && "tp-ui-menu-item--danger")}
                onClick={() => {
                  it.onSelect?.();
                  close();
                }}
              >
                {it.icon != null ? (
                  <span style={{ display: "inline-flex" }} aria-hidden>
                    {it.icon}
                  </span>
                ) : null}
                {it.label}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </Popover>
  );
}

export function Tooltip({ label, children }: { label: ReactNode; children: ReactNode }) {
  const [show, setShow] = useState(false);
  const id = useId();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus wrapper exposes the tip via aria-describedby
    <span
      className="tp-ui-anchor"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      aria-describedby={show ? id : undefined}
    >
      {children}
      {show ? (
        <span className="tp-ui-tooltip" role="tooltip" id={id}>
          {label}
        </span>
      ) : null}
    </span>
  );
}
