// types.ts — the Captures slice's view model. Mirrors the forge-api `/bff/captures` payload; the console owns
// no schema of record.

export interface Capture {
  id: string;
  source: string;
  sourceUrl?: string | null;
  parser?: string | null;
  status: string;
  capturedAt: string;
}

export interface CapturesResponse {
  captures: Capture[];
}
