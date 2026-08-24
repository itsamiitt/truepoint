// searchIndex.test.ts — the index is only useful if every hit goes somewhere real and short queries rank the
// way a reader expects. Both are checked here rather than by clicking, because the corpus grows every time
// someone adds an endpoint or a guide and nobody re-clicks 40 links.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATASETS } from "./datasets.ts";
import { ENDPOINTS } from "./endpoints/index.ts";
import { GUIDES } from "./guides/index.ts";
import { SEARCH_DOCS, searchDocs } from "./searchIndex.ts";
import { TRUST_SECTIONS } from "./trust.ts";

const APP_DIR = join(import.meta.dir, "..", "app");

/** Static routes have a page.tsx; dynamic ones are proved against their content list instead. */
function staticRouteExists(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  return existsSync(join(APP_DIR, ...segments, "page.tsx"));
}

describe("search corpus", () => {
  test("ids are unique", () => {
    const ids = SEARCH_DOCS.map((document_) => document_.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every document has a title, a summary and a body", () => {
    for (const document_ of SEARCH_DOCS) {
      expect(document_.title.length).toBeGreaterThan(0);
      expect(document_.summary.length).toBeGreaterThan(0);
      // Title + summary alone would pass a length check, so require the body to exceed them: a document whose
      // body is nothing but its own heading is one whose page text failed to flatten.
      expect(document_.body.length).toBeGreaterThan(
        document_.title.length + document_.summary.length + 40,
      );
    }
  });

  test("body is lower-cased, because matching never lower-cases the haystack again", () => {
    for (const document_ of SEARCH_DOCS) {
      expect(document_.body).toBe(document_.body.toLowerCase());
    }
  });

  // The failure this prevents: a result that 404s. Renaming a guide slug or dropping an endpoint would
  // otherwise leave a searchable link pointing at nothing, and search is exactly where a reader who could not
  // find the page by navigating ends up.
  test("every href resolves to a real page", () => {
    const guideSlugs = new Set(GUIDES.map((guide) => guide.slug));
    const endpointSlugs = new Set(ENDPOINTS.map((endpoint) => endpoint.slug));
    const datasetSlugs = new Set(DATASETS.map((dataset) => dataset.slug));
    const trustIds = new Set(TRUST_SECTIONS.map((section) => section.id));

    for (const { href, id } of SEARCH_DOCS) {
      const [path, hash] = href.split("#");
      expect(path).toBeDefined();
      const route = path ?? "";

      if (route.startsWith("/docs/api/")) {
        expect(endpointSlugs.has(route.slice("/docs/api/".length))).toBe(true);
      } else if (route.startsWith("/datasets/")) {
        expect(datasetSlugs.has(route.slice("/datasets/".length))).toBe(true);
      } else if (route.startsWith("/docs/") && !staticRouteExists(route)) {
        expect(guideSlugs.has(route.slice("/docs/".length))).toBe(true);
      } else {
        expect(staticRouteExists(route)).toBe(true);
      }

      if (hash !== undefined) expect(trustIds.has(hash)).toBe(`${id}`.startsWith("trust:"));
    }
  });

  test("every endpoint, guide and dataset is reachable from search", () => {
    const ids = new Set(SEARCH_DOCS.map((document_) => document_.id));
    for (const endpoint of ENDPOINTS) expect(ids.has(`api:${endpoint.slug}`)).toBe(true);
    for (const guide of GUIDES) expect(ids.has(`guide:${guide.slug}`)).toBe(true);
    for (const dataset of DATASETS) expect(ids.has(`dataset:${dataset.slug}`)).toBe(true);
  });
});

describe("searchDocs", () => {
  test("an empty query returns nothing, not everything", () => {
    expect(searchDocs("")).toEqual([]);
    expect(searchDocs("   ")).toEqual([]);
    expect(searchDocs("!!! ???")).toEqual([]);
  });

  test("a title match outranks a body mention of the same word", () => {
    const hits = searchDocs("pagination");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.href).toBe("/docs/pagination");
  });

  test("tokens are ANDed, so adding a word narrows rather than widens", () => {
    const broad = searchDocs("errors", 50);
    const narrow = searchDocs("errors idempotency", 50);
    expect(narrow.length).toBeLessThanOrEqual(broad.length);
    for (const hit of narrow) {
      expect(hit.body).toContain("errors");
      expect(hit.body).toContain("idempotency");
    }
  });

  test("a word that appears only in body text still finds its page", () => {
    // Nothing is titled "bearer" — it lives in a sentence in the authentication guide, and the reader who
    // types it is precisely the one who could not find that page by its title.
    const hits = searchDocs("bearer");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.href === "/docs/authentication")).toBe(true);
  });

  test("punctuation in the query does not prevent a match", () => {
    expect(searchDocs("problem+json").length).toBeGreaterThan(0);
    expect(searchDocs("429.").length).toBeGreaterThan(0);
  });

  test("case is irrelevant", () => {
    expect(searchDocs("CONFIDENCE").map((hit) => hit.id)).toEqual(
      searchDocs("confidence").map((hit) => hit.id),
    );
  });

  test("a query matching nothing returns nothing", () => {
    expect(searchDocs("zzzznotawordhere")).toEqual([]);
  });

  test("the limit is honoured", () => {
    // "a" appears in the body of essentially everything, which makes it the widest possible query.
    expect(searchDocs("a", 3).length).toBeLessThanOrEqual(3);
  });

  test("results are ordered by descending score", () => {
    const hits = searchDocs("credits", 50);
    for (let index = 1; index < hits.length; index += 1) {
      const previous = hits[index - 1];
      const current = hits[index];
      if (!previous || !current) continue;
      expect(previous.score).toBeGreaterThanOrEqual(current.score);
    }
  });
});
