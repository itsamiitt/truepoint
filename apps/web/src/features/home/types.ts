// types.ts — the home slice's view models. The cockpit shape is now a server contract: GET /home/summary
// returns HomeSummary (PII-safe — hotLeads carry facets only, the activity feed carries minimized columns).
// We re-export the inferred types from @leadwolf/types so the slice has one local import surface for them.
export type {
  ActivityFeedItem,
  BurnPoint,
  EnrichmentActivity,
  HomeSummary,
  HotLead,
  RecentImport,
  RecentReveal,
  SequenceSnapshot,
} from "@leadwolf/types";
