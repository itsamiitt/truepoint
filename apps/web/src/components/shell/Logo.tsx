// Logo.tsx — the TruePoint brand mark + wordmark (Brand Kit v1.0). The mark is three rising chevrons; only
// the apex earns the Cobalt accent (a FILL, never text), the lower two stay ink/currentColor. The wordmark
// is "True" (Regular) + "Point" (Bold) — the weight shift IS the logo; never set it in a single weight.
// Reversed variant (white type + lighter cobalt-tint apex) is for the twilight/dark surfaces.
import type { CSSProperties } from "react";

/** The three-chevron mark. Apex = Cobalt fill; lower two = ink (currentColor). `reversed` is for dark bg. */
export function Brandmark({
  size = 24,
  reversed = false,
  title,
}: {
  size?: number;
  reversed?: boolean;
  title?: string;
}) {
  const accent = reversed ? "var(--tp-cobalt-tint)" : "var(--tp-cobalt)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeWidth={8.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      style={{ display: "block", color: reversed ? "#fff" : "var(--tp-ink)", flexShrink: 0 }}
    >
      {title ? <title>{title}</title> : null}
      {/* Apex — the single earned accent (Cobalt fill). */}
      <path d="M22 43 L50 28 L78 43" stroke={accent} />
      <path d="M22 60 L50 45 L78 60" />
      <path d="M22 77 L50 62 L78 77" />
    </svg>
  );
}

/** "True" (Regular) + "Point" (Bold). The weight shift is the wordmark; never a single uniform weight. */
export function Wordmark({
  size = 15,
  reversed = false,
  style,
}: {
  size?: number;
  reversed?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        fontSize: size,
        letterSpacing: "-0.02em",
        lineHeight: 1,
        color: reversed ? "#fff" : "var(--tp-ink)",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <span style={{ fontWeight: 400 }}>True</span>
      <span style={{ fontWeight: 700 }}>Point</span>
    </span>
  );
}

/** The horizontal lockup: mark + wordmark. The default brand presentation in the shell. */
export function Logo({
  markSize = 24,
  wordSize = 16,
  reversed = false,
  gap = 9,
  style,
}: {
  markSize?: number;
  wordSize?: number;
  reversed?: boolean;
  gap?: number;
  style?: CSSProperties;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap, ...style }}>
      <Brandmark size={markSize} reversed={reversed} title="TruePoint" />
      <Wordmark size={wordSize} reversed={reversed} />
    </span>
  );
}
