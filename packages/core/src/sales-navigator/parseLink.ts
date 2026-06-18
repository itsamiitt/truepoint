// parseLink.ts — pure, IO-free parsing of a pasted LinkedIn / Sales Navigator URL (05 §5, M7, ADR-0009).
// HITL only: a human pastes the link; we never fetch it. We only read structure that is already in the URL
// the human gave us, to derive a dedup key (sales_nav_lead_id) and a best-guess link_type. Lenient by
// design — an unrecognized but valid URL is still a capturable link (the caller supplies link_type).

import type { SalesNavLinkType } from "@leadwolf/types";

export interface ParsedSalesNavLink {
  /** The lead/entity id parsed from the path (e.g. /sales/lead/<id>) — the second dedup facet. null if none. */
  salesNavLeadId: string | null;
  /** A best-guess link_type from the URL shape; null when the shape isn't recognized (caller decides). */
  inferredType: SalesNavLinkType | null;
}

/** Sales Nav path → link_type. Ordered most-specific-first; the first matching pattern wins. */
const PATTERNS: ReadonlyArray<{ re: RegExp; type: SalesNavLinkType; idGroup?: number }> = [
  // https://www.linkedin.com/sales/lead/<id>,<extra>
  { re: /\/sales\/lead\/([^/,?#]+)/i, type: "profile", idGroup: 1 },
  // https://www.linkedin.com/sales/people/<id>
  { re: /\/sales\/people\/([^/,?#]+)/i, type: "profile", idGroup: 1 },
  // https://www.linkedin.com/sales/company/<id>
  { re: /\/sales\/company\/([^/,?#]+)/i, type: "account", idGroup: 1 },
  // https://www.linkedin.com/sales/account/<id>
  { re: /\/sales\/account\/([^/,?#]+)/i, type: "account", idGroup: 1 },
  // Saved-search / list / messaging surfaces (no stable single id we want to key on).
  { re: /\/sales\/search\/people/i, type: "saved_search" },
  { re: /\/sales\/lists\/people/i, type: "lead_list" },
  { re: /\/sales\/lists\/company/i, type: "account_list" },
  { re: /\/sales\/inbox|\/sales\/messaging/i, type: "inmail_thread" },
  // Plain public profile (not Sales Nav) — still a "profile" capture; slug is its weak id.
  { re: /^\/in\/([^/,?#]+)/i, type: "profile", idGroup: 1 },
  // Plain company page.
  { re: /^\/company\/([^/,?#]+)/i, type: "account", idGroup: 1 },
];

/**
 * Parse a pasted URL into a dedup id + inferred type. Returns `{ salesNavLeadId:null, inferredType:null }`
 * for a syntactically-valid-but-unrecognized URL — that's still capturable; the caller's link_type stands.
 */
export function parseSalesNavLink(rawUrl: string): ParsedSalesNavLink {
  let path: string;
  try {
    const u = new URL(rawUrl);
    // Only derive an id/type from a real LinkedIn host — otherwise a non-LinkedIn URL that merely contains
    // a "/sales/lead/<id>" or "linkedin.com/in/<id>" substring would yield a bogus dedup key. eTLD check is
    // hostname === "linkedin.com" OR a "*.linkedin.com" subdomain (www, x.sales, etc.).
    const host = u.hostname.toLowerCase();
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) {
      return { salesNavLeadId: null, inferredType: null };
    }
    path = u.pathname;
  } catch {
    // Not a parseable URL — let the Zod url() check at the api edge reject it; nothing to infer here.
    return { salesNavLeadId: null, inferredType: null };
  }

  for (const p of PATTERNS) {
    const m = path.match(p.re);
    if (!m) continue;
    const id = p.idGroup ? (m[p.idGroup] ?? null) : null;
    return {
      salesNavLeadId: id && id.length > 0 && id.length <= 255 ? id : null,
      inferredType: p.type,
    };
  }
  return { salesNavLeadId: null, inferredType: null };
}
