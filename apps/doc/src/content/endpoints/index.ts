// endpoints — the published API contract, in the order a reader should meet it: identify a company (free),
// enrich it, then find and enrich the people. Every page under /docs/api is generated from this list, so an
// endpoint added here gets a route, a sitemap entry and sidebar navigation with no further wiring.

import type { Endpoint } from "../types.ts";
import { COMPANY_ENRICH, COMPANY_MATCH } from "./company.ts";
import { PERSON_ENRICH } from "./person.ts";
import { SEARCH } from "./search.ts";

export const ENDPOINTS: readonly Endpoint[] = [
  COMPANY_MATCH,
  COMPANY_ENRICH,
  SEARCH,
  PERSON_ENRICH,
];

export function findEndpoint(slug: string): Endpoint | undefined {
  return ENDPOINTS.find((endpoint) => endpoint.slug === slug);
}
