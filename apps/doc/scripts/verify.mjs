#!/usr/bin/env node
// verify.mjs — post-build smoke check for the developer portal. Fetches every published route from a
// RUNNING server and asserts what unit tests structurally cannot: that the page actually rendered, that the
// chrome is on it, that the accessibility skeleton is intact, and that no forbidden copy reached the HTML.
//
// Why a running server rather than a bun test: the compliance guarantee that matters is about DELIVERED
// HTML. content.test.ts asserts the content modules are clean, but a future edit could hardcode a claim
// straight into JSX and slip past it — this catches that, because it reads what a visitor would receive.
//
//   bun run --filter @leadwolf/doc start   # in one shell
//   bun run --filter @leadwolf/doc verify  # in another
//
// Runs in CI (the "Developer portal — rendered-HTML + a11y + CSP checks" step in .github/workflows/ci.yml,
// which starts the portal on the runner first), locally against `next start`, and against the live origin
// via DOC_BASE_URL. deploy/deploy.sh runs a lighter probe of the same idea post-deploy.
const BASE = process.env.DOC_BASE_URL ?? "http://localhost:3007";

const PAGES = [
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
const FILES = ["/robots.txt", "/sitemap.xml", "/llms.txt", "/openapi.json", "/changelog.xml"];

// Claims that must never reach a reader. Each is a CLAUDE.md hard rule, not a style preference:
// earned credits and bounties are rule 7; the Sales Navigator supply path is rule 4.
const FORBIDDEN = [
  { re: /earn\s+\w*\s*credits?/i, why: "contributor-earned credits (rule 7)" },
  { re: /credits?\s+for\s+(?:each\s+)?contribut/i, why: "credits for contributing (rule 7)" },
  { re: /bounty/i, why: "bounty currency (rule 7)" },
  { re: /sales\s*nav/i, why: "Sales Navigator supply path (rule 4)" },
];

const report = [];
let failures = 0;

function fail(route, problems) {
  failures += 1;
  report.push(`FAIL ${route} — ${problems.join("; ")}`);
}

function checkAccessibility(body) {
  const problems = [];
  if (!/<html[^>]+lang="en"/.test(body)) problems.push("no lang on <html>");
  if (!/<title>[^<]+<\/title>/.test(body)) problems.push("no <title>");

  const h1s = (body.match(/<h1[\s>]/g) ?? []).length;
  if (h1s !== 1) problems.push(`${h1s} <h1> (expected exactly 1)`);

  for (const tag of ["header", "nav", "main", "footer"]) {
    if (!new RegExp(`<${tag}[\\s>]`).test(body)) problems.push(`no <${tag}> landmark`);
  }

  // A skipped heading level breaks the document outline a screen-reader user navigates by.
  const levels = [...body.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i] - levels[i - 1] > 1) {
      problems.push(`heading level jump: h${levels[i - 1]} → h${levels[i]}`);
      break;
    }
  }

  // With more than one nav on the page, each needs a name or they are indistinguishable in a landmark list.
  const navs = [...body.matchAll(/<nav([^>]*)>/g)].map((m) => m[1] ?? "");
  if (navs.length > 1) {
    const unnamed = navs.filter((attrs) => !/aria-label=|aria-labelledby=/.test(attrs)).length;
    if (unnamed) problems.push(`${unnamed} of ${navs.length} <nav> lack an accessible name`);
  }

  for (const m of body.matchAll(/<a\b[^>]*>([^<]{1,20})<\/a>/g)) {
    const text = (m[1] ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z ]/g, "");
    if (["here", "click here", "link", "read more", "more"].includes(text)) {
      problems.push(`link text says nothing out of context: "${(m[1] ?? "").trim()}"`);
      break;
    }
  }

  if (/tabindex="[1-9]/.test(body)) problems.push("positive tabindex breaks focus order");
  return problems;
}

for (const route of [...PAGES, ...FILES]) {
  let res;
  let body;
  try {
    res = await fetch(BASE + route, { redirect: "manual" });
    body = await res.text();
  } catch (err) {
    fail(route, [`fetch threw: ${err.message}`]);
    continue;
  }

  const problems = [];
  if (res.status !== 200) problems.push(`status ${res.status}`);

  if (PAGES.includes(route)) {
    if (/Application error|This page could not be found|__NEXT_ERROR/.test(body)) {
      problems.push("an error boundary rendered instead of the page");
    }
    // The chrome is what carries the skip link and the route to privacy@ — both required on every page.
    if (!body.includes("Skip to content")) problems.push("missing skip link");
    if (!body.includes("privacy@truepoint.in")) problems.push("missing privacy contact");
    // Search lives in the root layout, so its absence from ANY page means the chrome itself broke. It is
    // also the one control on this site a reader is likely to reach for before the nav, and it is a client
    // component: a hydration failure would leave the input inert rather than missing, which is why the
    // keyboard behaviour is proven in a browser rather than here. This asserts only that it was delivered,
    // named, and in its closed state.
    const combobox = /<input\b[^>]*role="combobox"[^>]*>/.exec(body)?.[0];
    if (!combobox) problems.push("missing masthead search");
    else {
      if (!/aria-label=|aria-labelledby=/.test(combobox)) problems.push("search has no accessible name");
      if (!/aria-expanded="false"/.test(combobox)) problems.push("search does not render collapsed");
      if (!/aria-controls=/.test(combobox)) problems.push("search combobox names no popup");
    }
    problems.push(...checkAccessibility(body));
  }

  for (const { re, why } of FORBIDDEN) {
    if (re.test(body)) problems.push(`FORBIDDEN COPY reached the page: ${why}`);
  }

  if (problems.length) fail(route, problems);
  else report.push(`ok   ${route} (${res.status}, ${body.length}b)`);
}

// Security headers. These are set in next.config.mjs and are invisible in the HTML, so nothing else would
// notice them silently disappearing. The CSP directives listed are the ones that carry the real mitigation
// (see the reasoning in next.config.mjs) — script-src is deliberately permissive and is not asserted strict.
// Only checked against a production server: the whole set is NODE_ENV-gated, so `next dev` legitimately
// sends none of it.
{
  const res = await fetch(BASE + "/");
  const csp = res.headers.get("content-security-policy") ?? "";
  const problems = [];

  for (const [header, expected] of [
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
    ["x-frame-options", "DENY"],
  ]) {
    const got = res.headers.get(header);
    if (got !== expected)
      problems.push(`${header}: expected "${expected}", got "${got ?? "(absent)"}"`);
  }

  if (!csp) {
    problems.push(
      "no Content-Security-Policy (expected on a production server; absent under next dev)",
    );
  } else {
    for (const directive of [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
      "connect-src 'self'",
    ]) {
      if (!csp.includes(directive)) problems.push(`CSP missing: ${directive}`);
    }
  }

  if (problems.length) fail("security headers", problems);
  else report.push("ok   security headers (CSP, XCTO, Referrer-Policy, XFO)");
}

// Does the CSP actually break anything? Header presence does not answer that — a policy is only safe if
// every sub-resource the page loads is one it permits. So enumerate them: every <script src>, every
// stylesheet, and every url() inside those stylesheets, and assert each is same-origin or a data: URI.
// If that holds, `default-src 'self'` + `img-src 'self' data:` cannot block a single request, which is a
// stronger and more durable statement than one manual look at a browser console.
//
// Not covered here: an inline script the CSP would block. It cannot — script-src carries 'unsafe-inline',
// deliberately and documented in next.config.mjs.
{
  const problems = [];
  const pageUrl = new URL(BASE);
  const html = await (await fetch(BASE + "/")).text();

  /** Same-origin, root-relative, or a data: URI — anything else needs a CSP allowance we do not grant. */
  function permitted(url) {
    if (url.startsWith("data:")) return true;
    if (url.startsWith("/") && !url.startsWith("//")) return true;
    try {
      return new URL(url, BASE).origin === pageUrl.origin;
    } catch {
      return false;
    }
  }

  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const sheets = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g)].map(
    (m) => m[1],
  );
  const preloads = [...html.matchAll(/<link[^>]+rel="preload"[^>]*href="([^"]+)"/g)].map(
    (m) => m[1],
  );

  for (const url of [...scripts, ...sheets, ...preloads]) {
    if (!permitted(url)) problems.push(`off-origin sub-resource the CSP would block: ${url}`);
  }

  // Follow the stylesheets and check what THEY pull in — fonts and background images live here, not in the
  // HTML, and a webfont blocked by font-src is exactly the kind of thing nobody notices until it ships.
  for (const sheet of sheets) {
    const css = await (await fetch(new URL(sheet, BASE))).text();
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const url = (m[1] ?? "").trim();
      if (!permitted(url)) problems.push(`off-origin url() in ${sheet}: ${url}`);
    }
  }

  if (!scripts.length) problems.push("no <script src> found — the HTML parse is probably wrong");
  if (!sheets.length) problems.push("no stylesheet found — the HTML parse is probably wrong");

  if (problems.length) fail("CSP sub-resource audit", problems);
  else {
    report.push(
      `ok   CSP sub-resource audit (${scripts.length} scripts, ${sheets.length} sheets, ${preloads.length} preloads — all same-origin or data:)`,
    );
  }
}

// A 404 must render this app's own not-found, with a way onward — someone mistyping a URL while trying to
// reach the opt-out route should not hit a dead end.
try {
  const res = await fetch(`${BASE}/no-such-page-here`);
  const body = await res.text();
  if (res.status !== 404) fail("/no-such-page-here", [`status ${res.status}, expected 404`]);
  else if (!body.includes("Go to the docs"))
    fail("/no-such-page-here", ["404 lacks the app's not-found"]);
  else report.push("ok   /no-such-page-here → 404 with the app's own not-found");
} catch (err) {
  fail("/no-such-page-here", [`fetch threw: ${err.message}`]);
}

process.stdout.write(`${report.join("\n")}\n`);
process.stdout.write(failures === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures} FAILURES\n`);
// exitCode rather than process.exit(): forcing teardown while fetch handles are still closing crashes
// Node on Windows with a libuv assertion, which would make a passing run look like a failure.
process.exitCode = failures === 0 ? 0 : 1;
