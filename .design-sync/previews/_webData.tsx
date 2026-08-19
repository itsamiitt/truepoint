// Shared preview data for the apps/web components that take their content as PROPS.
//
// Not a component and not a card: files prefixed with `_` are preview helpers, so package-build logs a
// harmless "stale preview" line for it.
//
// Most of these components share one signature — `{ data, loading, error, onRetry }` — which is exactly why
// they are worth authoring properly: unlike the fetch-driven pages, their states ARE per-story, so a card
// can show loaded, loading and error side by side.
//
// The workspace-level data is re-exported from ../prospect/fixtures-web so the cards and the pages that
// compose them show the SAME numbers. What is defined locally is only the reports-slice rollups, whose
// shapes are computed client-side from the usage feed and therefore never travel over a route.

import * as W from "../prospect/fixtures-web";

export { W };

/** Every one of these components takes the same trio; spread it and override what the story varies. */
export const idle = { loading: false, error: null, onRetry: () => {} };
export const busy = { loading: true, error: null, onRetry: () => {} };
export const failed = {
  loading: false,
  error: "The request timed out after 30s",
  onRetry: () => {},
};

// ── reports rollups (computed in the browser from the usage feed, so they have no route of their own) ────
export const CREDIT_ROLLUP = {
  revealsLast7: 4_812,
  creditsLast7: 6_020,
  days: [
    { key: "2026-08-12", label: "Wed", reveals: 604, credits: 812 },
    { key: "2026-08-13", label: "Thu", reveals: 712, credits: 941 },
    { key: "2026-08-14", label: "Fri", reveals: 588, credits: 704 },
    { key: "2026-08-15", label: "Sat", reveals: 902, credits: 1_188 },
    { key: "2026-08-16", label: "Sun", reveals: 214, credits: 262 },
    { key: "2026-08-17", label: "Mon", reveals: 188, credits: 241 },
    { key: "2026-08-18", label: "Tue", reveals: 1_604, credits: 1_872 },
  ],
  maxCredits: 1_872,
  byType: [
    { revealType: "email", label: "Email", reveals: 3_604, credits: 3_604 },
    { revealType: "phone", label: "Phone", reveals: 1_208, credits: 3_624 },
  ],
  hasSpend: true,
};

// `pct` and `conversionPct` are WHOLE PERCENTS, the way the pure rollups compute them
// (Math.round((count / total) * 100)) — the components print them with a literal "%" and never scale.
// A fraction here renders "0.82%" where the truth is 82%.
export const DATA_HEALTH_ROLLUP = {
  rows: [
    { status: "valid", label: "Valid", tone: "success" as const, count: 39_460, pct: 82 },
    { status: "catch_all", label: "Catch-all", tone: "warning" as const, count: 2_887, pct: 6 },
    { status: "unverified", label: "Unverified", tone: "muted" as const, count: 2_406, pct: 5 },
    { status: "risky", label: "Risky", tone: "warning" as const, count: 1_925, pct: 4 },
    { status: "invalid", label: "Invalid", tone: "danger" as const, count: 1_444, pct: 3 },
  ],
  valid: 39_460,
  withEmail: 44_270,
  unverified: 2_406,
  total: 48_120,
};

export const FUNNEL_ROLLUP = {
  primary: [
    { status: "new", label: "New", count: 48_120, conversionPct: 100 },
    { status: "in_sequence", label: "In sequence", count: 1_284, conversionPct: 3 },
    { status: "replied", label: "Replied", count: 214, conversionPct: 17 },
    { status: "meeting_booked", label: "Meeting booked", count: 38, conversionPct: 18 },
  ],
  secondary: [
    { status: "disqualified", label: "Disqualified", count: 402, conversionPct: 1 },
    { status: "unsubscribed", label: "Unsubscribed", count: 96, conversionPct: 0 },
  ],
  total: 48_120,
  maxCount: 48_120,
};

export const TEAM_ROLLUP = {
  rows: [
    { userId: "u_priya", label: "Member 4f2a", revealed: 1_884, credits: 2_402, engaged: 412 },
    { userId: "u_marta", label: "Member 2b88", revealed: 1_526, credits: 1_810, engaged: 288 },
    { userId: "u_daniel", label: "Member 9c17", revealed: 1_402, credits: 1_808, engaged: 341 },
  ],
  members: 3,
  totalRevealed: 4_812,
};

export const TENANT_PLAN = {
  tier: "team",
  planName: "Team",
  seatsUsed: 14,
  seatLimit: 25,
  workspacesUsed: 3,
  workspaceLimit: 5,
  balance: 12_480,
  features: { search: true, exports: true, crm_sync: true, api: true },
};

// ── chart data ──────────────────────────────────────────────────────────────────────────────────────────
export const BAR_DATA = [
  { key: "mon", label: "Mon", value: 812, caption: "604 reveals" },
  { key: "tue", label: "Tue", value: 941, caption: "712 reveals" },
  { key: "wed", label: "Wed", value: 704, caption: "588 reveals" },
  { key: "thu", label: "Thu", value: 1_188, caption: "902 reveals", accent: true },
  { key: "fri", label: "Fri", value: 262, caption: "214 reveals", muted: true },
  { key: "sat", label: "Sat", value: 241, caption: "188 reveals", muted: true },
  { key: "sun", label: "Sun", value: 1_872, caption: "1,604 reveals" },
];

export const LINE_DATA = [
  { key: "w1", label: "21 Jul", value: 62 },
  { key: "w2", label: "28 Jul", value: 64 },
  { key: "w3", label: "4 Aug", value: 66 },
  { key: "w4", label: "11 Aug", value: 65 },
  { key: "w5", label: "18 Aug", value: 68 },
];

export const FUNNEL_DATA = [
  { key: "new", label: "New", count: 48_120, conversionPct: 100 },
  { key: "in_sequence", label: "In sequence", count: 1_284, conversionPct: 3 },
  { key: "replied", label: "Replied", count: 214, conversionPct: 17 },
  { key: "meeting_booked", label: "Meeting booked", count: 38, conversionPct: 18 },
];

export const DISTRIBUTION = [
  { key: "valid", label: "Valid", value: 39_460, tone: "success" as const },
  { key: "catch_all", label: "Catch-all", value: 2_887, tone: "warning" as const },
  { key: "unverified", label: "Unverified", value: 2_406, tone: "muted" as const },
  { key: "risky", label: "Risky", value: 1_925, tone: "warning" as const },
  { key: "invalid", label: "Invalid", value: 1_444, tone: "danger" as const },
];

// ── lists / imports ─────────────────────────────────────────────────────────────────────────────────────
export const LIST = {
  id: "li_emea",
  name: "EMEA new business",
  kind: "static",
  memberCount: 1_284,
  sharedWith: "workspace",
  updatedAt: "2026-08-18T08:47:00Z",
};

export const CSV_HEADERS = [
  "First name",
  "Last name",
  "Work email",
  "Job title",
  "Company",
  "Company domain",
  "LinkedIn",
  "Country",
];

export const MAPPING = {
  firstName: "First name",
  lastName: "Last name",
  email: "Work email",
  jobTitle: "Job title",
  accountName: "Company",
  accountDomain: "Company domain",
  linkedinUrl: "LinkedIn",
  locationCountry: "Country",
};

export const MAPPING_TEMPLATES = [
  { id: "mt_01", name: "Salesforce export", mapping: MAPPING, createdAt: "2026-06-02T10:00:00Z" },
  { id: "mt_02", name: "HubSpot export", mapping: MAPPING, createdAt: "2026-07-14T11:00:00Z" },
];
