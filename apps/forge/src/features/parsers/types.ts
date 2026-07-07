// types.ts — the Parsers slice's view model. Mirrors the forge-api `/bff/parsers` payload; the console owns no
// schema of record.

export interface Parser {
  id: string;
  name: string;
  kind: string;
  status: string;
  /** Success rate over the recent window, 0–1. */
  successRate: number;
  lastRunAt: string | null;
}

export interface ParsersResponse {
  parsers: Parser[];
}
