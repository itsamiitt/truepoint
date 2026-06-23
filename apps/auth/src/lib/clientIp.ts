// clientIp.ts — best-effort client IP from the trusted edge proxy. The cross-domain code is bound to this IP,
// and rate-limiting / brute-force lockout are keyed by it (ADR-0016, W7), so it must not be client-forgeable.
//
// Caddy (the single edge proxy in this deploy) APPENDS the real client IP to X-Forwarded-For — it does not
// strip a client-supplied header. So a request arrives as `<client-forged…>, <real-IP-added-by-Caddy>` and the
// trustworthy value is the LAST entry: the client can forge earlier entries but cannot append AFTER the trusted
// hop. Taking the first entry (the old behaviour) let an attacker spoof their IP to evade per-IP throttling and
// lockout (W10/#14). NOTE: this assumes exactly ONE trusted proxy hop (Caddy); with an extra trusted CDN in
// front (e.g. Cloudflare), the trusted entry would be Nth-from-last — raise the hop count accordingly.
export function clientIp(req: Request): string {
  return clientIpFromHeaders(req.headers);
}

// Same, from a Headers-like object (Next's `headers()` in server actions/components).
export function clientIpFromHeaders(h: { get(name: string): string | null }): string {
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",");
    const last = parts[parts.length - 1]; // the entry the trusted proxy appended — unspoofable by the client
    if (last?.trim()) return last.trim();
  }
  return h.get("x-real-ip") ?? "0.0.0.0";
}
