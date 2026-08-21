// content.test.ts — the compliance rules for this site, as assertions.
//
// The rules ADR-0048 sets are not the kind that survive on comments alone. A future edit adding a real
// contact row to a sample table, or a marketing line about earning credits, would look completely reasonable
// in review — the reason it is forbidden lives three documents away. So the rules are encoded here, where
// breaking one fails `bun test` and names the file that did it.
//
// These are content assertions, not component tests: everything imported is a pure data module, so the suite
// needs no DOM.

import { describe, expect, test } from "bun:test";
import { CHANGELOG } from "./changelog.ts";
import { DATASETS } from "./datasets.ts";
import { ENDPOINTS } from "./endpoints/index.ts";
import { GUIDES, QUICKSTART } from "./guides/index.ts";
import { CREDIT_ACTIONS, PLANS } from "./pricing.ts";
import { PROOF_POINTS, SITE_TAGLINE } from "./site.ts";
import { TRUST_SECTIONS } from "./trust.ts";
import type { Block } from "./types.ts";

/** Every user-visible string on the site, flattened, so a rule can be asserted across all of it at once. */
function blockText(blocks: readonly Block[]): string[] {
  return blocks.flatMap((block) => {
    switch (block.kind) {
      case "p":
      case "h2":
      case "note":
        return [block.text];
      case "list":
        return [...block.items];
      case "code":
        return [block.source];
      case "table":
        return [...block.headers, ...block.rows.flat()];
    }
  });
}

const ALL_COPY: string[] = [
  SITE_TAGLINE,
  ...PROOF_POINTS.flatMap((point) => [point.title, point.body]),
  ...CREDIT_ACTIONS.map((action) => action.note),
  ...PLANS.flatMap((plan) => [plan.audience, ...plan.includes]),
  ...ENDPOINTS.flatMap((endpoint) => [endpoint.summary, endpoint.billing]),
  ...blockText(QUICKSTART.blocks),
  ...GUIDES.flatMap((guide) => blockText(guide.blocks)),
  ...TRUST_SECTIONS.flatMap((section) => blockText(section.blocks)),
  ...CHANGELOG.map((entry) => entry.body),
  ...DATASETS.map((dataset) => dataset.summary),
];

describe("no contributor-earned currency (CLAUDE.md rule 7)", () => {
  // The strategy pack deleted the credit/bounty reward economy outright (decisions.md, MONETIZATION PIVOT):
  // with nothing farmable, A-03 shrinks from economic fraud to data-quality fraud. The brief behind this
  // portal proposes reviving it. Until an operator decision says otherwise, no page may imply it.
  const FORBIDDEN = [
    /earn\s+\w*\s*credits?/i,
    /credits?\s+for\s+(?:each\s+)?contribut/i,
    /bounty/i,
    /reward\s+points?/i,
  ];

  for (const pattern of FORBIDDEN) {
    test(`no copy matches ${pattern}`, () => {
      const offenders = ALL_COPY.filter((line) => pattern.test(line));
      expect(offenders).toEqual([]);
    });
  }
});

describe("dataset samples are fabricated (ADR-0048 §D5)", () => {
  // A public page carrying real business-contact records is an egress nobody can suppress and nobody can
  // erase once cached. Every sample value that looks like a domain or an address must sit under a domain
  // RFC 2606 reserves, so no real person or company can be implicated by one.
  const RESERVED = /(?:^|@|\.)example\.(?:com|net|org)$/;

  for (const dataset of DATASETS) {
    test(`${dataset.slug} sample rows use reserved domains only`, () => {
      for (const row of dataset.sampleRows) {
        for (const value of Object.values(row)) {
          if (value.includes("@")) {
            expect(value.split("@")[1] ?? "").toMatch(RESERVED);
          } else if (value.includes(".") && !/^\d/.test(value)) {
            expect(value).toMatch(RESERVED);
          }
        }
      }
    });
  }
});

describe("nothing claims to be live before it is", () => {
  test("every endpoint, dataset and plan declares its availability", () => {
    const declared = [
      ...ENDPOINTS.map((endpoint) => endpoint.availability),
      ...DATASETS.map((dataset) => dataset.availability),
      ...PLANS.map((plan) => plan.availability),
    ];
    expect(declared.every((value) => ["available", "beta", "planned"].includes(value))).toBe(true);
  });

  test("every endpoint documents its errors and a worked example", () => {
    for (const endpoint of ENDPOINTS) {
      expect(endpoint.errors.length).toBeGreaterThan(0);
      expect(endpoint.example.request.length).toBeGreaterThan(0);
      expect(endpoint.example.response.length).toBeGreaterThan(0);
    }
  });
});

describe("content slugs are unique", () => {
  // Two guides or endpoints sharing a slug is a route collision that generateStaticParams would resolve
  // silently, publishing one and losing the other.
  test("no duplicate slugs within a content family", () => {
    const families = [
      GUIDES.map((guide) => guide.slug),
      ENDPOINTS.map((endpoint) => endpoint.slug),
      DATASETS.map((dataset) => dataset.slug),
    ];
    for (const slugs of families) {
      expect(new Set(slugs).size).toBe(slugs.length);
    }
  });

  test("the quickstart is not also a /docs/[slug] page", () => {
    expect(GUIDES.map((guide) => guide.slug)).not.toContain(QUICKSTART.slug);
  });
});
