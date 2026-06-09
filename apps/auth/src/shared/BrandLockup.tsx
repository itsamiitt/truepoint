// BrandLockup.tsx — the TruePoint wordmark per brand (True = Regular 400, Point = ExtraBold 800).
// Rendered as styled text so it needs no binary asset and stays crisp; Cobalt is reserved for the mark.
export function BrandLockup() {
  return (
    <div className="brand-lockup" aria-label="TruePoint">
      <span style={{ fontWeight: 400 }}>True</span>
      <span style={{ fontWeight: 800 }}>Point</span>
    </div>
  );
}
