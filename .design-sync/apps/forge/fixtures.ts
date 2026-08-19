// fixtures.ts — the operator-console data every Forge card renders.
//
// Shapes mirror apps/forge/src/features/*/types.ts exactly (which themselves mirror the forge-api /bff
// payloads), so the REAL components render real-looking state without a network. Content is deliberately
// plausible operator data — parser names, capture sources, sync destinations — never foo/bar: these cards
// are browsed by humans and imitated by the design agent.
//
// PII posture: the source-fetch registry holds URLs and outcomes only, and these fixtures keep that
// property — no names, no emails. The LinkedIn URLs below are illustrative slugs, not real profiles.

import type { Capture } from "../../../apps/forge/src/features/captures/types";
import type { OverviewSummary } from "../../../apps/forge/src/features/overview/types";
import type { Parser } from "../../../apps/forge/src/features/parsers/types";
import type { ReviewTask } from "../../../apps/forge/src/features/review/types";
import type { SourceFetch } from "../../../apps/forge/src/features/source-fetches/types";
import type { SyncTarget } from "../../../apps/forge/src/features/sync-status/types";

// Fixed timestamps: a card that re-renders "3 minutes ago" differently on every capture would churn the
// render hashes and clear its own grade on every sync.
const T = (iso: string) => iso;

export const CAPTURES: Capture[] = [
  { id: "cap_01hq8m4", source: "extension:linkedin", sourceUrl: "https://www.linkedin.com/in/priya-raghavan-cto", parser: "linkedin-profile-v4", status: "parsed", capturedAt: T("2026-08-18T09:14:22Z") },
  { id: "cap_01hq8m5", source: "extension:linkedin", sourceUrl: "https://www.linkedin.com/in/daniel-okafor", parser: "linkedin-profile-v4", status: "parsed", capturedAt: T("2026-08-18T09:11:05Z") },
  { id: "cap_01hq8m6", source: "extension:sales-navigator", sourceUrl: "https://www.linkedin.com/sales/lead/ACwAAB1", parser: "sales-nav-lead-v2", status: "review", capturedAt: T("2026-08-18T08:58:41Z") },
  { id: "cap_01hq8m7", source: "import:csv", sourceUrl: null, parser: "csv-contacts-v1", status: "parsed", capturedAt: T("2026-08-18T08:41:19Z") },
  { id: "cap_01hq8m8", source: "extension:company", sourceUrl: "https://www.linkedin.com/company/northwind-logistics", parser: "company-profile-v3", status: "parsed", capturedAt: T("2026-08-18T08:30:57Z") },
  { id: "cap_01hq8m9", source: "extension:linkedin", sourceUrl: "https://www.linkedin.com/in/marta-svensson", parser: null, status: "failed", capturedAt: T("2026-08-18T08:22:03Z") },
  { id: "cap_01hq8ma", source: "extension:sales-navigator", sourceUrl: "https://www.linkedin.com/sales/lead/ACwAAB7", parser: "sales-nav-lead-v2", status: "review", capturedAt: T("2026-08-18T08:03:48Z") },
  { id: "cap_01hq8mb", source: "import:csv", sourceUrl: null, parser: "csv-contacts-v1", status: "parsed", capturedAt: T("2026-08-18T07:52:12Z") },
];

export const PARSERS: Parser[] = [
  { id: "prs_linkedin_profile", name: "linkedin-profile-v4", kind: "profile", status: "active", successRate: 0.974, lastRunAt: T("2026-08-18T09:14:22Z") },
  { id: "prs_sales_nav_lead", name: "sales-nav-lead-v2", kind: "lead", status: "active", successRate: 0.912, lastRunAt: T("2026-08-18T09:03:48Z") },
  { id: "prs_company_profile", name: "company-profile-v3", kind: "company", status: "active", successRate: 0.958, lastRunAt: T("2026-08-18T08:30:57Z") },
  { id: "prs_csv_contacts", name: "csv-contacts-v1", kind: "import", status: "active", successRate: 0.999, lastRunAt: T("2026-08-18T08:41:19Z") },
  { id: "prs_linkedin_profile_v3", name: "linkedin-profile-v3", kind: "profile", status: "retired", successRate: 0.881, lastRunAt: T("2026-07-29T16:20:00Z") },
  { id: "prs_company_about", name: "company-about-v1", kind: "company", status: "degraded", successRate: 0.634, lastRunAt: T("2026-08-18T06:44:10Z") },
];

export const REVIEW_TASKS: ReviewTask[] = [
  { id: "rvw_01hq91a", captureId: "cap_01hq8m6", reason: "Ambiguous title — two roles listed as current", priority: "high", assignedTo: "ops@truepoint.in", createdAt: T("2026-08-18T08:59:02Z") },
  { id: "rvw_01hq91b", captureId: "cap_01hq8ma", reason: "Company name did not resolve to a known account", priority: "medium", assignedTo: null, createdAt: T("2026-08-18T08:04:11Z") },
  { id: "rvw_01hq91c", captureId: "cap_01hq8m9", reason: "Parser returned no fields — page layout changed", priority: "high", assignedTo: null, createdAt: T("2026-08-18T08:22:30Z") },
  { id: "rvw_01hq91d", captureId: "cap_01hq8kk", reason: "Conflicting seniority signal between headline and role", priority: "low", assignedTo: "ops@truepoint.in", createdAt: T("2026-08-17T19:12:44Z") },
];

export const SOURCE_FETCHES: SourceFetch[] = [
  { id: "sf_01hq7a1", entityKind: "person", normalizedUrl: "linkedin.com/in/priya-raghavan-cto", externalId: "ACwAAB1xQ", firstSeenAt: T("2026-07-02T11:04:00Z"), lastFetchedAt: T("2026-08-18T09:14:22Z"), lastOutcome: "ok", fetchCount: 6, resolved: true },
  { id: "sf_01hq7a2", entityKind: "person", normalizedUrl: "linkedin.com/in/daniel-okafor", externalId: "ACwAAB2rT", firstSeenAt: T("2026-07-14T08:20:00Z"), lastFetchedAt: T("2026-08-18T09:11:05Z"), lastOutcome: "ok", fetchCount: 3, resolved: true },
  { id: "sf_01hq7a3", entityKind: "company", normalizedUrl: "linkedin.com/company/northwind-logistics", externalId: "12849302", firstSeenAt: T("2026-06-28T15:41:00Z"), lastFetchedAt: T("2026-08-18T08:30:57Z"), lastOutcome: "ok", fetchCount: 11, resolved: true },
  { id: "sf_01hq7a4", entityKind: "person", normalizedUrl: "linkedin.com/in/marta-svensson", externalId: null, firstSeenAt: T("2026-08-18T08:22:03Z"), lastFetchedAt: T("2026-08-18T08:22:03Z"), lastOutcome: "rejected", fetchCount: 1, resolved: false },
  { id: "sf_01hq7a5", entityKind: "company", normalizedUrl: "linkedin.com/company/halcyon-medtech", externalId: "9982114", firstSeenAt: T("2026-08-11T10:02:00Z"), lastFetchedAt: null, lastOutcome: null, fetchCount: 0, resolved: false },
  { id: "sf_01hq7a6", entityKind: "person", normalizedUrl: "linkedin.com/in/aisha-khan-revops", externalId: "ACwAAB9pL", firstSeenAt: T("2026-08-02T13:37:00Z"), lastFetchedAt: T("2026-08-17T22:15:09Z"), lastOutcome: "unavailable", fetchCount: 4, resolved: false },
];

export const SYNC_TARGETS: SyncTarget[] = [
  { id: "syn_master_graph", destination: "master-graph", status: "healthy", pending: 0, lastSyncedAt: T("2026-08-18T09:15:00Z") },
  { id: "syn_search_index", destination: "search-index", status: "healthy", pending: 42, lastSyncedAt: T("2026-08-18T09:12:30Z") },
  { id: "syn_provenance", destination: "field-provenance", status: "healthy", pending: 7, lastSyncedAt: T("2026-08-18T09:14:10Z") },
  { id: "syn_verification", destination: "verification-queue", status: "degraded", pending: 1284, lastSyncedAt: T("2026-08-18T07:41:52Z") },
  { id: "syn_warehouse", destination: "analytics-warehouse", status: "paused", pending: 3910, lastSyncedAt: T("2026-08-16T02:00:00Z") },
];

export const OVERVIEW: OverviewSummary = {
  capturesToday: 1_284,
  pendingReview: REVIEW_TASKS.length,
  activeParsers: PARSERS.filter((p) => p.status === "active").length,
  syncBacklog: SYNC_TARGETS.reduce((n, t) => n + t.pending, 0),
  recentCaptures: CAPTURES.slice(0, 5).map(({ id, source, status, capturedAt }) => ({ id, source, status, capturedAt })),
};
