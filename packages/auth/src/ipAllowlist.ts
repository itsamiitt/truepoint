// ipAllowlist.ts — CIDR-network matching for the tenant IP-allowlist login gate (P1-01 Gate C, ADR-0018).
// The gap analysis flagged the exact trap this file avoids: an allowlist must match by CIDR NETWORK, never
// by string equality (a bare "203.0.113.5" entry is a /32, and "203.0.113.0/24" must admit every host in the
// block). Security ACs → ../../Authentication plan/09-threat-model.md "Mass-assignment & field allowlisting"
// (entries are server-validated) and the policy-enforcement gate: a MALFORMED entry fails CLOSED *for that
// entry only* (it is skipped, never matched) — it must never throw and never open the gate for all addresses.
//
// We reuse the dual-stack normalization from ipBinding.ts (IPv4-mapped IPv6 → IPv4, zone-id strip, bracket/
// port strip, lower-case) so a client presenting "::ffff:203.0.113.5" is matched against an IPv4 CIDR, and an
// allowlist entry written in either form compares equal. No external dependency: IPv4 is matched as a 32-bit
// integer, IPv6 as a 128-bit BigInt; the candidate's family must equal the entry's family to match.

import { normalizeIp } from "./ipBinding.ts";

/** Parse an IPv4 dotted-quad into its 32-bit integer, or null if it is not a valid IPv4 address. */
function ipv4ToInt(s: string): number | null {
  const octets = s.split(".");
  if (octets.length !== 4) return null;
  let acc = 0;
  for (const o of octets) {
    // Reject empty, non-numeric, leading-zero-padded (ambiguous), or out-of-range octets.
    if (!/^\d{1,3}$/.test(o)) return null;
    const n = Number(o);
    if (n > 255) return null;
    acc = acc * 256 + n;
  }
  // >>> 0 keeps it an unsigned 32-bit value for the prefix mask below.
  return acc >>> 0;
}

/**
 * Parse an IPv6 address (already normalized — no zone id, no brackets) into its 128-bit BigInt, or null if it
 * is not a valid IPv6 address. Supports "::" compression and a trailing embedded IPv4 (the latter only when a
 * "." appears, which after normalizeIp folds the IPv4-mapped form to IPv4 anyway, so it is rare here).
 */
function ipv6ToBigInt(s: string): bigint | null {
  if (!s.includes(":")) return null;
  // Split on the "::" zero-run (at most one allowed).
  const halves = s.split("::");
  if (halves.length > 2) return null;

  const expand = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const head = expand(halves[0] ?? "");
  const tail = halves.length === 2 ? expand(halves[1] ?? "") : [];

  // A trailing embedded IPv4 (e.g. "::1.2.3.4") occupies the last TWO hextets.
  const lastTail = tail[tail.length - 1];
  let embeddedV4Hextets: string[] = [];
  if (lastTail?.includes(".")) {
    const v4 = ipv4ToInt(lastTail);
    if (v4 === null) return null;
    embeddedV4Hextets = [((v4 >>> 16) & 0xffff).toString(16), (v4 & 0xffff).toString(16)];
    tail.pop();
  }

  const groups = [...head, ...tail, ...embeddedV4Hextets];
  const explicit = groups.length;
  // With "::" present we pad the gap with zero hextets to reach 8; without it we require exactly 8.
  if (halves.length === 2) {
    if (explicit > 8) return null;
  } else if (explicit !== 8) {
    return null;
  }

  const zerosToInsert = halves.length === 2 ? 8 - explicit : 0;
  const full = [...head, ...Array(zerosToInsert).fill("0"), ...tail, ...embeddedV4Hextets];
  // After zero-run insertion the total must be exactly 8 hextets.
  if (full.length !== 8) return null;

  let acc = 0n;
  for (const g of full) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    acc = (acc << 16n) + BigInt(Number.parseInt(g, 16));
  }
  return acc;
}

/**
 * True when `ip` falls inside the single CIDR `cidr` (or matches a bare address, treated as a /32 or /128).
 * Returns false — never throws — on any malformed input, so a bad allowlist entry fails CLOSED for that entry.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const candidate = normalizeIp(ip);
  const rawEntry = cidr.trim();
  if (rawEntry === "") return false;

  const slash = rawEntry.indexOf("/");
  const networkPart = normalizeIp(slash >= 0 ? rawEntry.slice(0, slash) : rawEntry);
  const prefixPart = slash >= 0 ? rawEntry.slice(slash + 1) : undefined;

  // IPv4 entry?
  const netV4 = ipv4ToInt(networkPart);
  if (netV4 !== null) {
    const ipV4 = ipv4ToInt(candidate);
    if (ipV4 === null) return false; // a v6 client never matches a v4 entry
    let prefix = 32;
    if (prefixPart !== undefined) {
      if (!/^\d{1,2}$/.test(prefixPart)) return false;
      prefix = Number(prefixPart);
      if (prefix > 32) return false;
    }
    if (prefix === 0) return true;
    // Mask the top `prefix` bits; (-1 << (32-prefix)) underflows in JS bit-ops, so build the mask via >>>.
    const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1) >>> 0);
    return (ipV4 & mask) === (netV4 & mask);
  }

  // IPv6 entry?
  const netV6 = ipv6ToBigInt(networkPart);
  if (netV6 !== null) {
    const ipV6 = ipv6ToBigInt(candidate);
    if (ipV6 === null) return false; // a v4 client never matches a v6 entry
    let prefix = 128;
    if (prefixPart !== undefined) {
      if (!/^\d{1,3}$/.test(prefixPart)) return false;
      prefix = Number(prefixPart);
      if (prefix > 128) return false;
    }
    if (prefix === 0) return true;
    const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
    return (ipV6 & mask) === (netV6 & mask);
  }

  // Unparseable entry → fail closed for THIS entry (skip it), never open the gate.
  return false;
}

/**
 * True when `ip` is admitted by `allowlist` (any CIDR matches). An EMPTY allowlist imposes no restriction and
 * returns true (the caller only invokes the gate when the allowlist is non-empty). Each entry is evaluated
 * independently; a malformed entry is skipped (ipInCidr returns false for it) and never opens the gate.
 */
export function isIpAllowed(ip: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((cidr) => ipInCidr(ip, cidr));
}
