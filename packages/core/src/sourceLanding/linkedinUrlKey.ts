// linkedinUrlKey.ts — PURE canonicalization of a LinkedIn / Sales-Navigator URL into the ONE registry key
// (docs/planning/ …ecosystem). The same person/company arrives as many URL forms — `/sales/lead/<id>,NAME_SEARCH`,
// `/sales/people/<id>`, `/in/<slug>`, `/sales/company/<id>`, `/company/<slug>` — and the fetch registry must
// collapse them so a profile viewed via a lead link and later via its public slug is ONE fetch target, not two.
//
// Reuses the shipped parsers (no second implementation of "read structure out of a LinkedIn URL"):
// parseSalesNavLink (sales-nav lead/company id + inferred type) and linkedinPublicIdOf (public slug). The
// canonical form is deterministic and host/case/query-insensitive, so it is a stable UNIQUE key.

import { parseSalesNavLink } from "../sales-navigator/parseLink.ts";
import { salesNavCompanyUrl } from "./linkedinSourceClient.ts";

/** The public `/in/<slug>` from a URL, ONLY when the path actually is an /in/ profile. (linkedinPublicIdOf
 *  in @leadwolf/identity passes bare strings through, so it cannot be used to TEST for a profile URL.) */
function publicProfileSlug(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
    const m = u.pathname.match(/^\/in\/([^/?#]+)/i);
    return m?.[1] ? decodeURIComponent(m[1]).toLowerCase() : null;
  } catch {
    return null;
  }
}

export type LinkedinEntityKind = "person" | "company";

export interface LinkedinUrlKey {
  entityKind: LinkedinEntityKind;
  /** The canonical URL the fetch layer will POST — one per real entity. */
  normalizedUrl: string;
  /** The stable external id when the URL carried one (sales-nav lead/company id, or the /in slug). */
  externalId: string | null;
}

/** Sales-Nav person profile URL from a lead/member id — the person twin of salesNavCompanyUrl. */
export function salesNavProfileUrl(leadId: string): string {
  return `https://www.linkedin.com/sales/lead/${encodeURIComponent(leadId)}`;
}

/**
 * Canonicalize any LinkedIn/Sales-Nav URL into a registry key, or null when the URL is not a recognizable
 * person/company target (a search/list/messaging surface, or a non-LinkedIn URL).
 *
 * Priority: a public `/in/<slug>` (or `/company/<slug>`) is the STRONGEST, most stable form, so it wins over
 * a sales-nav id when both are derivable; otherwise the sales-nav lead/company id form is used.
 */
export function linkedinUrlKey(rawUrl: string): LinkedinUrlKey | null {
  const parsed = parseSalesNavLink(rawUrl);

  // Public /in/<slug> → the canonical person key (the strongest, most stable form).
  const slug = publicProfileSlug(rawUrl);
  if (slug) {
    return {
      entityKind: "person",
      normalizedUrl: `https://www.linkedin.com/in/${slug}`,
      externalId: slug,
    };
  }

  if (parsed.inferredType === "profile" && parsed.salesNavLeadId) {
    return {
      entityKind: "person",
      normalizedUrl: salesNavProfileUrl(parsed.salesNavLeadId),
      externalId: parsed.salesNavLeadId,
    };
  }

  if (parsed.inferredType === "account" && parsed.salesNavLeadId) {
    // A numeric sales-nav company id → the sales-nav company URL (what the fetch layer already uses); a
    // public company slug stays as the /company/<slug> form.
    const id = parsed.salesNavLeadId;
    const isNumeric = /^\d+$/.test(id);
    return {
      entityKind: "company",
      normalizedUrl: isNumeric ? salesNavCompanyUrl(id) : `https://www.linkedin.com/company/${id}`,
      externalId: id,
    };
  }

  // Search / list / messaging / unrecognized → not a single fetch target.
  return null;
}
