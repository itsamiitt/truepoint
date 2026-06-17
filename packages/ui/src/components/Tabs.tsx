"use client";
// Tabs.tsx — an underline tab bar + a compact SegmentedControl (e.g. Contacts⇄Accounts). Both are controlled
// (value + onChange) so the parent owns selection. Styling lives in primitives.css.
import type { ReactNode } from "react";
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

export function Tabs({ items, value, onChange, className, "aria-label": ariaLabel }: TabsProps) {
  return (
    <div className={cn("tp-ui-tabs", className)} role="tablist" aria-label={ariaLabel}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={it.value === value}
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
  return (
    <div className={cn("tp-ui-segmented", className)} role="tablist" aria-label={ariaLabel}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={it.value === value}
          className="tp-ui-segmented-item"
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
