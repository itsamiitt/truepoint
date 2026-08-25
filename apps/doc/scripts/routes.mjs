// routes.mjs — the portal's published surface, as one list two things read.
//
// verify.mjs fetches each of these from a running server and asserts what unit tests structurally cannot: that
// the page rendered, that the chrome and the a11y skeleton are on it, and that no forbidden copy reached the
// delivered HTML. That last check is the one with teeth — content.test.ts proves the content MODULES carry no
// rule-4/rule-7 copy, but a claim hardcoded straight into JSX would sail past it, and only a fetch of the real
// page catches that.
//
// WHICH MAKES A HARDCODED LIST THE WEAK LINK. Three of these routes are dynamic — /docs/[slug],
// /datasets/[slug], /docs/api/[endpoint] — and their pages come from content arrays (GUIDES, DATASETS,
// ENDPOINTS). Adding a guide is a one-line edit to an array; nothing about that edit suggests a second file
// needs updating. The new page would then ship having never been fetched, and the forbidden-copy check simply
// would not run on it. verify.mjs's own header says it "fetches every published route", which is the kind of
// claim that stays true only while someone keeps it true.
//
// So the list lives here, and routeCoverage.test.ts holds it to that sentence: it derives the routes from the
// same arrays the pages are generated from and fails if any generated route is missing. The list stays
// explicit — a reader can see the surface at a glance — while drift becomes a test failure rather than a
// silent gap in a compliance check.

/** Every HTML route. Static ones are literal; the rest are generated and asserted by routeCoverage.test.ts. */
export const PAGES = [
  "/",
  "/pricing",
  "/datasets",
  "/datasets/us-accounting-firms",
  "/datasets/us-managed-it-services",
  "/docs",
  "/docs/playground",
  "/docs/machine-reference",
  "/docs/authentication",
  "/docs/errors",
  "/docs/pagination",
  "/docs/confidence",
  "/docs/versioning",
  "/docs/api/company-match",
  "/docs/api/company-enrich",
  "/docs/api/search",
  "/docs/api/person-enrich",
  "/trust",
  "/changelog",
];

/** Non-HTML artefacts served by the portal. Fetched too, but not parsed as pages. */
export const FILES = [
  "/robots.txt",
  "/sitemap.xml",
  "/llms.txt",
  "/openapi.json",
  "/changelog.xml",
];
