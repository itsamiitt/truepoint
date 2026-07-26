// ipBinding.ts — the cross-domain code's client-IP binding policy (ADR-0016 addendum). The login step and
// the token exchange are two separate connections, so the same client can present DIFFERENT raw IPs (an
// IPv6 zone/bracket form, an IPv4-mapped IPv6 address, or a proxy first-hop that varies within a network).
// An exact-string match is therefore too brittle and silently breaks legitimate logins. We normalize, then
// compare under a configurable posture: `strict` (normalized exact), `prefix` (same network — /24 IPv4,
// /64 IPv6), or `off`. PKCE + single-use + short TTL remain the primary protections; the IP bind is
// defense-in-depth, so `prefix` keeps the "same network" intent without the false negatives.

// The only import here, for the TRUSTED_PROXY_HOPS default below. normalizeIp/clientIpMatches remain pure.
import { env } from "@leadwolf/config";

export type IpBindMode = "strict" | "prefix" | "off";

// ── resolving the client IP from the edge ──────────────────────────────────────────────────────────────
// Anything keyed by IP (this binding, brute-force lockout, per-IP request throttling) depends on the value NOT
// being client-forgeable, so the selection rule below is a security control rather than a parsing detail.
//
// Each trusted reverse proxy APPENDS the IP it saw to X-Forwarded-For — it does not strip a client-supplied
// header. A request therefore arrives as `<client-forged…>, <added-by-hop-1>, …, <added-by-hop-N>`, and the
// trustworthy value is the Nth-from-last entry, where N = TRUSTED_PROXY_HOPS: a client can forge earlier entries
// but can never append AFTER the trusted hops. Reading the FIRST entry lets an attacker spoof their IP freely and
// evade every per-IP limit (W10/#14). Default N=1 = the single Caddy edge; set TRUSTED_PROXY_HOPS=2 when a
// trusted CDN (e.g. Cloudflare) also sits in front (AUTH-077).
//
// It lives here, in packages/auth, so apps/auth AND apps/api share one implementation — `apps-never-import-apps`
// (dependency-cruiser) forbids reaching across apps, and a second copy of a security control drifts until one
// side is silently wrong.

/** Minimal Headers-shaped input, so this works with a Request's headers and with Next's `headers()`. */
export interface HeaderReader {
  get(name: string): string | null | undefined;
}

/** Resolve the client IP from a Headers-like object. `hops` defaults to the configured trusted-hop count;
 *  callers pass it explicitly only in tests. Returns "0.0.0.0" when nothing usable is present — a fixed
 *  sentinel, never a forgeable value, so an absent header cannot masquerade as a distinct client. */
export function clientIpFromHeaders(
  h: HeaderReader,
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

/** Convenience wrapper for a whole Request. */
export function clientIp(req: Request, hops?: number): string {
  return clientIpFromHeaders(req.headers, hops);
}

/**
 * Canonicalize a proxy-supplied IP for comparison: trim, lower-case, strip an `[ipv6]`/`[ipv6]:port`
 * bracket form, drop an IPv6 zone id (`fe80::1%eth0`), and fold an IPv4-mapped IPv6 (`::ffff:1.2.3.4`) to
 * its IPv4 form so the two stacks compare equal. Returns the input trimmed if it isn't recognizably an IP.
 */
export function normalizeIp(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close > 0) s = s.slice(1, close); // drop brackets and any :port suffix
  }
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (s.startsWith("::ffff:") && s.slice(7).includes(".")) s = s.slice(7);
  return s;
}

/** The comparable network key for an IP: /24 for IPv4, /64 for IPv6, else the whole normalized address. */
function networkKey(ip: string): string {
  const n = normalizeIp(ip);
  if (n.includes(":")) return n.split(":").slice(0, 4).join(":"); // IPv6 → first 4 hextets (/64)
  const octets = n.split(".");
  return octets.length === 4 ? octets.slice(0, 3).join(".") : n; // IPv4 → first 3 octets (/24)
}

/** True when `presented` is bound-equivalent to `bound` under `mode`. `off` always matches. */
export function clientIpMatches(bound: string, presented: string, mode: IpBindMode): boolean {
  if (mode === "off") return true;
  if (mode === "strict") return normalizeIp(bound) === normalizeIp(presented);
  return networkKey(bound) === networkKey(presented);
}
