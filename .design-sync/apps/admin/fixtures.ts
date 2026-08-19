// fixtures.ts — the staff-console data every admin card renders.
//
// Shapes mirror apps/admin/src/features/*/types.ts exactly (which mirror the api's /admin payloads), so the
// REAL components render populated state without an api. This file grows as more routes get fixtured; the
// stub's EMPTY_OK fallback keeps an unfixtured route rendering its empty state rather than throwing.
//
// PII posture: every person here is invented, and the tenants are fictional companies. Nothing in this file
// is real customer data — the console is the surface staff use to look AT customers, so its fixtures are the
// one place it would be easy to paste something real. Don't.

import type { AiUsageReport } from "../../../apps/admin/src/features/ai-usage/types";
import type { PlatformAuditEntry } from "../../../apps/admin/src/features/audit-log/types";
import type { ImportJobRow } from "../../../apps/admin/src/features/imports/types";
import type { StaffMember } from "../../../apps/admin/src/features/staff/types";
import type { SystemHealth } from "../../../apps/admin/src/features/system-health/types";
import type { TenantDetail, TenantRow } from "../../../apps/admin/src/features/tenants/types";
import type { PlatformUser } from "../../../apps/admin/src/features/users/types";

// Fixed timestamps: a relative-time cell that renders differently on every capture would churn the render
// hashes and clear its own grade on every sync.
const TENANT_A = "00000000-0000-4000-8000-000000000101";
const TENANT_B = "00000000-0000-4000-8000-000000000102";
const TENANT_C = "00000000-0000-4000-8000-000000000103";

export const STAFF_CAPABILITIES = [
  "tenant:read", "tenant:write", "user:read", "user:write", "billing:read", "billing:write",
  "compliance:read", "compliance:write", "data:read", "data:write", "flags:write", "staff:manage",
];

export const SYSTEM_HEALTH: SystemHealth = {
  services: [
    { name: "api", status: "up" },
    { name: "workers", status: "up" },
    { name: "postgres", status: "up" },
    { name: "redis", status: "up" },
    { name: "object-storage", status: "up" },
    { name: "forge-api", status: "degraded" },
  ],
  queues: [
    { name: "enrichment", waiting: 128, active: 6, failed: 2, delayed: 0, workers: 4, reachable: true },
    { name: "verification", waiting: 1_284, active: 12, failed: 31, delayed: 44, workers: 6, reachable: true },
    { name: "reverification", waiting: 96, active: 2, failed: 0, delayed: 512, workers: 2, reachable: true },
    { name: "import", waiting: 3, active: 1, failed: 0, delayed: 0, workers: 2, reachable: true },
    { name: "dsar", waiting: 0, active: 0, failed: 0, delayed: 0, workers: 1, reachable: true },
    // Counts are null, not 0 — an honest "unknown" for a queue that could not be reached.
    { name: "crm-sync", waiting: null, active: null, failed: null, delayed: null, workers: null, reachable: false },
  ],
  jobs: {
    sampleSize: 5_000,
    truncated: true,
    byStatus: { completed: 4_612, failed: 88, active: 21, waiting: 279 },
    queueDepth: 1_511,
    deadLetter: 33,
  },
};

export const TENANTS: TenantRow[] = [
  { id: TENANT_A, name: "Northwind Logistics", slug: "northwind", plan: "team", status: "active", suspensionReason: null, seatLimit: 25, workspaceLimit: 5, revealCreditBalance: 12_480, regionDefault: "eu-west-1", createdAt: "2025-11-04T09:12:00Z" },
  { id: TENANT_B, name: "Halcyon MedTech", slug: "halcyon", plan: "pro", status: "active", suspensionReason: null, seatLimit: 10, workspaceLimit: 2, revealCreditBalance: 3_150, regionDefault: "eu-west-1", createdAt: "2026-01-22T14:41:00Z" },
  { id: TENANT_C, name: "Vantage Freight", slug: "vantage", plan: "pro", status: "suspended", suspensionReason: "dunning", seatLimit: 10, workspaceLimit: 2, revealCreditBalance: 0, regionDefault: "us-east-1", createdAt: "2025-08-30T11:05:00Z" },
  { id: "00000000-0000-4000-8000-000000000104", name: "Beacon Analytics", slug: "beacon", plan: "community", status: "active", suspensionReason: null, seatLimit: 3, workspaceLimit: 1, revealCreditBalance: 240, regionDefault: "ap-south-1", createdAt: "2026-04-17T08:20:00Z" },
  { id: "00000000-0000-4000-8000-000000000105", name: "Ironbridge Group", slug: "ironbridge", plan: "team", status: "active", suspensionReason: null, seatLimit: 50, workspaceLimit: 12, revealCreditBalance: 44_900, regionDefault: "eu-west-1", createdAt: "2025-06-11T16:33:00Z" },
  { id: "00000000-0000-4000-8000-000000000106", name: "Kestrel Software", slug: "kestrel", plan: "free", status: "active", suspensionReason: null, seatLimit: 1, workspaceLimit: 1, revealCreditBalance: 0, regionDefault: "us-east-1", createdAt: "2026-07-29T10:02:00Z" },
  { id: "00000000-0000-4000-8000-000000000107", name: "Ardent Robotics", slug: "ardent", plan: "pro", status: "suspended", suspensionReason: "staff", seatLimit: 10, workspaceLimit: 2, revealCreditBalance: 1_020, regionDefault: "eu-west-1", createdAt: "2026-02-09T13:18:00Z" },
];

export const TENANT_DETAIL: TenantDetail = {
  tenant: TENANTS[0],
  enforcementEnabled: true,
  workspaces: [
    { id: "00000000-0000-4000-8000-000000000201", name: "EMEA New Business", slug: "emea-new-business", isDefault: true, createdAt: "2025-11-04T09:12:00Z" },
    { id: "00000000-0000-4000-8000-000000000202", name: "Enterprise Expansion", slug: "enterprise-expansion", isDefault: false, createdAt: "2026-02-18T10:44:00Z" },
    { id: "00000000-0000-4000-8000-000000000203", name: "Partnerships", slug: "partnerships", isDefault: false, createdAt: "2026-05-06T15:29:00Z" },
  ],
  members: [
    { userId: "00000000-0000-4000-8000-000000000301", email: "priya.raghavan@northwind.example", fullName: "Priya Raghavan", isTenantOwner: true, status: "active" },
    { userId: "00000000-0000-4000-8000-000000000302", email: "daniel.okafor@northwind.example", fullName: "Daniel Okafor", isTenantOwner: false, status: "active" },
    { userId: "00000000-0000-4000-8000-000000000303", email: "marta.svensson@northwind.example", fullName: "Marta Svensson", isTenantOwner: false, status: "active" },
    { userId: "00000000-0000-4000-8000-000000000304", email: "tom.beckett@northwind.example", fullName: "Tom Beckett", isTenantOwner: false, status: "invited" },
  ],
};

export const USERS: PlatformUser[] = [
  { id: "00000000-0000-4000-8000-000000000301", email: "priya.raghavan@northwind.example", fullName: "Priya Raghavan", status: "active", isPlatformAdmin: false },
  { id: "00000000-0000-4000-8000-000000000302", email: "daniel.okafor@northwind.example", fullName: "Daniel Okafor", status: "active", isPlatformAdmin: false },
  { id: "00000000-0000-4000-8000-000000000305", email: "aisha.khan@halcyon.example", fullName: "Aisha Khan", status: "active", isPlatformAdmin: false },
  { id: "00000000-0000-4000-8000-000000000306", email: "lars.eriksen@vantage.example", fullName: "Lars Eriksen", status: "suspended", isPlatformAdmin: false },
  { id: "00000000-0000-4000-8000-0000000000a1", email: "ops@truepoint.in", fullName: "TruePoint Operations", status: "active", isPlatformAdmin: true },
  { id: "00000000-0000-4000-8000-000000000307", email: "nina.costa@beacon.example", fullName: "Nina Costa", status: "invited", isPlatformAdmin: false },
];

export const STAFF: StaffMember[] = [
  { userId: "00000000-0000-4000-8000-0000000000a1", email: "ops@truepoint.in", fullName: "TruePoint Operations", staffRole: "super_admin", status: "active", grantedAt: "2025-05-02T08:00:00Z" },
  { userId: "00000000-0000-4000-8000-0000000000a2", email: "support@truepoint.in", fullName: "Support Desk", staffRole: "support", status: "active", grantedAt: "2025-09-14T11:20:00Z" },
  { userId: "00000000-0000-4000-8000-0000000000a3", email: "billing@truepoint.in", fullName: "Billing Ops", staffRole: "billing_ops", status: "active", grantedAt: "2026-01-08T09:45:00Z" },
  { userId: "00000000-0000-4000-8000-0000000000a4", email: "dpo@truepoint.in", fullName: "Data Protection Officer", staffRole: "compliance_officer", status: "active", grantedAt: "2025-07-21T13:02:00Z" },
  { userId: "00000000-0000-4000-8000-0000000000a5", email: "analyst@truepoint.in", fullName: "Revenue Analyst", staffRole: "read_only", status: "revoked", grantedAt: "2025-10-30T16:15:00Z" },
];

export const AUDIT_ENTRIES: PlatformAuditEntry[] = [
  { id: "aud_01hq9a1", action: "tenant.plan_override", actorUserId: "00000000-0000-4000-8000-0000000000a1", targetType: "tenant", targetId: TENANT_A, tenantId: TENANT_A, workspaceId: null, ip: "203.0.113.14", occurredAt: "2026-08-18T09:02:11Z" },
  { id: "aud_01hq9a2", action: "staff.role_granted", actorUserId: "00000000-0000-4000-8000-0000000000a1", targetType: "user", targetId: "00000000-0000-4000-8000-0000000000a3", tenantId: null, workspaceId: null, ip: "203.0.113.14", occurredAt: "2026-08-18T08:47:53Z" },
  { id: "aud_01hq9a3", action: "tenant.suspended", actorUserId: "00000000-0000-4000-8000-0000000000a2", targetType: "tenant", targetId: "00000000-0000-4000-8000-000000000107", tenantId: "00000000-0000-4000-8000-000000000107", workspaceId: null, ip: "198.51.100.7", occurredAt: "2026-08-18T08:12:30Z" },
  { id: "aud_01hq9a4", action: "compliance.dsar_exported", actorUserId: "00000000-0000-4000-8000-0000000000a4", targetType: "dsar", targetId: "dsar_01hq88", tenantId: TENANT_B, workspaceId: null, ip: "198.51.100.22", occurredAt: "2026-08-17T17:40:09Z" },
  { id: "aud_01hq9a5", action: "flag.override_set", actorUserId: "00000000-0000-4000-8000-0000000000a1", targetType: "feature_flag", targetId: "waterfall_v2_enabled", tenantId: TENANT_A, workspaceId: null, ip: "203.0.113.14", occurredAt: "2026-08-17T15:21:44Z" },
  { id: "aud_01hq9a6", action: "billing.credits_granted", actorUserId: "00000000-0000-4000-8000-0000000000a3", targetType: "tenant", targetId: TENANT_B, tenantId: TENANT_B, workspaceId: null, ip: "198.51.100.31", occurredAt: "2026-08-17T11:03:27Z" },
];

export const AI_USAGE: AiUsageReport = {
  windowDays: 30,
  tenants: [
    { tenantId: TENANT_A, tenantName: "Northwind Logistics", requests: 18_402, failures: 214, repairs: 96, avgLatencyMs: 812, inputTokens: 9_240_118, outputTokens: 1_884_002 },
    { tenantId: "00000000-0000-4000-8000-000000000105", tenantName: "Ironbridge Group", requests: 12_887, failures: 91, repairs: 44, avgLatencyMs: 744, inputTokens: 6_112_450, outputTokens: 1_204_331 },
    { tenantId: TENANT_B, tenantName: "Halcyon MedTech", requests: 4_120, failures: 38, repairs: 12, avgLatencyMs: 903, inputTokens: 2_004_882, outputTokens: 402_119 },
    { tenantId: "00000000-0000-4000-8000-000000000104", tenantName: "Beacon Analytics", requests: 611, failures: 4, repairs: 1, avgLatencyMs: null, inputTokens: 288_401, outputTokens: 51_772 },
  ],
};

export const TRUST_ABUSE = {
  signals: {
    tenants: { d1: 3, d7: 19, d30: 74, total: 1_284 },
    users: { d1: 11, d7: 68, d30: 291, total: 9_442 },
    freeEmailSignups30d: 46,
  },
  holds: [
    { key: "payment_review", count: 4 },
    { key: "abuse_review", count: 2 },
    { key: "manual_kyc", count: 1 },
  ],
  tenantStatus: [
    { key: "active", count: 1_240 },
    { key: "suspended", count: 31 },
    { key: "closed", count: 13 },
  ],
};

export const IMPORT_JOBS: ImportJobRow[] = [
  { jobId: "imp_01hq8z1", tenantId: TENANT_A, tenantName: "Northwind Logistics", status: "completed", sourceName: "emea-prospects-q3.csv", avScanStatus: "clean", rowsTotal: 4_820, rowsCreated: 3_991, rowsMatched: 742, rowsRejected: 87, createdAt: "2026-08-18T07:14:00Z", completedAt: "2026-08-18T07:19:42Z", failedReason: null },
  { jobId: "imp_01hq8z2", tenantId: "00000000-0000-4000-8000-000000000105", tenantName: "Ironbridge Group", status: "running", sourceName: "salesforce-export.csv", avScanStatus: "clean", rowsTotal: 22_400, rowsCreated: 9_112, rowsMatched: 1_884, rowsRejected: 41, createdAt: "2026-08-18T09:01:00Z", completedAt: null, failedReason: null },
  { jobId: "imp_01hq8z3", tenantId: TENANT_B, tenantName: "Halcyon MedTech", status: "failed", sourceName: "clinic-contacts.xlsx", avScanStatus: "clean", rowsTotal: 1_120, rowsCreated: 0, rowsMatched: 0, rowsRejected: 0, createdAt: "2026-08-17T16:22:00Z", completedAt: "2026-08-17T16:22:38Z", failedReason: "Header row missing a required column: email" },
  { jobId: "imp_01hq8z4", tenantId: "00000000-0000-4000-8000-000000000104", tenantName: "Beacon Analytics", status: "quarantined", sourceName: "list-purchase.csv", avScanStatus: "infected", rowsTotal: 0, rowsCreated: 0, rowsMatched: 0, rowsRejected: 0, createdAt: "2026-08-17T12:40:00Z", completedAt: null, failedReason: "Upload failed antivirus scan" },
];
