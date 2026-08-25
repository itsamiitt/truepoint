"use client";
// Tabs.tsx — an underline tab bar + a compact SegmentedControl (e.g. Contacts⇄Accounts). Both are controlled
// (value + onChange) so the parent owns selection. Styling lives in primitives.css.
//
// Both implement their ARIA pattern's keyboard model: arrows move (wrapping), Home/End jump to the ends, and
// focus follows selection. Shipping the roles without the keys is the failure mode the repo already has a
// lint for (scripts/lint-roving-tabindex.mjs) — options that Tab skips and arrows don't reach are options a
// keyboard user cannot select at all.
//
// They are DIFFERENT patterns, which is why they no longer share a role: Tabs switch which panel is shown
// (tablist/tab); SegmentedControl picks a value — a period, a scope, a view — which is a radiogroup. Using
// `tablist` for a period picker told screen-reader users to expect a panel that never existed.
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { cn } from "../cn.ts";

export interface TabItem {
  value: string;
  label: ReactNode;
}

interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  "aria-label"?: string;
}

/**
 * Shared arrow-key model for a horizontal composite. Returns the handler; focus follows selection, which is
 * the "automatic activation" form of the pattern — correct when switching is cheap and instant.
 */
function useCompositeKeys(items: TabItem[], value: string, onChange: (value: string) => void) {
  return (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((it) => it.value === value);
    if (index === -1) return;
    const select = (next: number) => {
      e.preventDefault();
      const target = items[(next + items.length) % items.length];
      if (!target) return;
      onChange(target.value);
      // Move DOM focus onto the newly selected control — with roving tabindex the old one is about to
      // leave the tab order, and focus left on it would be stranded.
      const container = e.currentTarget;
      requestAnimationFrame(() => {
        container.querySelector<HTMLElement>(`[data-value="${CSS.escape(target.value)}"]`)?.focus();
      });
    };
    if (e.key === "ArrowRight" || e.key === "ArrowDown") select(index + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") select(index - 1);
    else if (e.key === "Home") select(0);
    else if (e.key === "End") select(items.length - 1);
  };
}

export function Tabs({ items, value, onChange, className, "aria-label": ariaLabel }: TabsProps) {
  const onKeyDown = useCompositeKeys(items, value, onChange);
  return (
    <div
      className={cn("tp-ui-tabs", className)}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {items.map((it) => (
        <button
          key={it.value}
          data-value={it.value}
          type="button"
          role="tab"
          aria-selected={it.value === value}
          // Roving tabindex: one stop for the whole group, arrows move within it.
          tabIndex={it.value === value ? 0 : -1}
          className="tp-ui-tab"
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function SegmentedControl({
  items,
  value,
  onChange,
  className,
  "aria-label": ariaLabel,
}: TabsProps) {
  const onKeyDown = useCompositeKeys(items, value, onChange);
  return (
    <div
      className={cn("tp-ui-segmented", className)}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {items.map((it) => (
        <button
          key={it.value}
          data-value={it.value}
          type="button"
          // biome-ignore lint/a11y/useSemanticElements: a native radio cannot carry this pill styling; the pattern is implemented in full
          role="radio"
          aria-checked={it.value === value}
          tabIndex={it.value === value ? 0 : -1}
          className="tp-ui-segmented-item"
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
