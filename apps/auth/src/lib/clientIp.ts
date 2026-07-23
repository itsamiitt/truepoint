// clientIp.ts — best-effort client IP from the trusted edge proxy. The cross-domain code is bound to this IP,
// and rate-limiting / brute-force lockout are keyed by it (ADR-0016, W7), so it must not be client-forgeable.
//
// Each trusted reverse proxy APPENDS the IP it saw to X-Forwarded-For — it does not strip a client-supplied
// header. So a request arrives as `<client-forged…>, <added-by-hop-1>, …, <added-by-hop-N>` and the trustworthy
// value is the Nth-from-last entry, where N = the count of trusted hops (TRUSTED_PROXY_HOPS): a client can forge
// earlier entries but can never append AFTER the trusted hops. Taking the first entry (the pre-W10 behaviour)
// let an attacker spoof their IP to evade per-IP throttling and lockout (W10/#14). Default N=1 = the single
// Caddy edge; set TRUSTED_PROXY_HOPS=2 when a trusted CDN (e.g. Cloudflare) is also in front (AUTH-077).
import { env } from "@leadwolf/config";

export function clientIp(req: Request, hops?: number): string {
  return clientIpFromHeaders(req.headers, hops);
}

// Same, from a Headers-like object (Next's `headers()` in server actions/components). `hops` defaults to the
// configured trusted-hop count; callers pass it explicitly only in tests.
export function clientIpFromHeaders(
  h: { get(name: string): string | null },
  hops: number = env.TRUSTED_PROXY_HOPS,
): string {
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",");
    // Nth-from-last: the entry the outermost trusted hop appended. If there are fewer entries than trusted hops
    // (a topology/config mismatch), this is undefined and we fall through to x-real-ip — never a forgeable entry.
    const trusted = parts[parts.length - Math.max(1, hops)];
    if (trusted?.trim()) return trusted.trim();
  }
  return h.get("x-real-ip") ?? "0.0.0.0";
}
