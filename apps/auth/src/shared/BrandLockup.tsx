// BrandLockup.tsx — the TruePoint wordmark per brand (True = Regular 400, Point = ExtraBold 800).
// Rendered as styled text so it needs no binary asset and stays crisp; Cobalt is reserved for the mark.
export function BrandLockup() {
  return (
    <div className="mb-5 text-xl tracking-[-0.02em]" aria-label="TruePoint">
      <span className="font-normal">True</span>
      <span className="font-extrabold">Point</span>
    </div>
  );
}
