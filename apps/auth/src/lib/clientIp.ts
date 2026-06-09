// clientIp.ts — best-effort client IP from proxy headers. The cross-domain code is bound to this IP, so
// the exchange (from the app origin) must originate from the same client (ADR-0016).
export function clientIp(req: Request): string {
  return clientIpFromHeaders(req.headers);
}

// Same, from a Headers-like object (Next's `headers()` in server actions/components).
export function clientIpFromHeaders(h: { get(name: string): string | null }): string {
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0];
    if (first) return first.trim();
  }
  return h.get("x-real-ip") ?? "0.0.0.0";
}
