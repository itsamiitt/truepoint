// Public surface of @leadwolf/search — the SearchPort adapters (ADR-0002). All search goes through this
// seam; callers never embed engine-specific queries. Today: the in-memory dev/test adapter. The OpenSearch
// (global) + Typesense (overlay) adapters land here behind the same interface (ADR-0021, ADR-0035).
// The SearchPort interface + query/result types live in @leadwolf/types and are re-exported for convenience.

export { createInMemorySearchPort, type IndexedContact } from "./inMemorySearchPort.ts";
export type {
  SearchPort,
  SearchCtx,
  SearchPage,
  ContactHit,
  ContactQuery,
  FilterClause,
  TermFilter,
  RangeFilter,
  Suggestion,
  SuggestQuery,
  FacetCount,
  FacetKey,
} from "@leadwolf/types";
