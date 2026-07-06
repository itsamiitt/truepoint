// Mark.tsx — the TruePoint mark (three rising chevrons; the apex earns the Cobalt accent) + the wordmark +
// the lockup. Brand rule: the accent is a FILL/stroke on the APEX ONLY; the lower two points inherit
// currentColor (Ink on light, white on dark) — never recolored. Geometry from Guidelines/assets/truepoint-mark.svg.

type MarkVariant = "default" | "mono" | "reversed";

// The apex stroke per variant. `mono` = one-color fallback (apex drops to ink); `reversed` = on dark (tint).
const APEX_STROKE: Record<MarkVariant, string> = {
  default: "var(--tp-cobalt, #2563c9)",
  mono: "currentColor",
  reversed: "var(--tp-cobalt-tint, #5b8def)",
};

export function Mark({
  size = 20,
  variant = "default",
  title = "TruePoint",
}: {
  size?: number;
  variant?: MarkVariant;
  title?: string;
}): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={title}
      fill="none"
      strokeWidth={8.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 60 L50 45 L78 60" stroke="currentColor" />
      <path d="M22 77 L50 62 L78 77" stroke="currentColor" />
      <path d="M22 43 L50 28 L78 43" stroke={APEX_STROKE[variant]} />
    </svg>
  );
}

// Wordmark — two weights, never one (brand): True 400, Point 800. Inherits the surface font (Geist).
export function Wordmark({ size = 15 }: { size?: number }): React.ReactElement {
  return (
    <span style={{ fontSize: size, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>
      <span style={{ fontWeight: 400 }}>True</span>
      <span style={{ fontWeight: 800 }}>Point</span>
    </span>
  );
}

// Lockup — mark + wordmark, the standard header signature.
export function Lockup({
  markSize = 20,
  wordSize = 15,
  variant = "default",
  gap = 9,
}: {
  markSize?: number;
  wordSize?: number;
  variant?: MarkVariant;
  gap?: number;
}): React.ReactElement {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap }}>
      <Mark size={markSize} variant={variant} />
      <Wordmark size={wordSize} />
    </span>
  );
}
