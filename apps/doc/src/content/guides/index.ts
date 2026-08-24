// guides — the prose pages under /docs, in reading order.
//
// QUICKSTART is exported separately because it is the /docs index itself rather than a /docs/[slug] page;
// listing it in GUIDES too would generate a duplicate route at /docs/quickstart.

import type { Guide } from "../types.ts";
import { AUTHENTICATION } from "./authentication.ts";
import { CONFIDENCE } from "./confidence.ts";
import { ERRORS } from "./errors.ts";
import { PAGINATION } from "./pagination.ts";
import { QUICKSTART } from "./quickstart.ts";
import { VERSIONING } from "./versioning.ts";

export { QUICKSTART };

export const GUIDES: readonly Guide[] = [
  AUTHENTICATION,
  ERRORS,
  PAGINATION,
  CONFIDENCE,
  VERSIONING,
];

export function findGuide(slug: string): Guide | undefined {
  return GUIDES.find((guide) => guide.slug === slug);
}
