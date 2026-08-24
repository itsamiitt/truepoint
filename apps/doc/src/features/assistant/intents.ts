// intents.ts — what the support assistant can answer, and where each answer comes from.
//
// Every answer is COMPOSED FROM the content modules rather than written here. That is the whole design of
// this feature: an assistant that restates the docs in its own words is a second copy of the documentation,
// and a second copy drifts — quietly, and in the direction of whatever was true the day someone typed it.
// The credit rule below is `CREDIT_ACTIONS`; the error list is `COMMON_ERRORS`; the access caveat is
// `ACCESS_NOTE`. Correct one of those files and the assistant is corrected with it.
//
// It is also why there is no model call. The design prototype called one, with a canned fallback. A model
// needs `connect-src` beyond 'self' (asserted in scripts/verify.mjs), and this site is force-static and
// zero-env by ADR-0048 §D2 — but the deciding reason is that a model would be the one surface here allowed
// to say something the content modules do not. Retrieval over typed content cannot invent an endpoint.

import { ACCESS_NOTE } from "../../content/access.ts";
import { endpointStatus } from "../../content/endpointStatus.ts";
import { COMPANY_ENRICH } from "../../content/endpoints/company.ts";
import { PERSON_ENRICH } from "../../content/endpoints/person.ts";
import { SEARCH } from "../../content/endpoints/search.ts";
import { COMMON_ERRORS, NO_MATCH_NOTE, SUPPRESSION_NOTE } from "../../content/endpoints/shared.ts";
import { CREDIT_ACTIONS } from "../../content/pricing.ts";
import { API_BASE_URL } from "../../content/site.ts";

export interface Intent {
  readonly id: string;
  /** Lower-case substrings. A question matching any one of them routes here. */
  readonly keywords: readonly string[];
  readonly answer: string;
  /** The page this answer is drawn from, offered as the place to read the whole of it. */
  readonly href: string;
  readonly hrefLabel: string;
}

const action = (name: string) => CREDIT_ACTIONS.find((entry) => entry.action === name);

const MATCH_COST = action("Company identification / match");
const ENRICH_COST = action("Company enrichment (full record)");

const ERROR_LIST = COMMON_ERRORS.map((error) => `${error.status} ${error.code}`).join(", ");

const COMPANY_FIELDS = COMPANY_ENRICH.returns
  .map((field) => field.name)
  .filter((name) => name.startsWith("company."))
  .map((name) => name.replace("company.", ""))
  .join(", ");

/** Ordered: the first intent whose keywords appear in the question wins, so the specific ones come before
 *  the general ones. "What does a person lookup cost" is about people, not about the credit table. */
export const INTENTS: readonly Intent[] = [
  {
    id: "people",
    keywords: ["contact", "person", "people", "email address", "phone", "prospect"],
    answer: `${PERSON_ENRICH.title} is published contract, not a running service — it is marked planned, and so is ${SEARCH.title}. ${SUPPRESSION_NOTE}`,
    href: `/docs/api/${PERSON_ENRICH.slug}`,
    hrefLabel: PERSON_ENRICH.title,
  },
  {
    id: "search",
    keywords: ["search", "find companies", "query"],
    answer: `${SEARCH.summary} It is marked planned: the contract is published, the endpoint is not callable yet.`,
    href: `/docs/api/${SEARCH.slug}`,
    hrefLabel: SEARCH.title,
  },
  {
    id: "credits",
    keywords: ["credit", "cost", "price", "pricing", "bill", "charge", "spend", "invoice"],
    answer: `${MATCH_COST?.note ?? ""} ${ENRICH_COST ? `Company enrichment costs ${ENRICH_COST.credits} credit for the full record.` : ""} ${NO_MATCH_NOTE}`,
    href: "/pricing",
    hrefLabel: "Pricing",
  },
  {
    id: "idempotency",
    keywords: ["idempot", "retry", "duplicate", "double charge", "timeout", "replay"],
    answer: COMPANY_ENRICH.billing,
    href: `/docs/api/${COMPANY_ENRICH.slug}`,
    hrefLabel: COMPANY_ENRICH.title,
  },
  {
    id: "errors",
    keywords: [
      "error",
      "problem",
      "status code",
      "401",
      "402",
      "403",
      "422",
      "429",
      "500",
      "rate limit",
      "throttl",
    ],
    answer: `Every failure is an RFC 9457 problem+json document — branch on its \`code\`, never on its title. The vocabulary is ${ERROR_LIST}. ${NO_MATCH_NOTE}`,
    href: "/docs/errors",
    hrefLabel: "Errors",
  },
  {
    id: "auth",
    keywords: ["auth", "api key", "token", "bearer", "scope", "credential", "header"],
    answer:
      "Authenticate with a bearer key on every request. Missing, malformed, unknown and revoked keys all answer 401 invalid_token identically, on purpose — the endpoint must not confirm which keys exist. A key that is valid but lacks the scope an endpoint requires answers 403 insufficient_scope.",
    href: "/docs/authentication",
    hrefLabel: "Authentication",
  },
  {
    id: "fields",
    keywords: ["field", "schema", "response shape", "company object", "revenue", "headcount"],
    answer: `The company record returns ${COMPANY_FIELDS}. Nullable means we hold nothing for that record. Revenue is a band rather than a figure — an exact number would imply a precision the data does not have.`,
    href: `/docs/api/${COMPANY_ENRICH.slug}`,
    hrefLabel: COMPANY_ENRICH.title,
  },
  {
    id: "access",
    keywords: [
      "404",
      "not working",
      "enabled",
      "access",
      "callable",
      "live",
      "get started",
      "sandbox",
    ],
    answer: `${endpointStatus().line} ${ACCESS_NOTE}`,
    href: "/docs",
    hrefLabel: "Quickstart",
  },
  {
    id: "provenance",
    keywords: ["provenance", "confidence", "fresh", "stale", "source", "how do you know"],
    answer:
      "Each field's freshness is what you judge staleness against — the company record carries last_updated for exactly that. The wider per-field provenance model is documented, but no callable endpoint returns a field_provenance block yet.",
    href: "/docs/confidence",
    hrefLabel: "Confidence and provenance",
  },
  {
    id: "playground",
    keywords: ["playground", "try", "test", "simulate", "without a key"],
    answer:
      "The playground runs both company endpoints against sandbox records — real status codes, real bodies, credits drawing down, and idempotency replay if you resend with the same key. No API key required, and nothing leaves the browser.",
    href: "/docs/playground",
    hrefLabel: "API playground",
  },
  {
    id: "machine",
    keywords: ["llm", "agent", "openapi", "llms.txt", "cursor", "claude", "machine", "spec"],
    answer:
      "The machine reference publishes the whole surface twice: llms.txt as a paste-ready block for a coding agent, and an OpenAPI 3.1 description for tooling. Both list which endpoints are planned rather than callable, so an agent stops inventing the ones that do not exist.",
    href: "/docs/machine-reference",
    hrefLabel: "Machine reference",
  },
  {
    id: "base-url",
    keywords: ["base url", "host", "endpoint list", "what endpoints", "domain to call"],
    answer: `The base URL is ${API_BASE_URL}. ${endpointStatus().line}`,
    href: "/docs",
    hrefLabel: "Quickstart",
  },
];
