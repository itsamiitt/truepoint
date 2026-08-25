// routeCoverage.test.ts — the portal's verify script says it fetches "every published route". This is what
// makes that sentence true.
//
// Three of the portal's routes are dynamic and generated from content arrays: /docs/[slug] from GUIDES,
// /datasets/[slug] from DATASETS, /docs/api/[endpoint] from ENDPOINTS. Adding a guide is a one-line edit to
// an array. Nothing about that edit hints that a list in scripts/routes.mjs also needs the new path, and the
// consequence of forgetting is quiet: the page ships having never been fetched, so the forbidden-copy check
// in verify.mjs — the one that catches a rule-4 or rule-7 claim hardcoded into JSX, which content.test.ts
// structurally cannot see — simply does not run on it.
//
// A missing page here is therefore not a broken link; it is a compliance check silently scoped to less than
// the site. That is why this asserts coverage rather than trusting the list.
//
// The direction is deliberate: every GENERATED route must be probed. The reverse — a probed route with no
// generator — is not asserted, because the static pages (/, /pricing, /trust, /changelog, /docs,
// /docs/playground, /docs/machine-reference) legitimately have no content array behind them, and verify.mjs
// fetching a route that 404s already fails loudly on its own.
import { describe, expect, test } from "bun:test";
import { PAGES } from "../../scripts/routes.mjs";
import { DATASETS } from "./datasets.ts";
import { ENDPOINTS } from "./endpoints/index.ts";
import { GUIDES } from "./guides/index.ts";

describe("verify.mjs probes every route the content generates", () => {
  test("every GUIDES slug has a /docs/<slug> probe", () => {
    const expected = GUIDES.map((g) => `/docs/${g.slug}`);
    expect(expected.length).toBeGreaterThan(0); // an empty array would make this pass vacuously
    expect(expected.filter((r) => !PAGES.includes(r))).toEqual([]);
  });

  test("every DATASETS slug has a /datasets/<slug> probe", () => {
    const expected = DATASETS.map((d) => `/datasets/${d.slug}`);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.filter((r) => !PAGES.includes(r))).toEqual([]);
  });

  test("every ENDPOINTS slug has a /docs/api/<slug> probe", () => {
    const expected = ENDPOINTS.map((e) => `/docs/api/${e.slug}`);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.filter((r) => !PAGES.includes(r))).toEqual([]);
  });

  test("the probe list has no duplicates", () => {
    // A duplicate is harmless to fetch and misleading to read: it inflates the count in the verify output, so
    // "19 routes checked" would stop meaning 19 distinct pages.
    expect(PAGES.length).toBe(new Set(PAGES).size);
  });
});
