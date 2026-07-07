// types.ts — the Overview slice's view model. Shapes the forge-api `/bff/overview` payload the console renders;
// the console owns no schema of record — these mirror the BFF response.

export interface OverviewCapture {
  id: string;
  source: string;
  status: string;
  capturedAt: string;
}

export interface OverviewSummary {
  capturesToday: number;
  pendingReview: number;
  activeParsers: number;
  syncBacklog: number;
  recentCaptures: OverviewCapture[];
}
