// searchIndex.ts — site search, built from the content modules rather than from the rendered HTML.
//
// A docs site without search makes the reader guess which of four nav sections holds "why did I get a 429"
// (Guides → Errors), "what does confidence 0.62 mean" (Guides → Confidence) or "which field carries the
// LinkedIn URL" (a returns table inside one endpoint page). Every one of those answers is already typed data
// here, so the index is a fold over the same constants the pages render from — not a crawler, not a build
// step, not a service. Add an endpoint to ENDPOINTS and it becomes searchable in the same commit that gives
// it a route, with no second place to remember.
//
// WHY THIS IS NOT A SEARCH SERVICE. The whole site is `force-static` and ADR-0048 §D2 requires a zero-env
// build; the SearchPort seam in packages/search is Postgres-backed and belongs to the product, which this app
// is forbidden to reach (`doc-app-holds-no-data-path` allows @leadwolf/ui and @leadwolf/app-shell only).
// The corpus is ~40 documents. Sending that to a server would be slower than the array scan below, and would
// leak what a prospect searched for before they ever identify themselves.
//
// The index deliberately carries BODY text, not just titles. Titles alone answer "authentication" and nothing
// else — the reader who types "bearer", "cursor", "problem+json" or "suppression" is asking about a sentence
// in the middle of a page, and that is exactly the reader who cannot navigate to it.

import { CHANGELOG } from "./changelog.ts";
import { DATASETS } from "./datasets.ts";
import { ENDPOINTS } from "./endpoints/index.ts";
import { GUIDES, QUICKSTART } from "./guides/index.ts";
import { PLANS } from "./pricing.ts";
import { TRUST_SECTIONS } from "./trust.ts";
import type { Availability, Block } from "./types.ts";

/** The section a hit belongs to. Shown beside every result: a bare title is ambiguous when "Errors" is both a
 *  guide and a table on four endpoint pages. */
export type SearchSection =
  | "Guide"
  | "API"
  | "Dataset"
  | "Pricing"
  | "Trust"
  | "Changelog"
  | "Tool";

export interface SearchDoc {
  readonly id: string;
  readonly title: string;
  readonly section: SearchSection;
  readonly href: string;
  /** One line under the title in the results list. */
  readonly summary: string;
  /** Lower-cased haystack: title + summary + body text. Never rendered — matched against only. */
  readonly body: string;
  readonly availability?: Availability;
}

export interface SearchHit extends SearchDoc {
  readonly score: number;
}

/** Flatten a prose page to plain text so body matches work. Tables and lists carry as much of the answer as
 *  the paragraphs do — the status-code table IS the errors guide — so every block kind contributes. */
function blockText(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "p":
        case "h2":
        case "note":
          return block.text;
        case "list":
          return block.items.join(" ");
        case "code":
          return block.source;
        case "table":
          return [...block.headers, ...block.rows.flat()].join(" ");
      }
    })
    .join(" ");
}

function doc(input: Omit<SearchDoc, "body"> & { readonly text: string }): SearchDoc {
  const { text, ...rest } = input;
  return {
    ...rest,
    body: `${rest.title} ${rest.summary} ${text}`.toLowerCase(),
  };
}

/**
 * The corpus.
 *
 * Order here is the tie-break order at equal score, so it runs in the order a reader should meet the site:
 * the quickstart, then the guides that unblock a first call, then the contract, then what you can buy.
 */
export const SEARCH_DOCS: readonly SearchDoc[] = [
  doc({
    id: "guide:quickstart",
    title: QUICKSTART.title,
    section: "Guide",
    href: "/docs",
    summary: QUICKSTART.summary,
    text: blockText(QUICKSTART.blocks),
  }),
  ...GUIDES.map((guide) =>
    doc({
      id: `guide:${guide.slug}`,
      title: guide.title,
      section: "Guide",
      href: `/docs/${guide.slug}`,
      summary: guide.summary,
      text: blockText(guide.blocks),
    }),
  ),
  ...ENDPOINTS.map((endpoint) =>
    doc({
      id: `api:${endpoint.slug}`,
      title: endpoint.title,
      section: "API",
      href: `/docs/api/${endpoint.slug}`,
      summary: endpoint.summary,
      availability: endpoint.availability,
      // The method and path are how developers refer to an endpoint out loud, and the params/returns/errors
      // tables are the reason they open the page at all: "domain", "linkedin_url", "confidence",
      // "rate_limited" each appear in exactly one of them.
      text: [
        endpoint.method,
        endpoint.path,
        endpoint.billing,
        ...endpoint.params.map((param) => `${param.name} ${param.type} ${param.description}`),
        ...endpoint.returns.map((field) => `${field.name} ${field.type} ${field.description}`),
        ...endpoint.errors.map((error) => `${error.status} ${error.code} ${error.meaning}`),
      ].join(" "),
    }),
  ),
  ...DATASETS.map((dataset) =>
    doc({
      id: `dataset:${dataset.slug}`,
      title: dataset.name,
      section: "Dataset",
      href: `/datasets/${dataset.slug}`,
      summary: dataset.summary,
      availability: dataset.availability,
      text: [
        dataset.coverage,
        dataset.refresh,
        ...dataset.fields.map((field) => `${field.name} ${field.type} ${field.description}`),
      ].join(" "),
    }),
  ),
  ...PLANS.map((plan) =>
    doc({
      id: `plan:${plan.slug}`,
      title: `${plan.name} plan`,
      section: "Pricing",
      href: "/pricing",
      summary: `${plan.price} · ${plan.credits}`,
      availability: plan.availability,
      text: [plan.cadence, plan.audience, ...plan.includes].join(" "),
    }),
  ),
  ...TRUST_SECTIONS.map((section) =>
    doc({
      id: `trust:${section.id}`,
      title: section.title,
      section: "Trust",
      // Trust sections carry their own id precisely so they can be linked to directly.
      href: `/trust#${section.id}`,
      summary: "Trust and compliance",
      text: blockText(section.blocks),
    }),
  ),
  ...CHANGELOG.map((entry) =>
    doc({
      id: `changelog:${entry.date}-${entry.title}`,
      title: entry.title,
      section: "Changelog",
      href: "/changelog",
      summary: entry.date,
      text: entry.body,
    }),
  ),
  // The two tool pages have no content module of their own — they ARE the tool. Indexed by hand so that
  // "playground", "try it", "sandbox", "llms.txt" and "openapi" reach them.
  doc({
    id: "tool:playground",
    title: "API playground",
    section: "Tool",
    href: "/docs/playground",
    summary: "Run a request against sandbox data without a key.",
    text: "playground try it sandbox simulator run request curl no key required idempotency replay credits",
  }),
  doc({
    id: "tool:machine-reference",
    title: "Machine reference",
    section: "Tool",
    href: "/docs/machine-reference",
    summary: "llms.txt and the OpenAPI 3.1 description.",
    text: "llms.txt openapi 3.1 schema machine readable agent llm context download spec json",
  }),
];

/** Query tokens: lower-cased, punctuation-split, deduplicated. `problem+json` and `429.` must find their
 *  pages, so anything that is not alphanumeric separates. */
function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    ),
  ];
}

/**
 * Score one document against one token.
 *
 * The weights encode what a short query usually means. Someone typing "search" wants the search ENDPOINT, not
 * the four other pages that mention searching, so a title hit outranks a body hit by an order of magnitude and
 * a title that STARTS with the token outranks one that merely contains it. Body hits still count, because the
 * long-tail queries — "bearer", "cursor", "suppression" — only ever appear in body text.
 */
function scoreToken(document_: SearchDoc, token: string): number {
  const title = document_.title.toLowerCase();
  if (title === token) return 100;
  if (title.startsWith(token)) return 60;
  if (title.includes(token)) return 40;
  if (document_.summary.toLowerCase().includes(token)) return 12;
  if (document_.body.includes(token)) return 4;
  return 0;
}

/**
 * Search the corpus.
 *
 * AND semantics across tokens: every token must appear somewhere in the document. "search person" should
 * return the two pages about searching for people, not every page containing either word — with a corpus this
 * small, OR returns almost everything and ranks it, which reads as "the search is broken".
 *
 * Returns [] for an empty or whitespace query rather than the whole corpus: an empty box means the reader has
 * not asked anything yet, and a list of everything is the least useful possible response to that.
 */
export function searchDocs(query: string, limit = 8): readonly SearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const document_ of SEARCH_DOCS) {
    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      const tokenScore = scoreToken(document_, token);
      if (tokenScore === 0) {
        matchedAll = false;
        break;
      }
      score += tokenScore;
    }
    if (matchedAll) hits.push({ ...document_, score });
  }

  // Stable by construction: equal scores keep corpus order, which is reading order (see SEARCH_DOCS).
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
