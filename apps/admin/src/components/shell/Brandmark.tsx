// Brandmark.tsx — the TruePoint mark for the staff console (Brand Kit v1.0). Three rising chevrons; only
// the apex earns the Cobalt accent (a FILL, never text), the lower two stay ink/currentColor. Mirrors the
// canonical mark in apps/web's Logo.tsx so the console renders the real logo, not a placeholder square.
// Decorative by default (the visible "TruePoint" wordmark beside it provides the accessible name).

/** The three-chevron mark. Apex = Cobalt fill; lower two = ink (currentColor). `reversed` is for dark bg. */
export function Brandmark({
  size = 20,
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
      style={{
        display: "block",
        color: reversed ? "var(--tp-on-fill)" : "var(--tp-ink)",
        flexShrink: 0,
      }}
    >
      {title ? <title>{title}</title> : null}
      {/* Apex — the single earned accent (Cobalt fill). */}
      <path d="M22 43 L50 28 L78 43" stroke={accent} />
      <path d="M22 60 L50 45 L78 60" />
      <path d="M22 77 L50 62 L78 77" />
    </svg>
  );
}
