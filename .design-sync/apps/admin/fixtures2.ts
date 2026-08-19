// fixtures2.ts — the second half of the staff-console fixture set.
//
// Split from fixtures.ts purely for size: the console reads ~30 distinct /admin routes and one file holding
// all of them is unreadable. Shapes mirror apps/admin/src/features/*/types.ts and the zod schemas in
// @leadwolf/types exactly, so the REAL components render populated state.
//
// PII posture, restated because this is the file where it matters most: every person and company here is
// invented. The console is the surface staff use to look AT customers, so its fixtures are the one place it
// would be easy to paste something real. Don't.

import type { EconomicsSummary, EconomicsTrendPoint, LowBalanceTenant, TenantEconomicsRow } from "../../../apps/admin/src/features/billing/types";
import type { DsarRequest, GlobalSuppression, RetentionPolicy as ComplianceRetentionPolicy, SubProcessor } from "../../../apps/admin/src/features/compliance/types";
import type { Announcement } from "../../../apps/admin/src/features/content/types";
import type { StaffCrmConnection, StaffCrmDeadLetter } from "../../../apps/admin/src/features/crm-sync/types";
import type { DataOpsOverview, DataImportDetail, EnrichmentRunRow, FleetQualityRow, VerificationRunRow } from "../../../apps/admin/src/features/data-ops/types";
import type { DataQuality } from "../../../apps/admin/src/features/data-quality/types";
import type { DataSourceOriginView } from "../../../apps/admin/src/features/data-sources/types";
import type { ExtensionMeta } from "../../../apps/admin/src/features/extension/types";
import type { PlanTemplate } from "../../../apps/admin/src/features/plans/types";
import type { CreditPack } from "../../../apps/admin/src/features/pricing/types";
import type { ProviderConfigView } from "../../../apps/admin/src/features/provider-configs/types";
import type { RetentionRunRow } from "../../../apps/admin/src/features/retention/types";

const TENANT_A = "00000000-0000-4000-8000-000000000101";
const TENANT_B = "00000000-0000-4000-8000-000000000102";
const TENANT_E = "00000000-0000-4000-8000-000000000105";
const WORKSPACE_A = "00000000-0000-4000-8000-000000000201";

// ── billing ─────────────────────────────────────────────────────────────────────────────────────────────
export const ECONOMICS: EconomicsSummary = {
  sinceDays: 30,
  creditsSold: 184_000,
  revenueCents: 4_412_000,
  refundedCents: 68_000,
  creditsConsumed: 141_882,
  reveals: 141_882,
  chargedReveals: 128_004,
  providerSpendCents: 1_602_400,
  costPerRevealCents: 13,
  marginCents: 2_741_600,
};

export const ECONOMICS_BY_TENANT: TenantEconomicsRow[] = [
  { tenantId: TENANT_E, tenantName: "Ironbridge Group", revenueCents: 1_980_000, creditsSold: 82_000, reveals: 61_402, chargedReveals: 55_881, providerSpendCents: 712_000, marginCents: 1_268_000 },
  { tenantId: TENANT_A, tenantName: "Northwind Logistics", revenueCents: 1_440_000, creditsSold: 60_000, reveals: 48_119, chargedReveals: 43_002, providerSpendCents: 548_800, marginCents: 891_200 },
  { tenantId: TENANT_B, tenantName: "Halcyon MedTech", revenueCents: 612_000, creditsSold: 25_500, reveals: 21_004, chargedReveals: 19_110, providerSpendCents: 241_600, marginCents: 370_400 },
  { tenantId: "00000000-0000-4000-8000-000000000104", tenantName: "Beacon Analytics", revenueCents: 380_000, creditsSold: 16_500, reveals: 11_357, chargedReveals: 10_011, providerSpendCents: 100_000, marginCents: 280_000 },
];

/** A 14-day series — enough for the trend chart to have a real shape, with a visible weekend dip. */
export const ECONOMICS_TREND: EconomicsTrendPoint[] = [
  { day: "2026-08-05", revenueCents: 141_000, reveals: 4_812, creditsConsumed: 4_812 },
  { day: "2026-08-06", revenueCents: 158_200, reveals: 5_144, creditsConsumed: 5_144 },
  { day: "2026-08-07", revenueCents: 149_800, reveals: 4_990, creditsConsumed: 4_990 },
  { day: "2026-08-08", revenueCents: 132_400, reveals: 4_401, creditsConsumed: 4_401 },
  { day: "2026-08-09", revenueCents: 61_200, reveals: 2_008, creditsConsumed: 2_008 },
  { day: "2026-08-10", revenueCents: 54_800, reveals: 1_784, creditsConsumed: 1_784 },
  { day: "2026-08-11", revenueCents: 168_400, reveals: 5_602, creditsConsumed: 5_602 },
  { day: "2026-08-12", revenueCents: 172_900, reveals: 5_744, creditsConsumed: 5_744 },
  { day: "2026-08-13", revenueCents: 166_100, reveals: 5_512, creditsConsumed: 5_512 },
  { day: "2026-08-14", revenueCents: 159_300, reveals: 5_308, creditsConsumed: 5_308 },
  { day: "2026-08-15", revenueCents: 144_700, reveals: 4_802, creditsConsumed: 4_802 },
  { day: "2026-08-16", revenueCents: 66_500, reveals: 2_190, creditsConsumed: 2_190 },
  { day: "2026-08-17", revenueCents: 58_900, reveals: 1_902, creditsConsumed: 1_902 },
  { day: "2026-08-18", revenueCents: 178_300, reveals: 5_908, creditsConsumed: 5_908 },
];

export const LOW_BALANCE: LowBalanceTenant[] = [
  { tenantId: "00000000-0000-4000-8000-000000000104", tenantName: "Beacon Analytics", plan: "community", revealCreditBalance: 42 },
  { tenantId: "00000000-0000-4000-8000-000000000107", tenantName: "Ardent Robotics", plan: "pro", revealCreditBalance: 88 },
];

// ── compliance ──────────────────────────────────────────────────────────────────────────────────────────
export const DSARS: DsarRequest[] = [
  { id: "dsar_01hq88", requestType: "access", status: "completed", requestedAt: "2026-08-11T09:20:00Z", verifiedAt: "2026-08-11T10:02:00Z", completedAt: "2026-08-17T17:40:00Z" },
  { id: "dsar_01hq89", requestType: "erasure", status: "in_progress", requestedAt: "2026-08-16T14:12:00Z", verifiedAt: "2026-08-16T15:00:00Z", completedAt: null },
  { id: "dsar_01hq8a", requestType: "access", status: "awaiting_verification", requestedAt: "2026-08-18T08:31:00Z", verifiedAt: null, completedAt: null },
  { id: "dsar_01hq8b", requestType: "rectification", status: "completed", requestedAt: "2026-07-29T11:05:00Z", verifiedAt: "2026-07-29T12:14:00Z", completedAt: "2026-08-02T09:48:00Z" },
];

export const SUPPRESSIONS: GlobalSuppression[] = [
  { id: "sup_01hq70", matchType: "domain", domain: "example-competitor.com", reason: "Competitor — standing request", createdAt: "2026-03-14T10:00:00Z" },
  { id: "sup_01hq71", matchType: "domain", domain: "no-contact.example", reason: "Opt-out received via DPO", createdAt: "2026-06-02T15:41:00Z" },
  { id: "sup_01hq72", matchType: "domain", domain: "school.example.edu", reason: "Education domain — policy", createdAt: "2026-07-19T08:22:00Z" },
];

export const COMPLIANCE_RETENTION: ComplianceRetentionPolicy[] = [
  { id: "ret_01hq60", entity: "contact", field: null, retentionDays: 1095, reason: "Contract term + 1 year", active: true, updatedAt: "2026-05-02T09:00:00Z" },
  { id: "ret_01hq61", entity: "activity", field: null, retentionDays: 365, reason: "Operational need only", active: true, updatedAt: "2026-05-02T09:00:00Z" },
  { id: "ret_01hq62", entity: "raw_capture", field: null, retentionDays: 90, reason: "Source document — minimise", active: true, updatedAt: "2026-06-21T13:30:00Z" },
  { id: "ret_01hq63", entity: "audit_log", field: null, retentionDays: 2555, reason: "SOC 2 evidence window", active: false, updatedAt: "2026-02-10T11:11:00Z" },
];

export const SUB_PROCESSORS: SubProcessor[] = [
  { id: "sp_01", name: "Amazon Web Services", purpose: "Hosting and object storage", location: "Ireland (eu-west-1)", dpaUrl: "https://aws.amazon.com/service-terms/", active: true, sortOrder: 1, updatedAt: "2026-01-08T09:00:00Z" },
  { id: "sp_02", name: "Neon", purpose: "Managed Postgres", location: "Ireland", dpaUrl: null, active: true, sortOrder: 2, updatedAt: "2026-01-08T09:00:00Z" },
  { id: "sp_03", name: "SMTP2GO", purpose: "Transactional email delivery", location: "United States", dpaUrl: "https://www.smtp2go.com/dpa/", active: true, sortOrder: 3, updatedAt: "2026-04-19T14:20:00Z" },
  { id: "sp_04", name: "Cloudflare", purpose: "CDN, WAF and bot mitigation", location: "Global", dpaUrl: "https://www.cloudflare.com/cloudflare-customer-dpa/", active: true, sortOrder: 4, updatedAt: "2026-01-08T09:00:00Z" },
  { id: "sp_05", name: "Legacy Mailer", purpose: "Transactional email (retired)", location: "United States", dpaUrl: null, active: false, sortOrder: 9, updatedAt: "2025-11-30T16:45:00Z" },
];

// ── content ─────────────────────────────────────────────────────────────────────────────────────────────
export const ANNOUNCEMENTS: Announcement[] = [
  { id: "ann_01", title: "Scheduled maintenance — 24 Aug, 02:00–03:00 UTC", body: "Search may be briefly unavailable while we roll out an index upgrade. Reveals and imports are unaffected.", level: "info", type: "banner", audience: "all", tenantTarget: null, startsAt: "2026-08-20T00:00:00Z", endsAt: "2026-08-24T04:00:00Z", active: true, createdAt: "2026-08-18T09:00:00Z", updatedAt: "2026-08-18T09:00:00Z" },
  { id: "ann_02", title: "Job-change alerts are now on for every workspace", body: "Saved contacts are checked weekly and flagged when someone appears to have moved on.", level: "success", type: "banner", audience: "all", tenantTarget: null, startsAt: "2026-08-04T00:00:00Z", endsAt: null, active: true, createdAt: "2026-08-04T10:30:00Z", updatedAt: "2026-08-04T10:30:00Z" },
  { id: "ann_03", title: "Your plan renews on 1 September", body: "No action needed. Seat changes made before then are prorated.", level: "warning", type: "modal", audience: "tenant", tenantTarget: TENANT_A, startsAt: "2026-08-25T00:00:00Z", endsAt: "2026-09-01T00:00:00Z", active: false, createdAt: "2026-08-12T16:00:00Z", updatedAt: "2026-08-15T11:20:00Z" },
];

// ── crm-sync ────────────────────────────────────────────────────────────────────────────────────────────
export const CRM_CONNECTIONS: StaffCrmConnection[] = [
  { id: "crm_01", tenantId: TENANT_A, workspaceId: WORKSPACE_A, provider: "hubspot", status: "connected", syncMode: "two_way", environment: "production", externalAccountId: "24810394", lastError: null, lastRefreshAt: "2026-08-18T08:00:00Z", tokenExpiresAt: "2026-08-18T14:00:00Z", nextPollAt: "2026-08-18T09:30:00Z", connectedAt: "2026-04-02T11:20:00Z" },
  { id: "crm_02", tenantId: TENANT_E, workspaceId: "00000000-0000-4000-8000-000000000210", provider: "salesforce", status: "connected", syncMode: "push_only", environment: "production", externalAccountId: "00D5g000004ABCD", lastError: null, lastRefreshAt: "2026-08-18T07:45:00Z", tokenExpiresAt: "2026-08-18T15:45:00Z", nextPollAt: "2026-08-18T09:45:00Z", connectedAt: "2026-02-17T09:05:00Z" },
  { id: "crm_03", tenantId: TENANT_B, workspaceId: "00000000-0000-4000-8000-000000000220", provider: "hubspot", status: "error", syncMode: "two_way", environment: "production", externalAccountId: "19204471", lastError: "401 from HubSpot: refresh token revoked by the portal owner", lastRefreshAt: "2026-08-17T22:10:00Z", tokenExpiresAt: "2026-08-17T22:10:00Z", nextPollAt: null, connectedAt: "2026-06-30T14:40:00Z" },
  { id: "crm_04", tenantId: "00000000-0000-4000-8000-000000000104", workspaceId: "00000000-0000-4000-8000-000000000230", provider: "salesforce", status: "paused", syncMode: "pull_only", environment: "sandbox", externalAccountId: null, lastError: null, lastRefreshAt: null, tokenExpiresAt: null, nextPollAt: null, connectedAt: "2026-07-11T10:00:00Z" },
];

export const CRM_DEAD_LETTERS: StaffCrmDeadLetter[] = [
  { id: "dl_01", tenantId: TENANT_B, workspaceId: "00000000-0000-4000-8000-000000000220", connectionId: "crm_03", queue: "crm-push", direction: "outbound", objectType: "contact", crmRecordId: "0031t00000XyZaB", tpEntityId: "ct_01hq8m4pv7", errorClass: "auth_revoked", errorDetail: "401 invalid_grant — the portal owner revoked the refresh token", attempts: 6, firstSeenAt: "2026-08-17T22:11:00Z", lastSeenAt: "2026-08-18T08:11:00Z" },
  { id: "dl_02", tenantId: TENANT_A, workspaceId: WORKSPACE_A, connectionId: "crm_01", queue: "crm-push", direction: "outbound", objectType: "contact", crmRecordId: null, tpEntityId: "ct_01hq8m5rt2", errorClass: "validation", errorDetail: "Property 'lifecyclestage' does not exist on this portal", attempts: 3, firstSeenAt: "2026-08-18T06:02:00Z", lastSeenAt: "2026-08-18T08:02:00Z" },
  { id: "dl_03", tenantId: TENANT_E, workspaceId: "00000000-0000-4000-8000-000000000210", connectionId: "crm_02", queue: "crm-pull", direction: "inbound", objectType: "account", crmRecordId: "0015g00000PqRsT", tpEntityId: null, errorClass: "rate_limit", errorDetail: "REQUEST_LIMIT_EXCEEDED — daily API cap reached", attempts: 12, firstSeenAt: "2026-08-16T18:40:00Z", lastSeenAt: "2026-08-18T07:40:00Z" },
];

// ── data-ops ────────────────────────────────────────────────────────────────────────────────────────────
export const DATA_OPS_OVERVIEW: DataOpsOverview = {
  jobs: { total: 5_000, byStatus: { completed: 4_612, failed: 88, active: 21, waiting: 279 }, queueDepth: 1_511, deadLetter: 33 },
  imports: { recentCount: 48, truncated: false, byStatus: { completed: 41, running: 2, failed: 4, quarantined: 1 }, rejectedRecent: 214 },
  retention: { recentRuns: 6, truncated: false },
};

export const IMPORT_DETAIL: DataImportDetail = {
  jobId: "imp_01hq8z1",
  tenantId: TENANT_A,
  tenantName: "Northwind Logistics",
  status: "completed",
  sourceName: "emea-prospects-q3.csv",
  avScanStatus: "clean",
  conflictPolicy: "prefer_existing",
  fileSize: 2_884_112,
  totalChunks: 10,
  completedChunks: 10,
  rowsTotal: 4_820,
  rowsCreated: 3_991,
  rowsMatched: 742,
  rowsDuplicate: 168,
  rowsSkipped: 12,
  rowsRejected: 87,
  rowsDeduped: 51,
  rowsUnprocessed: 0,
  createdAt: "2026-08-18T07:14:00Z",
  startedAt: "2026-08-18T07:14:12Z",
  completedAt: "2026-08-18T07:19:42Z",
  failedReason: null,
  chunkTally: [
    { status: "completed", count: 10 },
    { status: "failed", count: 0 },
  ],
  rejectHistogram: { missing_email: 41, invalid_email: 28, missing_name: 12, duplicate_in_file: 6 },
};

export const ENRICHMENT_RUNS: EnrichmentRunRow[] = [
  { jobId: "enr_01", tenantId: TENANT_A, tenantName: "Northwind Logistics", status: "completed", sourceName: "emea-prospects-q3.csv", totalRows: 4_820, matchedRows: 4_102, enrichedRows: 3_884, chargedRows: 3_884, creditSpentMicros: 3_884_000_000, createdAt: "2026-08-18T07:20:00Z", completedAt: "2026-08-18T07:41:00Z", failedReason: null },
  { jobId: "enr_02", tenantId: TENANT_E, tenantName: "Ironbridge Group", status: "running", sourceName: "salesforce-export.csv", totalRows: 22_400, matchedRows: 9_004, enrichedRows: 8_112, chargedRows: 8_112, creditSpentMicros: 8_112_000_000, createdAt: "2026-08-18T09:02:00Z", completedAt: null, failedReason: null },
  { jobId: "enr_03", tenantId: TENANT_B, tenantName: "Halcyon MedTech", status: "failed", sourceName: "clinic-contacts.xlsx", totalRows: 1_120, matchedRows: 0, enrichedRows: 0, chargedRows: 0, creditSpentMicros: 0, createdAt: "2026-08-17T16:30:00Z", completedAt: "2026-08-17T16:31:00Z", failedReason: "Provider returned 503 for every batch — circuit opened" },
];

export const VERIFICATION_RUNS: VerificationRunRow[] = [
  { jobId: "ver_01", tenantId: TENANT_A, tenantName: "Northwind Logistics", scanned: 18_420, reverified: 16_902, errored: 141, startedAt: "2026-08-18T02:00:00Z", finishedAt: "2026-08-18T02:41:00Z", createdAt: "2026-08-18T02:00:00Z" },
  { jobId: "ver_02", tenantId: TENANT_E, tenantName: "Ironbridge Group", scanned: 44_118, reverified: 41_006, errored: 388, startedAt: "2026-08-18T02:00:00Z", finishedAt: "2026-08-18T03:12:00Z", createdAt: "2026-08-18T02:00:00Z" },
  { jobId: "ver_03", tenantId: TENANT_B, tenantName: "Halcyon MedTech", scanned: 6_204, reverified: 5_881, errored: 12, startedAt: "2026-08-17T02:00:00Z", finishedAt: "2026-08-17T02:14:00Z", createdAt: "2026-08-17T02:00:00Z" },
];

const quality = (total: number, ok: number) => ({
  total,
  withName: Math.round(total * 0.99),
  withEmail: Math.round(total * 0.92),
  withPhone: Math.round(total * 0.41),
  withTitle: Math.round(total * 0.88),
  withCompany: Math.round(total * 0.96),
  withLinkedin: Math.round(total * 0.74),
  withLocation: Math.round(total * 0.81),
  emailValid: ok,
  emailRisky: Math.round(total * 0.04),
  emailInvalid: Math.round(total * 0.03),
  emailCatchAll: Math.round(total * 0.06),
  emailUnverified: Math.round(total * 0.05),
  emailUnknown: Math.round(total * 0.02),
  phoneValid: Math.round(total * 0.36),
  phoneInvalid: Math.round(total * 0.05),
  phoneMobile: Math.round(total * 0.28),
  phoneLandline: Math.round(total * 0.07),
  phoneVoip: Math.round(total * 0.01),
  fresh: Math.round(total * 0.68),
  stale: Math.round(total * 0.24),
  neverVerified: Math.round(total * 0.08),
});

export const FLEET_QUALITY: FleetQualityRow[] = [
  { snapshotId: "snap_01", tenantId: TENANT_A, tenantName: "Northwind Logistics", workspaceId: WORKSPACE_A, metrics: quality(48_120, 39_460), createdAt: "2026-08-18T04:00:00Z" },
  { snapshotId: "snap_02", tenantId: TENANT_E, tenantName: "Ironbridge Group", workspaceId: "00000000-0000-4000-8000-000000000210", metrics: quality(122_004, 101_220), createdAt: "2026-08-18T04:00:00Z" },
  { snapshotId: "snap_03", tenantId: TENANT_B, tenantName: "Halcyon MedTech", workspaceId: "00000000-0000-4000-8000-000000000220", metrics: quality(9_881, 7_104), createdAt: "2026-08-18T04:00:00Z" },
];

export const APPROVALS = [
  { id: "00000000-0000-4000-8000-00000000b001", operation: "bulk_export", params: { tenantId: TENANT_A, workspaceId: WORKSPACE_A }, targetTenantId: TENANT_A, requestedByUserId: "00000000-0000-4000-8000-0000000000a2", requestReason: "Customer requested a full contact export under their DPA (ticket SUP-4182).", status: "pending", decidedByUserId: null, decisionReason: null, decidedAt: null, expiresAt: "2026-08-21T09:00:00Z", executedAt: null, createdAt: "2026-08-18T09:00:00Z" },
  { id: "00000000-0000-4000-8000-00000000b002", operation: "retention_enforce", params: { dataClass: "provider_calls", ttlDays: 90 }, targetTenantId: null, requestedByUserId: "00000000-0000-4000-8000-0000000000a4", requestReason: "Flip provider calls from shadow to enforce now that the 90-day dry run is clean.", status: "pending", decidedByUserId: null, decisionReason: null, decidedAt: null, expiresAt: "2026-08-22T11:30:00Z", executedAt: null, createdAt: "2026-08-17T11:30:00Z" },
  { id: "00000000-0000-4000-8000-00000000b003", operation: "bulk_export", params: { tenantId: TENANT_B, workspaceId: "00000000-0000-4000-8000-000000000220" }, targetTenantId: TENANT_B, requestedByUserId: "00000000-0000-4000-8000-0000000000a2", requestReason: "Migration assistance — customer moving workspaces (ticket SUP-4090).", status: "approved", decidedByUserId: "00000000-0000-4000-8000-0000000000a1", decisionReason: "DPA on file, scope confirmed with the DPO.", decidedAt: "2026-08-15T14:22:00Z", expiresAt: "2026-08-18T14:00:00Z", executedAt: "2026-08-15T14:31:00Z", createdAt: "2026-08-15T13:40:00Z" },
];

export const VALIDATION_RULES = [
  { id: "builtin:email_required", name: "Email is required", field: "email", checkType: "required", config: {}, enabled: true, builtin: true, createdAt: "2025-05-02T08:00:00Z", updatedAt: "2025-05-02T08:00:00Z" },
  { id: "builtin:email_format", name: "Email must be well-formed", field: "email", checkType: "email_format", config: {}, enabled: true, builtin: true, createdAt: "2025-05-02T08:00:00Z", updatedAt: "2025-05-02T08:00:00Z" },
  { id: "builtin:first_name_required", name: "First name is required", field: "firstName", checkType: "required", config: {}, enabled: false, builtin: true, createdAt: "2025-05-02T08:00:00Z", updatedAt: "2026-03-19T10:14:00Z" },
  { id: "00000000-0000-4000-8000-00000000c001", name: "Job title under 120 characters", field: "jobTitle", checkType: "max_length", config: { max: 120 }, enabled: true, builtin: false, createdAt: "2026-04-08T12:00:00Z", updatedAt: "2026-04-08T12:00:00Z" },
  { id: "00000000-0000-4000-8000-00000000c002", name: "Country must be an ISO-2 code", field: "locationCountry", checkType: "regex", config: { pattern: "^[A-Z]{2}$" }, enabled: true, builtin: false, createdAt: "2026-06-22T09:30:00Z", updatedAt: "2026-07-02T15:45:00Z" },
];

// ── data quality ────────────────────────────────────────────────────────────────────────────────────────
export const DATA_QUALITY: DataQuality = {
  windowDays: 30,
  rollup: {
    workspaces: 214,
    latestAt: "2026-08-18T04:00:00Z",
    total: 1_884_204,
    withEmail: 1_733_468,
    withPhone: 772_524,
    emailValid: 1_545_047,
    fresh: 1_281_258,
    stale: 452_209,
    neverVerified: 150_736,
  },
  verification: {
    totals: { runs: 612, scanned: 1_204_882, reverified: 1_118_004, errored: 4_112 },
    recentRuns: [
      { tenantId: TENANT_E, tenantName: "Ironbridge Group", finishedAt: "2026-08-18T03:12:00Z", scanned: 44_118, reverified: 41_006, errored: 388 },
      { tenantId: TENANT_A, tenantName: "Northwind Logistics", finishedAt: "2026-08-18T02:41:00Z", scanned: 18_420, reverified: 16_902, errored: 141 },
      { tenantId: TENANT_B, tenantName: "Halcyon MedTech", finishedAt: "2026-08-17T02:14:00Z", scanned: 6_204, reverified: 5_881, errored: 12 },
    ],
  },
};

// ── data sources ────────────────────────────────────────────────────────────────────────────────────────
export const ORIGINS: DataSourceOriginView[] = [
  { id: "org_01", provider: "zoominfo", label: "ZoomInfo GTM", baseUrl: "https://api.zoominfo.com", apiKeyHint: "••••4f2a", priority: 10, paused: false, lastOkAt: "2026-08-18T09:10:00Z", consecutiveFailures: 0, lastError: null, lastErrorAt: null },
  { id: "org_02", provider: "apollo", label: "Apollo", baseUrl: "https://api.apollo.io/v1", apiKeyHint: "••••9c17", priority: 20, paused: false, lastOkAt: "2026-08-18T09:08:00Z", consecutiveFailures: 0, lastError: null, lastErrorAt: null },
  { id: "org_03", provider: "pdl", label: "People Data Labs", baseUrl: "https://api.peopledatalabs.com/v5", apiKeyHint: "••••2b88", priority: 30, paused: true, lastOkAt: "2026-08-04T17:20:00Z", consecutiveFailures: 0, lastError: null, lastErrorAt: null },
  { id: "org_04", provider: "coresignal", label: "Coresignal", baseUrl: "https://api.coresignal.com/cdapi/v1", apiKeyHint: "••••7e05", priority: 40, paused: false, lastOkAt: "2026-08-17T21:02:00Z", consecutiveFailures: 4, lastError: "503 Service Unavailable (4 consecutive)", lastErrorAt: "2026-08-18T08:55:00Z" },
];

// ── extension ───────────────────────────────────────────────────────────────────────────────────────────
export const EXTENSION_META: ExtensionMeta = {
  version: "1.4.2",
  extensionId: "icdgalkohdcgcjjcbmfpdnhjcmhbnmpo",
  minimumChromeVersion: "116",
  filename: "truepoint-extension-1.4.2.zip",
  builtAt: "2026-08-15T12:04:00Z",
};

// ── feature flags ───────────────────────────────────────────────────────────────────────────────────────
export const FEATURE_FLAGS = [
  { key: "waterfall_v2_enabled", description: "Per-field enrichment cascade with workspace provider priority.", globalEnabled: true, defaultEnabled: false, createdAt: "2026-06-02T10:00:00Z", updatedAt: "2026-08-11T14:20:00Z", overrides: [{ tenantId: TENANT_A, enabled: true }, { tenantId: TENANT_B, enabled: false }] },
  { key: "crm_sync_enabled", description: "Two-way CRM connectors (HubSpot, Salesforce).", globalEnabled: false, defaultEnabled: false, createdAt: "2026-03-18T09:00:00Z", updatedAt: "2026-07-30T11:05:00Z", overrides: [{ tenantId: TENANT_E, enabled: true }] },
  { key: "chrome_extension_enabled", description: "The MV3 browser extension and its token endpoints.", globalEnabled: true, defaultEnabled: true, createdAt: "2026-01-22T08:00:00Z", updatedAt: "2026-08-01T09:40:00Z", overrides: [] },
  { key: "entitlements_enforced", description: "Enforce plan entitlement caps instead of shadow-logging them.", globalEnabled: false, defaultEnabled: false, createdAt: "2026-05-14T13:00:00Z", updatedAt: "2026-08-18T07:00:00Z", overrides: [{ tenantId: TENANT_A, enabled: true }] },
];

export const ENV_GATES = [
  { key: "CRM_SYNC_ENABLED", label: "CRM sync", description: "Process-level master switch for the CRM connectors. The per-tenant flag cannot turn this on.", enabled: false, flagKey: "crm_sync_enabled" },
  { key: "CHROME_EXTENSION_ENABLED", label: "Browser extension", description: "Enables the extension token endpoints and the EXTENSION_ORIGINS CORS allow-list.", enabled: true, flagKey: "chrome_extension_enabled" },
  { key: "WATERFALL_V2_ENABLED", label: "Enrichment waterfall v2", description: "The per-field cascade. Dual-gated: this env switch AND the tenant flag must both be on.", enabled: true, flagKey: "waterfall_v2_enabled" },
  { key: "BULK_IMPORT_ENABLED", label: "Bulk import", description: "Chunked CSV/XLSX import pipeline including the antivirus scan step.", enabled: true, flagKey: null },
];

// ── plans + pricing ─────────────────────────────────────────────────────────────────────────────────────
export const PLAN_TEMPLATES: PlanTemplate[] = [
  { key: "free", name: "Free", seatLimit: 1, workspaceLimit: 1, monthlyCreditGrant: 0, trialBonusCredits: 25, features: { search: true, exports: false, crm_sync: false, api: false }, active: true, sortOrder: 1, updatedAt: "2026-01-08T09:00:00Z" },
  { key: "community", name: "Community", seatLimit: 3, workspaceLimit: 1, monthlyCreditGrant: 250, trialBonusCredits: 0, features: { search: true, exports: true, crm_sync: false, api: false }, active: true, sortOrder: 2, updatedAt: "2026-04-19T10:15:00Z" },
  { key: "pro", name: "Pro", seatLimit: 10, workspaceLimit: 2, monthlyCreditGrant: 2_000, trialBonusCredits: 100, features: { search: true, exports: true, crm_sync: true, api: true }, active: true, sortOrder: 3, updatedAt: "2026-06-11T12:40:00Z" },
  { key: "team", name: "Team", seatLimit: 50, workspaceLimit: 12, monthlyCreditGrant: 12_000, trialBonusCredits: 250, features: { search: true, exports: true, crm_sync: true, api: true }, active: true, sortOrder: 4, updatedAt: "2026-06-11T12:40:00Z" },
  { key: "legacy_starter", name: "Starter (retired)", seatLimit: 5, workspaceLimit: 1, monthlyCreditGrant: 500, trialBonusCredits: null, features: { search: true, exports: true, crm_sync: false, api: false }, active: false, sortOrder: 9, updatedAt: "2025-12-02T08:30:00Z" },
];

export const CREDIT_PACKS: CreditPack[] = [
  { key: "pack_1k", name: "1,000 credits", credits: 1_000, priceCents: 24_900, active: true, sortOrder: 1, updatedAt: "2026-02-14T09:00:00Z" },
  { key: "pack_5k", name: "5,000 credits", credits: 5_000, priceCents: 109_900, active: true, sortOrder: 2, updatedAt: "2026-02-14T09:00:00Z" },
  { key: "pack_25k", name: "25,000 credits", credits: 25_000, priceCents: 479_900, active: true, sortOrder: 3, updatedAt: "2026-05-30T15:20:00Z" },
  { key: "pack_100", name: "100 credits", credits: 100, priceCents: 3_900, active: false, sortOrder: 8, updatedAt: "2025-10-11T11:00:00Z" },
];

// ── provider configs ────────────────────────────────────────────────────────────────────────────────────
export const PROVIDER_CONFIGS: ProviderConfigView[] = [
  { provider: "zoominfo", label: "ZoomInfo GTM", enabled: true, keyHint: "••••4f2a", rateLimitPerMin: 300, monthlyBudgetCents: 800_000, monthToDateCents: 512_400, health: "healthy" },
  { provider: "apollo", label: "Apollo", enabled: true, keyHint: "••••9c17", rateLimitPerMin: 600, monthlyBudgetCents: 400_000, monthToDateCents: 288_100, health: "healthy" },
  { provider: "coresignal", label: "Coresignal", enabled: true, keyHint: "••••7e05", rateLimitPerMin: 120, monthlyBudgetCents: 200_000, monthToDateCents: 41_900, health: "degraded" },
  { provider: "pdl", label: "People Data Labs", enabled: false, keyHint: "••••2b88", rateLimitPerMin: null, monthlyBudgetCents: null, monthToDateCents: 0, health: "unknown" },
];

// ── retention runs ──────────────────────────────────────────────────────────────────────────────────────
export const RETENTION_RUNS: RetentionRunRow[] = [
  { tenantId: TENANT_A, tenantName: "Northwind Logistics", dataClass: "provider_calls", mode: "enforce", candidateCount: 12_408, deletedCount: 12_408, cutoff: "2026-05-20T00:00:00Z", runStartedAt: "2026-08-18T03:00:00Z", runFinishedAt: "2026-08-18T03:04:00Z" },
  { tenantId: TENANT_E, tenantName: "Ironbridge Group", dataClass: "provider_calls", mode: "enforce", candidateCount: 41_002, deletedCount: 41_002, cutoff: "2026-05-20T00:00:00Z", runStartedAt: "2026-08-18T03:04:00Z", runFinishedAt: "2026-08-18T03:19:00Z" },
  { tenantId: TENANT_B, tenantName: "Halcyon MedTech", dataClass: "activities", mode: "shadow", candidateCount: 8_814, deletedCount: 0, cutoff: "2025-08-18T00:00:00Z", runStartedAt: "2026-08-18T03:19:00Z", runFinishedAt: "2026-08-18T03:21:00Z" },
];

// ── auth policy ─────────────────────────────────────────────────────────────────────────────────────────
export const PLATFORM_DEFAULTS = [
  { key: "password_min_length", value: 12 },
  { key: "mfa_required", value: false },
  { key: "session_idle_timeout_minutes", value: 60 },
  { key: "session_absolute_lifetime_hours", value: 720 },
  { key: "sso_enforced", value: false },
];

// ── tenant detail sub-routes ────────────────────────────────────────────────────────────────────────────
// TenantOverview / TenantEconomics / TenantPurchases / TenantSubscription / SupportNotes / TenantHolds /
// TenantLedger each take only a `tenantId` and fetch their own slice, so the tenant-detail surface needs
// every one of these routes fixtured before it renders as anything but a stack of empty cards.

export const TENANT_360 = {
  reveals30d: 48_119,
  burn30d: 48_119,
  revealsTotal: 412_884,
  lastRevealAt: "2026-08-18T09:12:00Z",
  activeHolds: 0,
};

export const TENANT_ECONOMICS_DETAIL = {
  tenantId: "00000000-0000-4000-8000-000000000101",
  tenantName: "Northwind Logistics",
  plan: "team",
  revealCreditBalance: 12_480,
  sinceDays: 30,
  revenueCents: 1_440_000,
  refundedCents: 0,
  creditsSold: 60_000,
  creditsConsumed: 48_119,
  reveals: 48_119,
  chargedReveals: 43_002,
  providerSpendCents: 548_800,
  costPerRevealCents: 12.76,
  marginCents: 891_200,
  lifetimeRevenueCents: 9_842_000,
  lifetimeRefundedCents: 24_900,
  lifetimeCreditsSold: 412_000,
  lifetimeCreditsConsumed: 398_441,
  lastPurchaseAt: "2026-08-01T10:04:00Z",
};

export const TENANT_PURCHASES = [
  { id: "pur_01", credits: 25_000, amountCents: 479_900, status: "completed", createdAt: "2026-08-01T10:04:00Z" },
  { id: "pur_02", credits: 25_000, amountCents: 479_900, status: "completed", createdAt: "2026-06-03T09:41:00Z" },
  { id: "pur_03", credits: 5_000, amountCents: 109_900, status: "refunded", createdAt: "2026-04-18T14:22:00Z" },
  { id: "pur_04", credits: 5_000, amountCents: 109_900, status: "completed", createdAt: "2026-03-02T11:15:00Z" },
];

export const TENANT_SUBSCRIPTION = {
  plan: "team",
  planName: "Team",
  status: "active",
  term: "annual",
  currentPeriodEnd: "2027-02-01T00:00:00Z",
  cancelAtPeriodEnd: false,
  autoRenew: true,
};

export const TENANT_LEDGER = [
  { id: "00000000-0000-4000-8000-00000000d001", entryType: "spend", delta: -1, balanceAfter: 12_480, reason: "Reveal — email", purchaseId: null, revealId: "00000000-0000-4000-8000-00000000e001", actorUserId: "00000000-0000-4000-8000-000000000301", createdAt: "2026-08-18T09:12:00Z" },
  { id: "00000000-0000-4000-8000-00000000d002", entryType: "spend", delta: -12, balanceAfter: 12_481, reason: "Bulk reveal — 12 contacts", purchaseId: null, revealId: null, actorUserId: "00000000-0000-4000-8000-000000000302", createdAt: "2026-08-18T08:44:00Z" },
  { id: "00000000-0000-4000-8000-00000000d003", entryType: "credit_back", delta: 3, balanceAfter: 12_493, reason: "Non-match refund — nothing on file", purchaseId: null, revealId: null, actorUserId: null, createdAt: "2026-08-18T08:44:00Z" },
  { id: "00000000-0000-4000-8000-00000000d004", entryType: "grant", delta: 12_000, balanceAfter: 12_490, reason: "Monthly plan grant — Team", purchaseId: null, revealId: null, actorUserId: null, createdAt: "2026-08-01T00:00:00Z" },
  { id: "00000000-0000-4000-8000-00000000d005", entryType: "adjustment", delta: 500, balanceAfter: 490, reason: "Goodwill — provider outage on 29 Jul (ticket SUP-4021)", purchaseId: null, revealId: null, actorUserId: "00000000-0000-4000-8000-0000000000a3", createdAt: "2026-07-30T15:20:00Z" },
];

export const TENANT_NOTES = [
  { id: "note_01", tenantId: "00000000-0000-4000-8000-000000000101", staffUserId: "00000000-0000-4000-8000-0000000000a2", body: "Customer asked about SSO enforcement timing — pointed them at the auth policy defaults. No action needed.", ticketUrl: "https://support.truepoint.in/t/4182", createdAt: "2026-08-14T11:02:00Z" },
  { id: "note_02", tenantId: "00000000-0000-4000-8000-000000000101", staffUserId: "00000000-0000-4000-8000-0000000000a3", body: "Applied a 500-credit goodwill adjustment after the 29 Jul provider outage. Approved by billing ops.", ticketUrl: "https://support.truepoint.in/t/4021", createdAt: "2026-07-30T15:22:00Z" },
];

export const TENANT_HOLDS = [
  { id: "hold_01", tenantId: "00000000-0000-4000-8000-000000000101", kind: "payment_review", reason: "Card issuer flagged the 3 Jun top-up; cleared after verification.", placedByUserId: "00000000-0000-4000-8000-0000000000a3", placedAt: "2026-06-03T10:12:00Z", liftedAt: "2026-06-04T09:30:00Z", liftedByUserId: "00000000-0000-4000-8000-0000000000a3" },
];

// ── retention policies (the /retention-policies shape) ──────────────────────────────────────────────────
// NOT the same shape as COMPLIANCE_RETENTION above. The compliance surface records prose commitments
// ({entity, retentionDays, reason}); the retention ENGINE reads @leadwolf/types' RetentionPolicy
// ({dataClass, ttlDays, mode}) and is what actually deletes. Reusing the wrong one rendered a table with a
// blank Data class column and "Never" in every TTL cell.
//
// `mode` is the arming switch and its values are exactly disabled | shadow | enforce — NOT "observe",
// which is the word the UI copy uses for shadow and which silently falls back to the first select option.
// shadow counts and audits but deletes nothing; enforce permanently deletes. The mix below is the honest
// state: the low-risk v1 classes armed, the contact-cascade classes still in shadow.
export const RETENTION_POLICIES = [
  { dataClass: "provider_calls", ttlDays: 90, mode: "enforce" },
  { dataClass: "email_event", ttlDays: 180, mode: "enforce" },
  { dataClass: "import_job_rows", ttlDays: 90, mode: "enforce" },
  { dataClass: "data_quality_snapshots", ttlDays: 365, mode: "enforce" },
  { dataClass: "enrichment_job_rows", ttlDays: 90, mode: "shadow" },
  { dataClass: "verification_jobs", ttlDays: 180, mode: "shadow" },
  { dataClass: "activities", ttlDays: 365, mode: "shadow" },
  { dataClass: "contact_reveals", ttlDays: null, mode: "shadow" },
];

// ── money approvals (the two-person rule on credit movements) ───────────────────────────────────────────
// A credit adjustment is money, so it needs a second operator: the requester can never be the approver, and
// the server enforces that separation rather than the UI.
export const BILLING_APPROVALS = [
  {
    id: "00000000-0000-4000-8000-00000000b101",
    operation: "credit_adjustment",
    params: { tenantId: "00000000-0000-4000-8000-000000000101", delta: 500, reason: "Goodwill" },
    targetTenantId: "00000000-0000-4000-8000-000000000101",
    requestedByUserId: "00000000-0000-4000-8000-0000000000a2",
    requestReason: "Goodwill credit after the 29 Jul provider outage — agreed with the customer on ticket SUP-4021.",
    status: "pending",
    decidedByUserId: null,
    decisionReason: null,
    decidedAt: null,
    expiresAt: "2026-08-21T15:20:00Z",
    executedAt: null,
    createdAt: "2026-08-18T08:20:00Z",
  },
  {
    id: "00000000-0000-4000-8000-00000000b102",
    operation: "purchase_refund",
    params: { tenantId: "00000000-0000-4000-8000-000000000101", purchaseId: "pur_03" },
    targetTenantId: "00000000-0000-4000-8000-000000000101",
    requestedByUserId: "00000000-0000-4000-8000-0000000000a3",
    requestReason: "Duplicate top-up charged twice on 18 Apr — customer confirmed, refund the second.",
    status: "pending",
    decidedByUserId: null,
    decisionReason: null,
    decidedAt: null,
    expiresAt: "2026-08-20T09:00:00Z",
    executedAt: null,
    createdAt: "2026-08-17T09:00:00Z",
  },
];
