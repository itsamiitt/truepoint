// BrandLockup.tsx — the TruePoint lockup: the chevron mark (inline SVG, cobalt top stroke) beside the
// wordmark (True = Regular 400, Point = ExtraBold 800). Inline SVG so it needs no binary asset and stays
// crisp at any size; the mark carries the brand's only color (cobalt), the wordmark is Ink.
export function BrandLockup() {
  return (
    <div className="mb-5 inline-flex items-center gap-2" aria-label="TruePoint">
      <svg
        viewBox="0 0 100 100"
        className="h-6 w-6"
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
      <span className="text-xl tracking-[-0.02em]">
        <span className="font-normal">True</span>
        <span className="font-extrabold">Point</span>
      </span>
    </div>
  );
}
