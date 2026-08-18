// BrandLockup.tsx — the TruePoint lockup: the chevron mark (inline SVG, cobalt top stroke) beside the
// wordmark (True = Regular 400, Point = ExtraBold 800). Inline SVG so it needs no binary asset and stays
// crisp at any size; the mark carries the brand's only color (cobalt), the wordmark is Ink.
export function BrandLockup() {
  return (
    <div
      style={{
        marginBottom: "var(--tp-space-5)",
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--tp-space-2)",
      }}
      aria-label="TruePoint"
    >
      <svg
        viewBox="0 0 100 100"
        style={{ height: 24, width: 24 }}
        fill="none"
        strokeWidth={8.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M22 43 L50 28 L78 43" stroke="var(--tp-cobalt)" />
        <path d="M22 60 L50 45 L78 60" stroke="var(--tp-ink)" />
        <path d="M22 77 L50 62 L78 77" stroke="var(--tp-ink)" />
      </svg>
      <span style={{ fontSize: 20, letterSpacing: "-0.02em" }}>
        <span style={{ fontWeight: 400 }}>True</span>
        <span style={{ fontWeight: 800 }}>Point</span>
      </span>
    </div>
  );
}
