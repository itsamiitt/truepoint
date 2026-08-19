// Shared fixtures for the apps/admin cards that take their data as props.
//
// Not a component and not a card: files prefixed with `_` are preview helpers, so package-build logs a
// harmless "stale preview" line for it.
//
// Most console surfaces fetch through the stubbed token client and need nothing here. These are the ones
// whose data arrives as a prop — the dialogs, the pickers, the trend chart, and the tenant-row actions —
// where the fixture IS the story's variant axis.
//
// Every tenant, person and company below is invented. The console is the surface staff use to look AT
// customers, so its fixtures are the one place it would be easy to paste something real.

import { ToastProvider } from "@leadwolf/ui";
import type { ReactNode } from "react";

export const adminCard: React.CSSProperties = {
  padding: 20,
  background: "var(--tp-surface, #fff)",
  border: "1px solid var(--tp-hairline-2, #eceef1)",
  borderRadius: 10,
};

/**
 * A card surface WITH the ToastProvider the console's shell supplies.
 *
 * Anything that performs a write calls `useToast()` to report the outcome, and that hook throws outside its
 * provider — so a bare styled <div> is not enough for these components, only for inert ones.
 */
export function AdminFrame({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <div style={adminCard}>{children}</div>
    </ToastProvider>
  );
}

export const TENANTS = [
  { id: "00000000-0000-4000-8000-000000000101", name: "Northwind Logistics", slug: "northwind", plan: "team", status: "active", suspensionReason: null, seatLimit: 25, workspaceLimit: 5, revealCreditBalance: 12_480, regionDefault: "eu-west-1", createdAt: "2025-11-04T09:12:00Z" },
  { id: "00000000-0000-4000-8000-000000000102", name: "Halcyon MedTech", slug: "halcyon", plan: "pro", status: "active", suspensionReason: null, seatLimit: 10, workspaceLimit: 2, revealCreditBalance: 3_150, regionDefault: "eu-west-1", createdAt: "2026-01-22T14:41:00Z" },
  { id: "00000000-0000-4000-8000-000000000103", name: "Vantage Freight", slug: "vantage", plan: "pro", status: "suspended", suspensionReason: "dunning", seatLimit: 10, workspaceLimit: 2, revealCreditBalance: 0, regionDefault: "us-east-1", createdAt: "2025-08-30T11:05:00Z" },
  { id: "00000000-0000-4000-8000-000000000104", name: "Beacon Analytics", slug: "beacon", plan: "community", status: "active", suspensionReason: null, seatLimit: 3, workspaceLimit: 1, revealCreditBalance: 240, regionDefault: "ap-south-1", createdAt: "2026-04-17T08:20:00Z" },
  { id: "00000000-0000-4000-8000-000000000105", name: "Ironbridge Group", slug: "ironbridge", plan: "team", status: "active", suspensionReason: null, seatLimit: 50, workspaceLimit: 12, revealCreditBalance: 44_900, regionDefault: "eu-west-1", createdAt: "2025-06-11T16:33:00Z" },
  { id: "00000000-0000-4000-8000-000000000106", name: "Kestrel Software", slug: "kestrel", plan: "free", status: "active", suspensionReason: null, seatLimit: 1, workspaceLimit: 1, revealCreditBalance: 0, regionDefault: "us-east-1", createdAt: "2026-07-29T10:02:00Z" },
  { id: "00000000-0000-4000-8000-000000000107", name: "Ardent Robotics", slug: "ardent", plan: "pro", status: "suspended", suspensionReason: "staff", seatLimit: 10, workspaceLimit: 2, revealCreditBalance: 1_020, regionDefault: "eu-west-1", createdAt: "2026-02-09T13:18:00Z" },
];

export const TENANT_DETAIL = {
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

/** A fourteen-day series with a weekend dip, so the trend reads as real rather than as a straight line. */
export const TREND = [
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

/**
 * The retention ENGINE's policy shape (@leadwolf/types): {dataClass, ttlDays, mode}.
 *
 * NOT the compliance surface's {entity, retentionDays, reason}, which records prose commitments and deletes
 * nothing. Passing the compliance shape here rendered "Global policy for undefined" with an empty TTL —
 * the two look interchangeable and are not.
 *
 * `mode` is the arming switch, valued disabled | shadow | enforce: shadow counts and audits, enforce deletes.
 */
export const RETENTION_POLICY = {
  dataClass: "provider_calls" as const,
  ttlDays: 90,
  mode: "enforce" as const,
};

export const FLAG = {
  key: "waterfall_v2_enabled",
  description: "Per-field enrichment cascade with workspace provider priority.",
  globalEnabled: true,
  defaultEnabled: false,
  createdAt: "2026-06-02T10:00:00Z",
  updatedAt: "2026-08-11T14:20:00Z",
  overrides: [
    { tenantId: "00000000-0000-4000-8000-000000000101", enabled: true },
    { tenantId: "00000000-0000-4000-8000-000000000102", enabled: false },
  ],
};

export const CUSTOM_RULE = {
  id: "00000000-0000-4000-8000-00000000c002",
  name: "Country must be an ISO-2 code",
  field: "locationCountry",
  checkType: "regex" as const,
  config: { pattern: "^[A-Z]{2}$" },
  enabled: true,
  builtin: false,
  createdAt: "2026-06-22T09:30:00Z",
  updatedAt: "2026-07-02T15:45:00Z",
};
