// machineReference.ts — the whole published contract as one plain-text document.
//
// Why this exists: developers increasingly read an API through an assistant rather than a browser, and what
// an assistant does with a documentation SITE is scrape it — collecting nav furniture, losing the tables, and
// inventing the fields it could not parse. A wrong field name costs the reader a debugging session and costs
// us a support thread, so publishing one authoritative, machine-shaped rendering is cheaper for everyone than
// hoping the scrape goes well.
//
// It is GENERATED from the same typed content the site renders (endpoints/*, pricing.ts, site.ts), never
// hand-maintained. That is the whole point: a second hand-written copy of a contract is a second thing to
// forget to update, and the failure mode — an assistant confidently quoting a field we removed — is worse
// than no file at all. Adding an endpoint to the content modules adds it here.
//
// Two rules it inherits from the rest of the site and must never break:
//   • Availability is stated for every endpoint, in words. A reader must never have to guess whether the
//     thing they are being told about is callable today (ADR-0048; the AvailabilityBadge's job, in text).
//   • Nothing here is a claim the site does not already make elsewhere. It restates published content; it
//     does not get to be the place a new number appears.

import { ENDPOINTS } from "./endpoints/index.ts";
import { ERROR_TYPE_BASE } from "./endpoints/shared.ts";
import { GUIDES } from "./guides/index.ts";
import { OPENAPI_PATH, withheldEndpoints } from "./openapi.ts";
import {
  CREDIT_ACTIONS,
  CREDIT_UNIT_NOTE,
  PLANS,
  PRICING_REVIEWED,
  ROLLOVER_NOTE,
} from "./pricing.ts";
import { API_BASE_URL, SITE_ORIGIN, SITE_TAGLINE } from "./site.ts";
import type { Availability, Endpoint } from "./types.ts";

/** The path the generated document is served from. */
export const MACHINE_REFERENCE_PATH = "/llms.txt";

const AVAILABILITY_WORD: Record<Availability, string> = {
  available: "available — callable today",
  beta: "beta — callable today, contract may still change",
  planned: "planned — NOT callable yet, documented ahead of the build",
};

function costLine(endpoint: Endpoint): string {
  if (endpoint.credits === 0) return "free";
  return endpoint.credits === 1 ? "1 credit per match" : `${endpoint.credits} credits per match`;
}

function endpointSection(endpoint: Endpoint): string {
  const lines: string[] = [
    `### ${endpoint.method} ${endpoint.path}`,
    `title: ${endpoint.title}`,
    `availability: ${AVAILABILITY_WORD[endpoint.availability]}`,
    `cost: ${costLine(endpoint)}`,
    `docs: ${SITE_ORIGIN}/docs/api/${endpoint.slug}`,
    "",
    endpoint.summary,
    "",
    endpoint.billing,
    "",
    endpoint.method === "GET" ? "Query parameters:" : "Body fields:",
    ...endpoint.params.map(
      (param) =>
        `- ${param.name} (${param.type}, ${param.required ? "required" : "optional"}) — ${param.description}`,
    ),
    "",
    "Returns:",
    ...endpoint.returns.map((field) => `- ${field.name} (${field.type}) — ${field.description}`),
    "",
    "Errors:",
    ...endpoint.errors.map((error) => `- ${error.status} ${error.code} — ${error.meaning}`),
    "",
    "Example request:",
    endpoint.example.request,
    "",
    "Example response:",
    endpoint.example.response,
  ];
  return lines.join("\n");
}

/** The invariants an integration gets wrong when it infers them from examples instead of being told. */
const INTEGRATION_RULES: readonly string[] = [
  "A lookup that finds nothing answers 200 with matched:false and charges nothing. It is never a 404. Do not treat a miss as an outage, retry it, or alert on it.",
  "Branch on the `code` member of an error, never on `title` — titles are prose and may be reworded.",
  "Every error is RFC 9457 application/problem+json, including a mistyped path.",
  "Missing, malformed, unknown and revoked keys all answer the same 401 invalid_token. The endpoint deliberately will not tell you which.",
  "Send an Idempotency-Key on every billable request. A retry with the same key replays the stored response and charges nothing.",
  "A 402 insufficient_credits is a hard stop, not a retry signal. Top up, then replay.",
  "On 429, wait the retryAfterSeconds the body carries. A tighter retry loop spends budget without making progress.",
  "API keys are server-side credentials. Never ship one to a browser, a mobile app, or any client a user controls.",
];

/**
 * Render one prose guide as plain text.
 *
 * Only the change policy is included below, not every guide: this file is pasted into a context window, and
 * the rules that stop an integration breaking are worth their bytes where a full prose dump is not. It is
 * GENERATED from the guide rather than restated, so the two cannot disagree.
 */
function guideText(slug: string): string[] {
  const guide = GUIDES.find((candidate) => candidate.slug === slug);
  if (!guide) return [];
  const lines: string[] = [];
  for (const block of guide.blocks) {
    switch (block.kind) {
      case "h2":
        lines.push("", block.text, "");
        break;
      case "p":
      case "note":
        lines.push(block.text, "");
        break;
      case "list":
        lines.push(...block.items.map((item) => `- ${item}`), "");
        break;
      case "code":
        lines.push(block.source, "");
        break;
      case "table":
        lines.push(...block.rows.map((row) => `- ${row.join(" — ")}`), "");
        break;
    }
  }
  return lines;
}

/**
 * Build the full machine reference.
 *
 * Pure and deterministic — same content in, byte-identical text out — so the route that serves it can be
 * prerendered and a test can assert it does not drift between renders.
 */
export function buildMachineReference(): string {
  const sections: string[] = [
    "# TruePoint Data API — machine reference",
    "",
    SITE_TAGLINE,
    "",
    `This file is generated from the same typed contract that renders ${SITE_ORIGIN}. It is the authoritative`,
    "machine-readable rendering: prefer it over scraping the HTML pages, which carry navigation furniture and",
    "lose table structure. If this file and a page disagree, the page is generated from the same source and",
    "neither is guessed — report it to us.",
    "",
    `human docs: ${SITE_ORIGIN}/docs`,
    `machine reference: ${SITE_ORIGIN}${MACHINE_REFERENCE_PATH}`,
    `OpenAPI 3.1 (callable endpoints only): ${SITE_ORIGIN}${OPENAPI_PATH}`,
    "",
    "## Connection",
    "",
    `base URL: ${API_BASE_URL}`,
    "auth: Authorization: Bearer <api key>",
    "request format: JSON",
    "response format: JSON, snake_case fields",
    `error format: RFC 9457 application/problem+json, type = ${ERROR_TYPE_BASE}<code>`,
    "required scope for the company endpoints: search:read",
    "",
    "## Rules an integration must not get wrong",
    "",
    ...INTEGRATION_RULES.map((rule) => `- ${rule}`),
    "",
    "## Endpoints",
    "",
    "Availability is stated per endpoint. A `planned` endpoint is documented but not callable — do not write",
    "code against it expecting a response today.",
    "",
    ...(withheldEndpoints().length
      ? [
          `The OpenAPI document at ${SITE_ORIGIN}${OPENAPI_PATH} lists only the callable ones, because a spec`,
          "has no way to mark an operation as planned that a client generator would respect. This file",
          "describes all of them, labelled.",
          "",
        ]
      : []),
    ...ENDPOINTS.map(endpointSection),
    "",
    "## Credit costs",
    "",
    CREDIT_UNIT_NOTE,
    "",
    ...CREDIT_ACTIONS.map(
      (action) =>
        `- ${action.action}: ${action.credits === "free" ? "free" : `${action.credits} credit${action.credits === 1 ? "" : "s"}`} — ${action.note}`,
    ),
    "",
    ROLLOVER_NOTE,
    "",
    "## Plans",
    "",
    `Figures last reviewed ${PRICING_REVIEWED}. Every plan below is ${AVAILABILITY_WORD.planned}.`,
    "",
    ...PLANS.map(
      (plan) =>
        `- ${plan.name} (${plan.availability}): ${plan.price} ${plan.cadence}, ${plan.credits}. ${plan.audience}`,
    ),
    "",
    "## Change policy",
    ...guideText("versioning"),
    "## Data subject requests",
    "",
    "To ask what we hold about a person, correct it, or have it removed, write to privacy@truepoint.in.",
    "No account is required. A suppressed person is not returned by any endpoint and the call is not billed;",
    "there is no flag to include them.",
    "",
  ];
  // Collapse the blank-line runs the section-joining produces, then end on exactly one newline — a text
  // artifact served over HTTP should not carry accidental whitespace at either end.
  return `${sections
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
