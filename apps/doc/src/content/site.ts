// site.ts — the constants every page shares: the origin, the navigation, and the positioning line.
//
// The three proof points below are the only claims this site repeats on more than one page, so they are
// written once here. Each is a claim we can actually stand behind: two describe billing mechanics we control,
// and the third describes a page that exists. Nothing here asserts a coverage number, a match rate or a
// bounce rate — those are measured claims, and the moment one is published it has to be true and current.

export const SITE_ORIGIN = "https://doc.truepoint.in";

export const SITE_NAME = "TruePoint Data";

/** The public API's base URL — the one every example on the site curls. One constant so the header stamp,
 *  the facts strip and the examples cannot drift apart. */
export const API_BASE_URL = "https://api.truepoint.in/api/v1/public";

/** The contract stamp shown in the masthead and footer. "v1" is the path segment every call carries. */
export const API_VERSION_STAMP = "API v1";

/** The one-sentence description of what this portal documents. Used in metadata and on the landing page. */
export const SITE_TAGLINE =
  "Company and people data, delivered by API and priced by usage — with provenance on every field.";

export const PROOF_POINTS: readonly { title: string; body: string }[] = [
  {
    title: "No match, no charge",
    body: "A call that returns no data costs nothing. The meter moves on results, not on attempts, so our gaps are our problem rather than a line on your invoice.",
  },
  {
    title: "Provenance on every field",
    body: "Each field carries where it came from, when it was last seen, and how many independent signals agree. You can tell a fresh, corroborated value from a stale, single-source one before you act on it.",
  },
  {
    title: "Pricing published in full",
    body: "Per-action credit costs and every self-serve plan are on this site. There is no demo wall below the enterprise tier and no quote-only pricing to reverse-engineer.",
  },
];

export interface NavLink {
  readonly href: string;
  readonly label: string;
}

export const PRIMARY_NAV: readonly NavLink[] = [
  { href: "/docs", label: "Docs" },
  { href: "/pricing", label: "Pricing" },
  { href: "/datasets", label: "Datasets" },
  { href: "/trust", label: "Trust" },
  { href: "/changelog", label: "Changelog" },
];

export const FOOTER_NAV: readonly { heading: string; links: readonly NavLink[] }[] = [
  {
    heading: "Reference",
    links: [
      { href: "/docs", label: "Quickstart" },
      { href: "/docs/authentication", label: "Authentication" },
      { href: "/docs/errors", label: "Errors" },
      { href: "/docs/confidence", label: "Confidence and provenance" },
    ],
  },
  {
    heading: "Product",
    links: [
      { href: "/pricing", label: "Pricing" },
      { href: "/datasets", label: "Datasets" },
      { href: "/changelog", label: "Changelog" },
    ],
  },
  {
    heading: "Trust",
    links: [
      { href: "/trust", label: "How we source data" },
      { href: "/trust#your-data", label: "If your data is in here" },
      { href: "/trust#never", label: "What we never collect" },
    ],
  },
];

/** Where a reader goes to do something this static site deliberately cannot do for them (ADR-0048 §D4:
 *  no form on this site collects personal data, because a collection path needs a lawful basis, a consent
 *  surface, a suppression point and an erasure path — none of which a static page can provide). */
export const CONTACT = {
  general: "mailto:hello@truepoint.in",
  privacy: "mailto:privacy@truepoint.in",
  app: "https://app.truepoint.in",
} as const;
