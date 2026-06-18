// ssrfGuard.ts — block server-side request forgery via webhook target URLs (G-INT-5 security note). An
// outbound webhook POSTs to a CUSTOMER-SUPPLIED URL from inside our network, so without a guard a tenant
// could point a subscription at 169.254.169.254 (cloud metadata), 127.0.0.1 (loopback), or an RFC-1918
// host (internal services) and use our dispatcher as a confused deputy. We therefore (1) require http(s),
// (2) reject obviously-internal hostnames, and (3) RESOLVE the host and reject if ANY resolved address is
// loopback / private / link-local / unspecified / metadata (incl. IPv4-mapped + NAT64-embedded IPv4). The
// resolve step closes most DNS-rebinding hostnames that look public but resolve internal. Validation runs at
// create AND at every dispatch/replay (DNS can change between), so a subscription created when a host was
// public is re-checked at fire time.
//
// KNOWN LIMITATION (DNS-rebinding TOCTOU): after lookup() vets the resolved IPs, fetch() re-resolves the
// hostname independently, so a sub-second-TTL record could flip public→internal between the check and the
// connect. Fully closing this needs connect-by-pinned-IP (custom undici dispatcher) — tracked as a follow-up;
// the create+fire re-checks plus the literal-IP path shrink the window but do not eliminate it.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SsrfError";
  }
}

// TEST-ONLY escape hatch: when WEBHOOK_ALLOW_LOOPBACK=1 AND NODE_ENV==='test', loopback/private targets are
// permitted so the integration tests can deliver to an in-process receiver and verify the real signed POST.
// The NODE_ENV gate means the flag CANNOT take effect in a deployed process even if the var leaks into one
// (preview deploys, copied .env, a globally-exported var). Read from process.env (not the typed config) so it
// can never become part of the production config surface. Even under the hatch, metadata hosts stay blocked.
function loopbackAllowedForTests(): boolean {
  return process.env.WEBHOOK_ALLOW_LOOPBACK === "1" && process.env.NODE_ENV === "test";
}

/** Cloud instance-metadata endpoints — never a legitimate webhook target, even under the test escape hatch. */
const METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "100.100.100.200"]);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
  if (lower.startsWith("fec0")) return true; // deprecated site-local
  if (lower.startsWith("ff")) return true; // multicast ff00::/8
  // IPv4-mapped / IPv4-compatible addresses (::ffff:a.b.c.d, ::ffff:7f00:1, ::a.b.c.d). The URL parser
  // CANONICALIZES the trailing dotted-quad to two hex groups (::ffff:127.0.0.1 → ::ffff:7f00:1), so a
  // dotted-only regex misses it — an SSRF bypass to loopback. Extract the embedded IPv4 in BOTH forms and
  // run the v4 check.
  const embedded = embeddedIPv4(lower);
  if (embedded) return isPrivateIPv4(embedded);
  return false;
}

/**
 * Pull the embedded IPv4 out of an IPv4-mapped (`::ffff:…`), IPv4-compatible (`::…`), or NAT64
 * (`64:ff9b::…`) IPv6 address, returning it as a dotted quad — handling the dotted form
 * (`::ffff:127.0.0.1`) AND the canonicalized hex form (`::ffff:7f00:1`, `64:ff9b::7f00:1`). Returns null
 * when the address carries no embedded IPv4. NAT64 matters because on an IPv6-only/NAT64 egress an embedded
 * internal IPv4 (e.g. 64:ff9b::7f00:1 = 127.0.0.1) would otherwise reach a loopback/internal service.
 */
function embeddedIPv4(lower: string): string | null {
  // Dotted form survives in some inputs.
  const dotted = lower.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1]!;
  // Hex form: mapped (::ffff:HHHH:HHHH), compatible (::HHHH:HHHH), or NAT64 (64:ff9b::HHHH:HHHH) — the last
  // two 16-bit groups carry the embedded IPv4.
  const hex = lower.match(/^(?:::(?:ffff:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/** True when an IP literal is loopback / private / link-local / metadata / reserved. */
export function isBlockedAddress(ip: string): boolean {
  if (METADATA_HOSTS.has(ip)) return true;
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true; // not a valid IP literal → block (defensive)
}

/**
 * Validate a customer-supplied webhook URL, resolving its host to reject internal targets. Throws
 * {@link SsrfError} on any failure (bad scheme, internal host, internal-resolving DNS). Returns the parsed
 * URL on success so callers don't re-parse.
 */
export async function assertSafeWebhookUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError("unsupported_scheme");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.length === 0) throw new SsrfError("empty_host");
  // Cloud metadata is blocked unconditionally — never reachable even under the test escape hatch.
  if (METADATA_HOSTS.has(host)) throw new SsrfError("metadata_host");
  // Scheme + a well-formed host + the metadata block are enforced even under the test escape hatch; only the
  // loopback/private checks below are relaxed (so itests can hit a loopback receiver). NODE_ENV-gated, so the
  // flag is inert in any deployed process.
  if (loopbackAllowedForTests()) return url;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new SsrfError("internal_host");
  }

  // Literal IP in the URL: check directly (no DNS).
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) throw new SsrfError("internal_address");
    return url;
  }

  // Hostname: resolve EVERY address and reject if any is internal (catches public-looking → internal DNS).
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new SsrfError("dns_resolution_failed");
  }
  if (addresses.length === 0) throw new SsrfError("dns_no_records");
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) throw new SsrfError("internal_address");
  }
  return url;
}
