// types.ts — the Source fetches slice's view model. Mirrors the forge-api `/bff/source-fetches` payload;
// the console owns no schema of record. URLs + outcomes only — the registry holds no PII.

export interface SourceFetch {
  id: string;
  entityKind: "person" | "company";
  normalizedUrl: string;
  externalId: string | null;
  firstSeenAt: string;
  lastFetchedAt: string | null;
  /** ok | rejected | unavailable — null until the first fetch attempt. */
  lastOutcome: string | null;
  fetchCount: number;
  /** Whether the fetch resolved a golden person/company. */
  resolved: boolean;
}

export interface SourceFetchesResponse {
  fetches: SourceFetch[];
}
