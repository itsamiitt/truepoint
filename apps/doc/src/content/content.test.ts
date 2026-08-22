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

describe("worked examples never implicate a real domain (ADR-0048 §D5)", () => {
  // The dataset rule above covers sample ROWS. Examples were exempt by oversight, and they had drifted into
  // exactly the same failure: a fabricated firmographic record — industry, headcount, revenue band — attached
  // to acme.com, and a fabricated person with a work address at it. A reader cannot tell an illustration from
  // a claim, and the subject of the claim never consented to appear in either. Reserved domains only.
  const RESERVED = /(?:^|@|\.)example\.(?:com|net|org)$/;

  /** Hosts a request or response sample may legitimately name: our own API, and the error type namespace. */
  const OURS = new Set([
    "api.truepoint.in",
    "doc.truepoint.in",
    "truepoint.in",
    "app.truepoint.in",
  ]);

  function hostsIn(sample: string): string[] {
    const hosts = new Set<string>();
    for (const match of sample.matchAll(/https?:\/\/([a-z0-9.-]+)/gi))
      hosts.add((match[1] ?? "").toLowerCase());
    for (const match of sample.matchAll(/"(?:domain|company_domain)"\s*:\s*"([^"]+)"/gi)) {
      hosts.add(
        (match[1] ?? "")
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .split("/")[0] ?? "",
      );
    }
    for (const match of sample.matchAll(/[?&]domain=([^"&\s\\]+)/gi)) {
      hosts.add(
        (match[1] ?? "")
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .split("/")[0] ?? "",
      );
    }
    for (const match of sample.matchAll(/"[a-z_]*email"\s*:\s*"[^"@]+@([^"]+)"/gi)) {
      hosts.add((match[1] ?? "").toLowerCase());
    }
    return [...hosts].filter(Boolean);
  }

  for (const endpoint of ENDPOINTS) {
    test(`${endpoint.slug} examples name only reserved or TruePoint hosts`, () => {
      for (const sample of [endpoint.example.request, endpoint.example.response]) {
        for (const host of hostsIn(sample)) {
          if (OURS.has(host)) continue;
          expect(host).toMatch(RESERVED);
        }
      }
    });
  }

  test("guide code samples follow the same rule", () => {
    for (const guide of [QUICKSTART, ...GUIDES]) {
      for (const block of guide.blocks) {
        if (block.kind !== "code") continue;
        for (const host of hostsIn(block.source)) {
          if (OURS.has(host)) continue;
          expect(host).toMatch(RESERVED);
        }
      }
    }
  });
});

describe("no sample teaches a request the API would reject", () => {
  // The quickstart shipped `-d '{"id":"cmp_2b81"}'` for company enrich long after the opaque id was retired
  // in favour of the registrable domain (endpoints/company.ts, corrected 2026-08-21). Someone following the
  // page verbatim got a 422 on their second-ever call. The company endpoints are keyed by domain, and no
  // sample for them may say otherwise.
  const COMPANY_SLUGS = new Set(["company-match", "company-enrich"]);

  for (const endpoint of ENDPOINTS) {
    if (!COMPANY_SLUGS.has(endpoint.slug)) continue;
    test(`${endpoint.slug} example is keyed by domain, not an opaque id`, () => {
      expect(endpoint.example.request).toContain("domain");
      expect(endpoint.example.request).not.toMatch(/"id"\s*:/);
      expect(endpoint.example.response).not.toContain("cmp_");
    });
  }

  test("no guide sample sends a cmp_ id to a company endpoint", () => {
    for (const guide of [QUICKSTART, ...GUIDES]) {
      for (const block of guide.blocks) {
        if (block.kind !== "code") continue;
        if (!block.source.includes("/company/")) continue;
        expect(block.source).not.toContain("cmp_");
      }
    }
  });
});

describe("the site does not describe headers the API never sends", () => {
  // The pagination guide told readers to back off by a `Retry-After` header. The shipped renderer
  // (apps/api/src/middleware/error.ts) sets only `content-type: application/problem+json` and returns
  // RateLimitedError's `retryAfterSeconds` as a body member — no route sets the header. A client following
  // that guide read null, waited zero seconds, and hammered the limit it had just hit. The errors guide had
  // it right all along, which is what made the contradiction invisible in review: both pages sounded
  // authoritative.
  //
  // If the API ever does send the header, delete this test in the same change — not before.
  test("every mention of Retry-After says the API does not send one", () => {
    // Naming the header is fine — useful, even, since a reader arrives expecting it. What is not fine is
    // naming it without the correction, so the rule is "mention it only while denying it".
    const DENIES = /(?:no|not|rather than|instead of)\s+(?:a\s+)?Retry-After/i;
    const offenders = ALL_COPY.filter((line) => /Retry-After/i.test(line) && !DENIES.test(line));
    expect(offenders).toEqual([]);
  });

  test("the retry interval is described where it actually lives — the body", () => {
    const mentions = ALL_COPY.filter((line) => /retryAfterSeconds/.test(line));
    expect(mentions.length).toBeGreaterThan(0);
  });
});

describe("no callable endpoint promises a provenance block that does not exist yet", () => {
  // ADR-0048 C5. The site publishes a field_provenance descriptor of { sources, class, last_seen }; the
  // shipped store (packages/types/src/fieldProvenance.ts) holds { src, mth, conf, obs, ver, pin, … } — a
  // source label and a 0–1 confidence, with no agreement count and no class. The published shape is a
  // PROJECTION nobody has built or specified yet, so it may only appear on endpoints marked planned. The day
  // one of them becomes callable, this test fails and forces the projection to be real first.
  for (const endpoint of ENDPOINTS) {
    if (endpoint.availability === "planned") continue;
    test(`${endpoint.slug} (callable) declares no field_provenance return`, () => {
      const names = endpoint.returns.map((field) => field.name);
      expect(names.some((name) => name.includes("field_provenance"))).toBe(false);
      expect(endpoint.example.response).not.toContain("field_provenance");
    });
  }

  test("the guide says plainly that nothing callable emits it", () => {
    const confidence = GUIDES.find((guide) => guide.slug === "confidence");
    expect(confidence).toBeDefined();
    const copy = blockText((confidence as { blocks: readonly Block[] }).blocks).join(" ");
    expect(copy).toContain("No callable endpoint returns field_provenance yet");
  });
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
