// LinkedInAdapter — recognises /in/ profiles, /company/ pages, and Sales-Navigator surfaces, extracting
// the VISIBLE header the signed-in user is looking at (name, headline, location) and, on a Sales-Nav
// search/list page, the RESULT-ROW ANCHOR HREFS (URLs only). It never calls Voyager/Sales-Navigator APIs
// and never patches the network (01 §3 documents Apollo's rejected technique; the URL-only harvest stays
// under the ADR-0043 user-visible-DOM posture; the licensed source API supplies the actual data).
import type { CapturedLink, CapturedRecord, PageType } from "../../../shared/types.ts";
import { firstText } from "../../extract/dom.ts";
import type { SiteAdapter } from "../types.ts";

const PROFILE_RE = /^\/in\/([^/]+)/;
const COMPANY_RE = /^\/company\/([^/]+)/;
// Sales-Nav lead/people = a person; sales/company = a company.
const SALES_PROFILE_RE = /^\/sales\/(lead|people)\/([^/,?#]+)/;
const SALES_COMPANY_RE = /^\/sales\/company\/([^/,?#]+)/;
const SALES_SEARCH_RE = /^\/sales\/(search|lists)\//;

/** The visible-DOM anchors that carry a lead/person/company URL on a Sales-Nav search or list page. */
const LINK_SELECTORS = [
  'a[href*="/sales/lead/"]',
  'a[href*="/sales/people/"]',
  'a[href*="/sales/company/"]',
  'a[href*="/in/"]',
];

export const linkedinAdapter: SiteAdapter = {
  id: "linkedin",

  matches(url: URL): boolean {
    return url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com");
  },

  pageType(url: URL): PageType {
    if (PROFILE_RE.test(url.pathname) || SALES_PROFILE_RE.test(url.pathname)) {
      return "profile";
    }
    if (COMPANY_RE.test(url.pathname) || SALES_COMPANY_RE.test(url.pathname)) {
      return "company";
    }
    if (SALES_SEARCH_RE.test(url.pathname)) {
      return "sales_search";
    }
    if (url.pathname.startsWith("/search")) {
      return "search";
    }
    return "unsupported";
  },

  subjectKey(url: URL): string | null {
    const match = url.pathname.match(PROFILE_RE);
    if (match?.[1]) return decodeURIComponent(match[1]);
    // Sales-Nav lead/people pages carry no public slug — the lead id is the subject key there, so the
    // card/lookup/capture flow works on Sales-Nav too (previously these pages had no subject at all).
    const sales = url.pathname.match(SALES_PROFILE_RE);
    return sales?.[2] ? `sales-lead:${decodeURIComponent(sales[2])}` : null;
  },

  extract(url: URL, doc: Document): CapturedRecord | null {
    if (this.pageType(url) !== "profile") {
      return null;
    }
    const subjectKey = this.subjectKey(url);
    if (!subjectKey) {
      return null;
    }
    const fullName = firstText(doc, ["h1", "main h1", "section h1"]);
    const jobTitle = firstText(doc, [".text-body-medium.break-words", ".text-body-medium"]);
    const location = firstText(doc, [
      ".text-body-small.inline.t-black--light",
      "span.text-body-small",
    ]);

    const salesMatch = url.pathname.match(SALES_PROFILE_RE);
    if (salesMatch?.[2]) {
      const leadId = decodeURIComponent(salesMatch[2]);
      return {
        subjectKey,
        adapter: "linkedin",
        pageType: "profile",
        fields: {
          fullName,
          jobTitle,
          location,
          profileUrl: `https://www.linkedin.com/sales/lead/${encodeURIComponent(leadId)}`,
          salesNavLeadId: leadId,
        },
        sourceUrl: url.href,
        capturedAt: new Date().toISOString(),
      };
    }

    const publicId = subjectKey;
    const profileUrl = `${url.origin}/in/${encodeURIComponent(publicId)}`;
    return {
      subjectKey: publicId,
      adapter: "linkedin",
      pageType: "profile",
      fields: {
        fullName,
        jobTitle,
        location,
        profileUrl,
        publicId,
      },
      sourceUrl: url.href,
      capturedAt: new Date().toISOString(),
    };
  },

  /** Harvest the result-row anchor hrefs on a Sales-Nav search/list page (visible-DOM only). Returns the
   *  deduped absolute URLs the user is looking at — nothing else off the page. Empty on a non-list page. */
  harvestLinks(url: URL, doc: Document): CapturedLink[] {
    if (this.pageType(url) !== "sales_search") return [];
    const seen = new Set<string>();
    const links: CapturedLink[] = [];
    for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>(LINK_SELECTORS.join(",")))) {
      const href = a.getAttribute("href");
      if (!href) continue;
      let abs: string;
      try {
        abs = new URL(href, url.origin).href;
      } catch {
        continue;
      }
      const path = new URL(abs).pathname;
      const entityKind: "person" | "company" | undefined = SALES_COMPANY_RE.test(path)
        ? "company"
        : SALES_PROFILE_RE.test(path) || PROFILE_RE.test(path)
          ? "person"
          : undefined;
      if (!entityKind || seen.has(abs)) continue;
      seen.add(abs);
      links.push({ url: abs, entityKind });
    }
    return links;
  },
};
