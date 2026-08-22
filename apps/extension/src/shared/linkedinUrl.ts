// linkedinUrl.ts — PURE: which subject is the user looking at, derived from the URL alone.
//
// The side panel is not a content script. It has no DOM to read, it can be opened long after a page loaded,
// and it must follow the user across tabs — so it cannot wait for the content script's LOOKUP broadcast to
// learn what is on screen (the "hydrate-on-open" gap). The service worker answers GET_SUBJECT from the active
// tab's URL using this function, which is the whole reason it is separate from the site adapter: the adapter
// needs a Document, this needs a string.
//
// URL ONLY, never the page. Every identifier the panel needs is already in the address bar (chrome-extension/15
// §2), so there is no new extraction here and none is needed — reading the URL of a tab the user opened is not
// scraping, and this file could not scrape if it wanted to.
//
// The person keys are IDENTICAL to the adapter's `subjectKey()` (`<slug>` / `sales-lead:<id>`) because the
// panel and the hover card must agree about what "the same subject" means — they share the SUBJECT_STATUS
// broadcast and the SW's caches, all keyed by that string. Company keys are new: the adapter returns null for
// company pages (X07 — no company DOM extraction, deliberately), so the panel is the first surface that can
// address one, and it does so from the URL alone.

/** What kind of page the URL addresses. Companies are server-resolved; nothing is read off the page. */
export type ViewedSubjectKind = "person" | "company";

export interface ViewedSubject {
  kind: ViewedSubjectKind;
  /** The cache/broadcast key. Person: `<slug>` | `sales-lead:<id>`. Company: `company:<slug|id>`. */
  subjectKey: string;
  /** The canonical page URL to send to the server, which does its own canonicalization (linkedinUrlKey). */
  sourceUrl: string;
}

const PROFILE_RE = /^\/in\/([^/?#]+)/;
const COMPANY_RE = /^\/company\/([^/?#]+)/;
// Sales-Nav lead/people = a person; sales/company = a company. Both carry ids rather than public slugs.
const SALES_PROFILE_RE = /^\/sales\/(?:lead|people)\/([^/,?#]+)/;
const SALES_COMPANY_RE = /^\/sales\/company\/([^/,?#]+)/;

function isLinkedIn(host: string): boolean {
  const h = host.toLowerCase();
  return h === "linkedin.com" || h.endsWith(".linkedin.com");
}

/**
 * The subject a LinkedIn/Sales-Navigator URL addresses, or null for anything else — a feed, a search page, a
 * message thread, or a non-LinkedIn tab. Null is the normal case (most tabs are not prospects) and the panel
 * renders its "open a profile" empty state for it; it is never an error.
 *
 * Fail-soft by construction: an unparseable string returns null rather than throwing, because this runs on
 * whatever URL happens to be in the active tab.
 */
export function subjectFromUrl(rawUrl: string | undefined | null): ViewedSubject | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isLinkedIn(url.hostname)) return null;

  const profile = url.pathname.match(PROFILE_RE);
  if (profile?.[1]) {
    const slug = decodeURIComponent(profile[1]);
    return {
      kind: "person",
      subjectKey: slug,
      // Rebuilt rather than passed through: the address bar carries tracking params and trailing segments
      // (`/recent-activity/`, `?miniProfileUrn=…`) that are not part of the identity.
      sourceUrl: `https://www.linkedin.com/in/${slug}`,
    };
  }

  const lead = url.pathname.match(SALES_PROFILE_RE);
  if (lead?.[1]) {
    const id = decodeURIComponent(lead[1]);
    return {
      kind: "person",
      subjectKey: `sales-lead:${id}`,
      sourceUrl: `https://www.linkedin.com/sales/lead/${id}`,
    };
  }

  // Order matters: a Sales-Nav company path also contains "/company/", so it must be matched before the
  // public form. (The same substring trap bit the server-side composer; it is written down in both places.)
  const salesCompany = url.pathname.match(SALES_COMPANY_RE);
  if (salesCompany?.[1]) {
    const id = decodeURIComponent(salesCompany[1]);
    return {
      kind: "company",
      subjectKey: `company:${id}`,
      sourceUrl: `https://www.linkedin.com/sales/company/${id}`,
    };
  }

  const company = url.pathname.match(COMPANY_RE);
  if (company?.[1]) {
    const slug = decodeURIComponent(company[1]);
    return {
      kind: "company",
      subjectKey: `company:${slug}`,
      sourceUrl: `https://www.linkedin.com/company/${slug}`,
    };
  }

  return null;
}
