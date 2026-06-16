// ipBinding.ts — the cross-domain code's client-IP binding policy (ADR-0016 addendum). The login step and
// the token exchange are two separate connections, so the same client can present DIFFERENT raw IPs (an
// IPv6 zone/bracket form, an IPv4-mapped IPv6 address, or a proxy first-hop that varies within a network).
// An exact-string match is therefore too brittle and silently breaks legitimate logins. We normalize, then
// compare under a configurable posture: `strict` (normalized exact), `prefix` (same network — /24 IPv4,
// /64 IPv6), or `off`. PKCE + single-use + short TTL remain the primary protections; the IP bind is
// defense-in-depth, so `prefix` keeps the "same network" intent without the false negatives.

export type IpBindMode = "strict" | "prefix" | "off";

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
