"use client";
// floating.tsx — anchored floating UI: Popover (click), DropdownMenu (click → menu items), Tooltip (hover/focus).
// Positioned with simple CSS relative/absolute anchoring (no collision engine) on the --tp-z-popover layer.
// Styling lives in primitives.css.
//
// All three join the shared overlay stack (overlayStack.ts): Escape closes only the TOP-MOST layer, so a menu
// open inside a Dialog closes alone on the first press and the Dialog on the second. The DropdownMenu is a
// real ARIA menu — focus moves onto the items, arrows/Home/End walk them, Tab or Escape leaves — and the
// trigger render-prop hands back `props` so the DS (not forty call sites) wires aria-haspopup/expanded/controls.
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "../cn.ts";
import { isTopLayer, popLayer, pushLayer } from "./overlayStack.ts";

export interface TriggerProps {
  "aria-haspopup"?: "menu" | "listbox" | "dialog" | "true";
  "aria-expanded": boolean;
  "aria-controls"?: string;
}

export interface TriggerArgs {
  toggle: () => void;
  open: boolean;
  /** Spread onto the trigger element — wires the ARIA relationship for you. */
  props: TriggerProps;
}

/**
 * Shared floating-layer behavior: overlay-stack membership while open, outside-pointerdown close, and
 * Escape-closes-top-most (returning focus to the element that had it when the layer opened, when focus
 * is still inside the layer — closing a menu must not strand focus on `<body>`).
 */
function useFloatingLayer(
  open: boolean,
  onClose: () => void,
  rootRef: RefObject<HTMLElement | null>,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const handle = Symbol("tp-floating");
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pushLayer(handle, { lock: false });

    const close = (restoreFocus: boolean) => {
      if (restoreFocus && rootRef.current?.contains(document.activeElement)) opener?.focus();
      onCloseRef.current();
    };
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopLayer(handle)) {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
      popLayer(handle);
    };
  }, [open, rootRef]);
}

export interface PopoverProps {
  /** Render the trigger: wire onClick to `toggle` and spread `props` for the ARIA relationship. */
  trigger: (args: TriggerArgs) => ReactNode;
  /** Panel content, or a render-fn receiving a `close` callback. */
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  /** Vertical direction — "top" opens upward (for triggers near the bottom edge). */
  side?: "top" | "bottom";
  className?: string;
}

export function Popover({
  trigger,
  children,
  align = "start",
  side = "bottom",
  className,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = () => setOpen(false);
  useFloatingLayer(open, close, ref);
  return (
    <div className="tp-ui-anchor" ref={ref}>
      {trigger({
        toggle: () => setOpen((v) => !v),
        open,
        props: { "aria-expanded": open, "aria-controls": open ? panelId : undefined },
      })}
      {open ? (
        <div
          id={panelId}
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
  trigger: (args: TriggerArgs) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  side?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const panelId = useId();
  const close = () => setOpen(false);
  useFloatingLayer(open, close, ref);

  // Focus enters the menu when it opens (the ARIA menu pattern: the menu owns focus while open).
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const selectAndClose = (it: MenuItem) => {
    it.onSelect?.();
    close();
    openerRef.current?.focus();
  };

  const onMenuKeyDown = (e: ReactKeyboardEvent) => {
    const menu = menuRef.current;
    if (!menu) return;
    const menuItems = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    if (menuItems.length === 0) return;
    const current = menuItems.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => {
      e.preventDefault();
      menuItems[(index + menuItems.length) % menuItems.length]?.focus();
    };
    if (e.key === "ArrowDown") move(current + 1);
    else if (e.key === "ArrowUp") move(current - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(menuItems.length - 1);
    else if (e.key === "Tab") {
      // Per the menu pattern Tab leaves the widget: close and let the browser move focus onward.
      close();
      openerRef.current?.focus();
    }
  };

  return (
    <div className="tp-ui-anchor" ref={ref}>
      {trigger({
        toggle: () => {
          if (!open && document.activeElement instanceof HTMLElement) {
            openerRef.current = document.activeElement;
          }
          setOpen((v) => !v);
        },
        open,
        props: {
          "aria-haspopup": "menu",
          "aria-expanded": open,
          "aria-controls": open ? panelId : undefined,
        },
      })}
      {open ? (
        <div
          id={panelId}
          className={cn(
            "tp-ui-popover",
            align === "end" ? "tp-ui-popover--end" : "tp-ui-popover--start",
            side === "top" && "tp-ui-popover--up",
          )}
        >
          <div className="tp-ui-menu" role="menu" ref={menuRef} onKeyDown={onMenuKeyDown}>
            {items.map((it, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: menu items are a static, caller-ordered list
              <Fragment key={i}>
                {/* biome-ignore lint/a11y/useFocusableInteractive: static menu divider — decorative, never operable */}
                {it.separatorBefore ? <div className="tp-ui-menu-sep" role="separator" /> : null}
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={cn("tp-ui-menu-item", it.danger && "tp-ui-menu-item--danger")}
                  onClick={() => selectAndClose(it)}
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
        </div>
      ) : null}
    </div>
  );
}

export function Tooltip({ label, children }: { label: ReactNode; children: ReactNode }) {
  const [show, setShow] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);

  // Escape dismisses (WCAG 2.2 SC 1.4.13). The tooltip joins the overlay stack so the press that dismisses
  // it does not also close a Dialog underneath.
  useEffect(() => {
    if (!show) return;
    const handle = Symbol("tp-tooltip");
    pushLayer(handle, { lock: false });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopLayer(handle)) {
        e.stopPropagation();
        setShow(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      popLayer(handle);
    };
  }, [show]);

  // The description must hang off the FOCUSED element — a screen reader announces the describedby of the
  // control it lands on, and the wrapper span is never that control. With a single element child the id is
  // cloned on; otherwise the wrapper keeps it as a fallback (better than nothing for a text child).
  const child =
    isValidElement<{ "aria-describedby"?: string }>(children) && show
      ? cloneElement(children, {
          "aria-describedby": [children.props["aria-describedby"], id].filter(Boolean).join(" "),
        })
      : children;

  return (
    <span
      ref={ref}
      className="tp-ui-anchor"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      aria-describedby={!isValidElement(children) && show ? id : undefined}
    >
      {child}
      {show ? (
        <span className="tp-ui-tooltip" role="tooltip" id={id}>
          {label}
        </span>
      ) : null}
    </span>
  );
}
