// LinkedInAdapter — recognises /in/ profiles and /company/ pages and extracts the VISIBLE header the
// signed-in user is looking at (name, headline, location). It never calls Voyager/Sales-Navigator APIs
// and never patches the network (01 §3 documents Apollo's rejected technique; 07 §1 the ToS posture).
import type { CapturedRecord, PageType } from "../../../shared/types.ts";
import { firstText } from "../../extract/dom.ts";
import type { SiteAdapter } from "../types.ts";

const PROFILE_RE = /^\/in\/([^/]+)/;
const COMPANY_RE = /^\/company\/([^/]+)/;

export const linkedinAdapter: SiteAdapter = {
  id: "linkedin",

  matches(url: URL): boolean {
    return url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com");
  },

  pageType(url: URL): PageType {
    if (PROFILE_RE.test(url.pathname)) {
      return "profile";
    }
    if (COMPANY_RE.test(url.pathname)) {
      return "company";
    }
    if (url.pathname.startsWith("/search")) {
      return "search";
    }
    return "unsupported";
  },

  subjectKey(url: URL): string | null {
    const match = url.pathname.match(PROFILE_RE);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  },

  extract(url: URL, doc: Document): CapturedRecord | null {
    if (this.pageType(url) !== "profile") {
      return null;
    }
    const publicId = this.subjectKey(url);
    if (!publicId) {
      return null;
    }
    const fullName = firstText(doc, ["h1", "main h1", "section h1"]);
    const jobTitle = firstText(doc, [".text-body-medium.break-words", ".text-body-medium"]);
    const location = firstText(doc, [
      ".text-body-small.inline.t-black--light",
      "span.text-body-small",
    ]);
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
};
