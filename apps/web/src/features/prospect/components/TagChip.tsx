// TagChip.tsx — a compact tag pill: a palette-colored dot + the tag name, with an optional trailing × to
// remove it (record-customization layer, ADR-0028 / G-REV-6). Presentational + token-driven (color comes
// from the brand palette KEY via tagColors.ts, never a raw hex); 6px radius per the chip convention. Its
// own component (the tag dot is distinct from the monochrome filter TpChip).
"use client";

import type { TagColor } from "@leadwolf/types";
import { tagColorVar } from "../tagColors";

export function TagChip({
  name,
  color,
  active,
  onClick,
  onRemove,
}: {
  name: string;
  color: TagColor | string;
  /** Toggled state when the chip is used as a filter facet. */
  active?: boolean;
  /** When set the chip becomes a button (filter facet / picker option). */
  onClick?: () => void;
  /** When set, renders a trailing × that removes the tag without triggering onClick. */
  onRemove?: () => void;
}) {
  const dot = (
    <span
      aria-hidden
      style={{
        width: 7,
        height: 7,
        borderRadius: 999,
        background: tagColorVar(color),
        flex: "0 0 auto",
      }}
    />
  );

  const baseStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "2px 8px",
    borderRadius: "var(--tp-radius-sm)",
    border: "1px solid var(--tp-hairline-2)",
    background: active ? "var(--tp-surface-3)" : "var(--tp-surface)",
    color: "var(--tp-ink-2)",
    fontSize: 12,
    lineHeight: 1.4,
    fontWeight: 500,
    whiteSpace: "nowrap" as const,
  };

  const label = (
    <>
      {dot}
      {name}
    </>
  );

  const remove =
    onRemove != null ? (
      // biome-ignore lint/a11y/useSemanticElements: a <button> can't nest in the chip's <button>; mirrors TpChip's remove-× span.
      <span
        role="button"
        aria-label={`Remove ${name}`}
        tabIndex={0}
        style={{ cursor: "pointer", color: "var(--tp-ink-3)", lineHeight: 1 }}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }
        }}
      >
        ×
      </span>
    ) : null;

  if (onClick != null) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        style={{ ...baseStyle, cursor: "pointer" }}
      >
        {label}
        {remove}
      </button>
    );
  }

  return (
    <span style={baseStyle}>
      {label}
      {remove}
    </span>
  );
}
