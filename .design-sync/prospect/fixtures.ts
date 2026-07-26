// fixtures.ts — the dataset every prospect preview card renders against.
//
// The slice's components are real and unmodified; only the network under them is replaced (see
// ./stubs/authClient.ts, which routes requests to the payloads below). So the fixture shapes must match
// the API contract exactly — they are typed against @leadwolf/types for that reason, and a drift in the
// contract shows up here as a type error rather than as a silently empty card.
//
// Content rules: realistic B2B sales-intelligence data, never foo/bar. The rows deliberately spread across
// every enum the grid renders differently — each email status, each seniority level, each outreach status,
// revealed and unrevealed, with and without phone — so a card shows the real variety of the surface instead
// of 24 identical rows.

import type {
  AccountFacetCount,
  AccountQuery,
  ContactHit,
  ContactQuery,
  FacetCount,
  List,
  MaskedAccount,
  PipelineStage,
  RevealCosts,
  RevealedContact,
  SavedSearch,
  Suggestion,
  Tag,
} from "@leadwolf/types";
import type { CustomFieldValueDto, ScoreHistoryRow } from "../../apps/web/src/features/prospect/api";
import type { OwnerOption } from "../../apps/web/src/features/prospect/components/FilterPanel";
import type { ProspectBulkSelection } from "../../apps/web/src/features/prospect/hooks/useBulkSelection";
import type { RecentSearch } from "../../apps/web/src/features/prospect/hooks/useRecentSearches";
import type { ProspectFilter } from "../../apps/web/src/features/prospect/types";

// Stable ids — a uuid per row, hand-written so the fixture is deterministic across builds (the sync anchor
// hashes rendered output; a generated id would re-key every component on every run).
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const USER_ID = uid(900);
const iso = (day: number, hour = 9) =>
  `2026-0${day > 30 ? 7 : 6}-${String(day > 30 ? day - 30 : day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;

// ── Contacts ────────────────────────────────────────────────────────────────────────────────────────────
type Row = Omit<ContactHit, "id" | "createdAt"> & { id: string; createdAt: string };

export const CONTACTS: ContactHit[] = (
  [
    ["Priya", "Raghunathan", "VP of Revenue Operations", "ramp.com", "valid", "mobile", true, true, "vp", "Operations", "United States", "New York", "replied", true],
    ["Daniel", "Okonkwo", "Chief Technology Officer", "vanta.com", "valid", "direct", true, true, "c_suite", "Engineering", "United States", "San Francisco", "meeting_booked", true],
    ["Mareike", "Vogel", "Director of Demand Generation", "figma.com", "risky", "unknown", true, true, "director", "Marketing", "Germany", "Berlin", "in_sequence", false],
    ["Tomás", "Iglesias", "Head of Platform Engineering", "datadoghq.com", "valid", null, true, false, "director", "Engineering", "Spain", "Madrid", "new", false],
    ["Aisling", "Byrne", "Senior Product Manager", "linear.app", "valid", "mobile", true, true, "manager", "Product", "Ireland", "Dublin", "in_sequence", true],
    ["Kenji", "Watanabe", "Chief Financial Officer", "mercury.com", "catch_all", "hq", true, true, "c_suite", "Finance", "Japan", "Tokyo", "nurture", false],
    ["Rachel", "Adeyemi", "VP of People", "rippling.com", "valid", "mobile", true, true, "vp", "People", "United States", "Austin", "replied", true],
    ["Lukas", "Novák", "Staff Software Engineer", "retool.com", "unverified", null, true, false, "ic", "Engineering", "Czechia", "Prague", "new", false],
    ["Ingrid", "Halvorsen", "Director of Customer Success", "gong.io", "valid", "direct", true, true, "director", "Operations", "Norway", "Oslo", "meeting_booked", true],
    ["Marcus", "Delacroix", "Head of Sales Development", "brex.com", "invalid", null, false, false, "manager", "Sales", "France", "Paris", "disqualified", false],
    ["Sofia", "Marchetti", "Chief Revenue Officer", "notion.so", "valid", "mobile", true, true, "c_suite", "Sales", "Italy", "Milan", "replied", true],
    ["Arjun", "Balasubramanian", "Principal Data Scientist", "snowflake.com", "valid", null, true, false, "ic", "Engineering", "India", "Bengaluru", "in_sequence", false],
    ["Hannah", "Lindqvist", "VP of Product Marketing", "airtable.com", "risky", "landline", true, true, "vp", "Marketing", "Sweden", "Stockholm", "nurture", false],
    ["Olumide", "Bakare", "Engineering Manager, Payments", "stripe.com", "valid", "mobile", true, true, "manager", "Engineering", "United Kingdom", "London", "new", true],
    ["Camila", "Restrepo", "Director of Finance Operations", "zip.co", "unknown", null, true, false, "director", "Finance", "Colombia", "Bogotá", "new", false],
    ["Yuki", "Tanaka", "Head of Design Systems", "figma.com", "valid", "direct", true, true, "director", "Product", "Japan", "Osaka", "in_sequence", true],
    ["Nathan", "Achterberg", "Account Executive, Enterprise", "gong.io", "valid", "mobile", true, true, "ic", "Sales", "Netherlands", "Amsterdam", "unsubscribed", false],
    ["Fatima", "El-Sayed", "VP of Engineering", "vanta.com", "valid", "direct", true, true, "vp", "Engineering", "United Arab Emirates", "Dubai", "meeting_booked", true],
    ["Grzegorz", "Kowalczyk", "Senior DevOps Engineer", "datadoghq.com", "unverified", null, true, false, "ic", "Engineering", "Poland", "Kraków", "new", false],
    ["Beatriz", "Fonseca", "Chief Operating Officer", "mercury.com", "valid", "hq", true, true, "c_suite", "Operations", "Brazil", "São Paulo", "nurture", false],
    ["Callum", "Fraser", "Growth Marketing Lead", "linear.app", "risky", null, true, false, "manager", "Marketing", "United Kingdom", "Edinburgh", "in_sequence", false],
    ["Anneke", "de Vries", "Director of Security Engineering", "rippling.com", "valid", "mobile", true, true, "director", "Engineering", "Netherlands", "Utrecht", "replied", true],
    ["Ravi", "Chandrasekhar", "Partnerships Manager", "notion.so", "catch_all", "voip", true, true, "manager", "Sales", "Singapore", "Singapore", "new", false],
    ["Elena", "Petrova", "Recruiting Operations Specialist", "brex.com", "valid", null, true, false, "other", "People", "Bulgaria", "Sofia", "nurture", false],
  ] as const
).map((r, i) => {
  const [
    firstName, lastName, jobTitle, emailDomain, emailStatus, phoneStatus,
    hasEmail, hasPhone, seniorityLevel, department, locationCountry, locationCity,
    outreachStatus, isRevealed,
  ] = r;
  return {
    id: uid(i + 1),
    firstName,
    lastName,
    jobTitle,
    emailDomain,
    emailStatus,
    phoneStatus,
    phoneLineType: phoneStatus === "mobile" ? "mobile" : phoneStatus === "hq" ? "landline" : null,
    hasEmail,
    hasPhone,
    seniorityLevel,
    department,
    locationCountry,
    locationCity,
    outreachStatus,
    isRevealed,
    ownerUserId: isRevealed ? USER_ID : null,
    createdAt: iso(((i * 3) % 28) + 1, 8 + (i % 9)),
    lastVerifiedAt: isRevealed ? iso(((i * 5) % 28) + 1, 11) : null,
    revealedTypes: isRevealed ? (hasPhone ? ["email", "phone"] : ["email"]) : [],
  } as Row;
}) as ContactHit[];

export const TOTAL_CONTACTS = 4_812;

// ── Accounts ────────────────────────────────────────────────────────────────────────────────────────────
export const ACCOUNTS: MaskedAccount[] = (
  [
    ["Ramp", "ramp.com", "Financial Services", "Spend Management", 1_100, "$100M–$250M", "United States", "New York", ["React", "Kubernetes", "Snowflake"], "series_d", "growth", 2019, 92, 148, 41],
    ["Vanta", "vanta.com", "Software", "Security & Compliance", 720, "$50M–$100M", "United States", "San Francisco", ["TypeScript", "AWS", "Datadog"], "series_c", "growth", 2018, 88, 96, 27],
    ["Figma", "figma.com", "Software", "Design Tools", 1_600, "$500M–$1B", "United States", "San Francisco", ["React", "WebGL", "GCP"], "acquired", "late", 2012, 85, 212, 63],
    ["Datadog", "datadoghq.com", "Software", "Observability", 5_800, "$2B+", "United States", "New York", ["Go", "Kubernetes", "Kafka"], "public", "public", 2010, 79, 304, 88],
    ["Linear", "linear.app", "Software", "Project Management", 180, "$10M–$50M", "United States", "San Francisco", ["TypeScript", "GraphQL", "Postgres"], "series_b", "early", 2019, 81, 44, 12],
    ["Mercury", "mercury.com", "Financial Services", "Business Banking", 850, "$100M–$250M", "United States", "San Francisco", ["Haskell", "AWS", "Postgres"], "series_c", "growth", 2017, 76, 87, 19],
    ["Rippling", "rippling.com", "Software", "HR & Payroll", 3_400, "$500M–$1B", "United States", "San Francisco", ["React", "Django", "AWS"], "series_f", "late", 2016, 90, 268, 74],
    ["Snowflake", "snowflake.com", "Software", "Data Platform", 7_200, "$2B+", "United States", "Bozeman", ["Java", "AWS", "Kubernetes"], "public", "public", 2012, 72, 391, 102],
    ["Gong", "gong.io", "Software", "Revenue Intelligence", 1_250, "$250M–$500M", "Israel", "Tel Aviv", ["Python", "AWS", "Snowflake"], "series_e", "late", 2015, 87, 131, 38],
    ["Brex", "brex.com", "Financial Services", "Corporate Cards", 1_050, "$250M–$500M", "United States", "New York", ["TypeScript", "Kotlin", "GCP"], "series_d", "growth", 2017, 83, 119, 31],
  ] as const
).map((a, i) => {
  const [name, domain, industry, subIndustry, employeeCount, revenueRange, hqCountry, hqCity, technologies, fundingStage, companyStage, foundedYear, icpFitScore, contactCount, revealedContactCount] = a;
  return {
    id: uid(200 + i),
    name,
    domain,
    industry,
    subIndustry,
    employeeCount,
    revenueRange,
    hqCountry,
    hqCity,
    technologies: [...technologies],
    fundingStage,
    companyStage,
    foundedYear,
    icpFitScore,
    contactCount,
    revealedContactCount,
    createdAt: iso((i * 2) + 3, 10),
  } satisfies MaskedAccount;
});

export const TOTAL_ACCOUNTS = 1_284;

// ── Facet counts ────────────────────────────────────────────────────────────────────────────────────────
const facet = (field: FacetCount["field"], pairs: [string, string, number][]): FacetCount[] =>
  pairs.map(([value, displayLabel, count]) => ({ field, value, displayLabel, count }));

export const CONTACT_FACETS: FacetCount[] = [
  ...facet("seniority", [
    ["c_suite", "C-suite", 412],
    ["vp", "VP", 688],
    ["director", "Director", 1_104],
    ["manager", "Manager", 1_390],
    ["ic", "Individual contributor", 1_002],
    ["other", "Other", 216],
  ]),
  ...facet("department", [
    ["Engineering", "Engineering", 1_642],
    ["Sales", "Sales", 968],
    ["Marketing", "Marketing", 731],
    ["Operations", "Operations", 604],
    ["Finance", "Finance", 448],
    ["Product", "Product", 267],
    ["People", "People", 152],
  ]),
  ...facet("email_status", [
    ["valid", "Valid", 3_106],
    ["risky", "Risky", 592],
    ["catch_all", "Catch-all", 401],
    ["unverified", "Unverified", 488],
    ["invalid", "Invalid", 225],
  ]),
  ...facet("outreach_status", [
    ["new", "New", 2_140],
    ["in_sequence", "In sequence", 1_002],
    ["replied", "Replied", 611],
    ["meeting_booked", "Meeting booked", 288],
    ["nurture", "Nurture", 496],
    ["disqualified", "Disqualified", 187],
    ["unsubscribed", "Unsubscribed", 88],
  ]),
  ...facet("company", [
    ["Datadog", "Datadog", 304],
    ["Snowflake", "Snowflake", 391],
    ["Rippling", "Rippling", 268],
    ["Figma", "Figma", 212],
    ["Ramp", "Ramp", 148],
    ["Gong", "Gong", 131],
  ]),
  ...facet("location", [
    ["United States", "United States", 2_918],
    ["United Kingdom", "United Kingdom", 486],
    ["Germany", "Germany", 311],
    ["India", "India", 274],
    ["Netherlands", "Netherlands", 196],
  ]),
  ...facet("industry", [
    ["Software", "Software", 3_204],
    ["Financial Services", "Financial Services", 902],
    ["Healthcare", "Healthcare", 371],
    ["Manufacturing", "Manufacturing", 208],
  ]),
  ...facet("technology", [
    ["React", "React", 1_488],
    ["Kubernetes", "Kubernetes", 1_102],
    ["Snowflake", "Snowflake", 744],
    ["Datadog", "Datadog", 512],
  ]),
  ...facet("title", [
    ["vp_engineering", "VP of Engineering", 188],
    ["cto", "Chief Technology Officer", 141],
    ["head_of_revops", "Head of Revenue Operations", 96],
  ]),
  ...facet("owner", [
    [USER_ID, "You", 344],
    [uid(901), "Dana Whitfield", 271],
    [uid(902), "Samuel Ortega", 198],
  ]),
  ...facet("source", [
    ["import", "CSV import", 2_460],
    ["extension", "Browser extension", 1_188],
    ["enrichment", "Enrichment", 1_164],
  ]),
  ...facet("funding_stage", [
    ["series_c", "Series C", 604],
    ["series_d", "Series D", 488],
    ["public", "Public", 1_002],
  ]),
  ...facet("company_stage", [
    ["growth", "Growth", 1_871],
    ["late", "Late stage", 1_244],
    ["public", "Public", 1_002],
  ]),
  ...facet("skill", [
    ["distributed_systems", "Distributed systems", 402],
    ["demand_generation", "Demand generation", 288],
  ]),
];

export const ACCOUNT_FACETS: AccountFacetCount[] = [
  { field: "industry", value: "Software", displayLabel: "Software", count: 812 },
  { field: "industry", value: "Financial Services", displayLabel: "Financial Services", count: 244 },
  { field: "industry", value: "Healthcare", displayLabel: "Healthcare", count: 128 },
  { field: "sub_industry", value: "Security & Compliance", displayLabel: "Security & Compliance", count: 141 },
  { field: "sub_industry", value: "Observability", displayLabel: "Observability", count: 96 },
  { field: "technology", value: "Kubernetes", displayLabel: "Kubernetes", count: 588 },
  { field: "technology", value: "Snowflake", displayLabel: "Snowflake", count: 402 },
  { field: "technology", value: "React", displayLabel: "React", count: 731 },
  { field: "funding_stage", value: "series_c", displayLabel: "Series C", count: 204 },
  { field: "funding_stage", value: "series_d", displayLabel: "Series D", count: 166 },
  { field: "funding_stage", value: "public", displayLabel: "Public", count: 88 },
  { field: "company_stage", value: "growth", displayLabel: "Growth", count: 502 },
  { field: "company_stage", value: "late", displayLabel: "Late stage", count: 318 },
  { field: "revenue_range", value: "$100M–$250M", displayLabel: "$100M–$250M", count: 241 },
  { field: "revenue_range", value: "$2B+", displayLabel: "$2B+", count: 74 },
  { field: "hq_country", value: "United States", displayLabel: "United States", count: 806 },
  { field: "hq_country", value: "United Kingdom", displayLabel: "United Kingdom", count: 142 },
  { field: "employee_band", value: "201-500", displayLabel: "201–500", count: 288 },
  { field: "employee_band", value: "1001-5000", displayLabel: "1,001–5,000", count: 196 },
];

// ── Typeahead ───────────────────────────────────────────────────────────────────────────────────────────
export const SUGGESTIONS: Suggestion[] = [
  { value: "vp_engineering", displayLabel: "VP of Engineering", count: 188, canonicalId: "vp_engineering" },
  { value: "vp_marketing", displayLabel: "VP of Marketing", count: 121, canonicalId: "vp_marketing" },
  { value: "vp_sales", displayLabel: "VP of Sales", count: 164, canonicalId: "vp_sales" },
  { value: "vp_product", displayLabel: "VP of Product", count: 88, canonicalId: "vp_product" },
  { value: "vp_finance", displayLabel: "VP of Finance", count: 52, canonicalId: "vp_finance" },
];

// ── Workspace resources ─────────────────────────────────────────────────────────────────────────────────
export const TAGS: Tag[] = [
  { id: uid(300), name: "Champion", color: "success", usageCount: 84, createdAt: iso(4) },
  { id: uid(301), name: "Q3 target", color: "accent", usageCount: 212, createdAt: iso(6) },
  { id: uid(302), name: "Competitor user", color: "warning", usageCount: 47, createdAt: iso(9) },
  { id: uid(303), name: "Do not contact", color: "danger", usageCount: 19, createdAt: iso(11) },
  { id: uid(304), name: "Webinar attendee", color: "info", usageCount: 133, createdAt: iso(14) },
  { id: uid(305), name: "Renewal risk", color: "neutral", usageCount: 28, createdAt: iso(17) },
];

export const SAVED_SEARCHES: SavedSearch[] = [
  {
    id: uid(400), name: "VPs of Eng at Series C+ SaaS", visibility: "workspace",
    ownerUserId: USER_ID, isOwner: true, createdAt: iso(5), updatedAt: iso(21),
    filters: { text: "", sort: "relevance", limit: 50, filters: [
      { kind: "term", field: "seniority", op: "include", values: ["vp"] },
      { kind: "term", field: "department", op: "include", values: ["Engineering"] },
    ] },
  },
  {
    id: uid(401), name: "My prospects — replied", visibility: "private",
    ownerUserId: USER_ID, isOwner: true, createdAt: iso(8), updatedAt: iso(24),
    filters: { text: "", sort: "created_desc", limit: 50, filters: [
      { kind: "term", field: "owner", op: "include", values: [USER_ID] },
      { kind: "term", field: "outreach_status", op: "include", values: ["replied"] },
    ] },
  },
  {
    id: uid(402), name: "Fintech C-suite, verified email", visibility: "workspace",
    ownerUserId: uid(901), isOwner: false, createdAt: iso(12), updatedAt: iso(19),
    filters: { text: "", sort: "score_desc", limit: 50, filters: [
      { kind: "term", field: "seniority", op: "include", values: ["c_suite"] },
      { kind: "term", field: "industry", op: "include", values: ["Financial Services"] },
      { kind: "bool", field: "has_email", value: true },
    ] },
  },
  {
    id: uid(403), name: "Never contacted, US only", visibility: "workspace",
    ownerUserId: USER_ID, isOwner: true, createdAt: iso(15), updatedAt: iso(26),
    filters: { text: "", sort: "relevance", limit: 50, filters: [
      { kind: "bool", field: "never_contacted", value: true },
      { kind: "term", field: "location", op: "include", values: ["United States"] },
    ] },
  },
];

export const STAGES: PipelineStage[] = [
  { id: uid(500), name: "Prospecting", mapsToStatus: "new", ordering: 0, isDefault: true, archived: false, createdAt: iso(2), updatedAt: iso(2) },
  { id: uid(501), name: "Outreach sent", mapsToStatus: "in_sequence", ordering: 1, isDefault: false, archived: false, createdAt: iso(2), updatedAt: iso(2) },
  { id: uid(502), name: "Engaged", mapsToStatus: "replied", ordering: 2, isDefault: false, archived: false, createdAt: iso(2), updatedAt: iso(2) },
  { id: uid(503), name: "Meeting booked", mapsToStatus: "meeting_booked", ordering: 3, isDefault: false, archived: false, createdAt: iso(2), updatedAt: iso(2) },
  { id: uid(504), name: "Nurture", mapsToStatus: "nurture", ordering: 4, isDefault: false, archived: false, createdAt: iso(2), updatedAt: iso(2) },
  { id: uid(505), name: "Closed lost", mapsToStatus: "disqualified", ordering: 5, isDefault: false, archived: false, createdAt: iso(2), updatedAt: iso(2) },
];

export const LISTS: List[] = [
  { id: uid(600), name: "Q3 enterprise push", description: "Named accounts over 1,000 seats", ownerUserId: USER_ID, isOwner: true, kind: "static", savedSearchId: null, memberCount: 284, createdAt: iso(7), updatedAt: iso(23) },
  { id: uid(601), name: "Webinar follow-up — May", description: null, ownerUserId: USER_ID, isOwner: true, kind: "static", savedSearchId: null, memberCount: 96, createdAt: iso(10), updatedAt: iso(20) },
  { id: uid(602), name: "VPs of Eng (live)", description: "Kept in sync with the saved search", ownerUserId: USER_ID, isOwner: true, kind: "dynamic", savedSearchId: uid(400), memberCount: 688, createdAt: iso(13), updatedAt: iso(27) },
  { id: uid(603), name: "Competitive displacement", description: "Currently on a competitor", ownerUserId: uid(901), isOwner: false, kind: "static", savedSearchId: null, memberCount: 41, createdAt: iso(16), updatedAt: iso(22) },
  { id: uid(604), name: "Champions to re-engage", description: null, ownerUserId: USER_ID, isOwner: true, kind: "static", savedSearchId: null, memberCount: 58, createdAt: iso(18), updatedAt: iso(25) },
];

export const SEQUENCES = [
  { id: uid(700), name: "Enterprise outbound — 6 touch" },
  { id: uid(701), name: "Webinar follow-up" },
  { id: uid(702), name: "Re-engage closed lost" },
  { id: uid(703), name: "Product-led trial nudge" },
];

// ── Bulk reveal jobs ────────────────────────────────────────────────────────────────────────────────────
// Two DIFFERENT shapes on the same route family, and the dialog calls .toLocaleString() on the numbers, so
// a missing field throws rather than rendering blank:
//   POST /contacts/reveal-jobs        → RevealJobEstimate (creates the job, arms the confirm gate)
//   GET  /contacts/reveal-jobs/:id    → RevealJobSummary  (progress)
//   POST /contacts/reveal-jobs/:id/confirm → RevealJobSummary (the money gate)
const JOB_ID = "00000000-0000-4000-8000-000000000777";

export const REVEAL_JOB_ESTIMATE = {
  jobId: JOB_ID,
  revealType: "email",
  totalContacts: 4_812,
  billableContacts: 3_604,
  alreadyOwnedContacts: 1_208,
  projectedMaxCredits: 3_604,
  balance: 12_480,
  balanceAfter: 8_876,
  sufficient: true,
};

export const REVEAL_JOB_SUMMARY = {
  id: JOB_ID,
  revealType: "email",
  status: "awaiting_confirmation",
  totalContacts: 4_812,
  processedContacts: 0,
  revealedContacts: 0,
  alreadyOwnedContacts: 1_208,
  suppressedContacts: 0,
  failedContacts: 0,
  creditEstimate: 3_604,
  creditSpent: 0,
  resultReady: false,
  createdAt: iso(26, 9),
  startedAt: null,
  completedAt: null,
};

// ── Billing ─────────────────────────────────────────────────────────────────────────────────────────────
export const CREDIT_BALANCE = 12_480;
export const REVEAL_COSTS: RevealCosts = { email: 1, phone: 3, full_profile: 4 };

// ── Reveal ──────────────────────────────────────────────────────────────────────────────────────────────
const revealedFor = (i: number, email: string, phone: string | null): RevealedContact => ({
  contactId: CONTACTS[i].id,
  email,
  phone,
  linkedinUrl: `https://www.linkedin.com/in/${CONTACTS[i].firstName?.toLowerCase()}-${CONTACTS[i].lastName?.toLowerCase().replace(/\s+/g, "-")}`,
  emailStatus: "valid",
  phoneStatus: phone ? "mobile" : null,
  phoneLineType: phone ? "mobile" : null,
  ownedTypes: phone ? ["email", "phone"] : ["email"],
  revealedFields: phone ? ["email", "phone"] : ["email"],
  history: [
    { revealType: "email", revealedAt: iso(20, 14), creditsConsumed: 1 },
    ...(phone ? [{ revealType: "phone" as const, revealedAt: iso(21, 16), creditsConsumed: 3 }] : []),
  ] as RevealedContact["history"],
});

export const REVEALED: RevealedContact[] = [
  revealedFor(0, "priya.raghunathan@ramp.com", "+1 415 555 0142"),
  revealedFor(1, "daniel.okonkwo@vanta.com", "+1 628 555 0198"),
  revealedFor(4, "aisling.byrne@linear.app", "+353 1 555 0111"),
  revealedFor(6, "rachel.adeyemi@rippling.com", "+1 512 555 0176"),
  revealedFor(8, "ingrid.halvorsen@gong.io", "+47 21 555 099"),
  revealedFor(10, "sofia.marchetti@notion.so", "+39 02 555 0134"),
  revealedFor(13, "olumide.bakare@stripe.com", "+44 20 5550 1882"),
  revealedFor(15, "yuki.tanaka@figma.com", "+81 6 5550 2211"),
  revealedFor(17, "fatima.elsayed@vanta.com", "+971 4 555 0166"),
  revealedFor(21, "anneke.devries@rippling.com", "+31 30 555 0120"),
];

// ── Detail panel feeds ──────────────────────────────────────────────────────────────────────────────────
// Field names matter here: the timeline reads `activityType`, `note` and `occurredAt` (and calls
// .replace() on activityType for unmapped values), so a near-miss shape throws rather than degrading.
const activity = (
  n: number,
  activityType: string,
  channel: string,
  note: string | null,
  at: string,
  bySystem = false,
) => ({
  id: uid(n),
  contactId: CONTACTS[0].id,
  actorUserId: bySystem ? null : USER_ID,
  activityType,
  channel,
  outcome: null,
  note,
  occurredAt: at,
});

export const ACTIVITIES = [
  activity(805, "note_added", "note", "Evaluating against Datadog; decision by end of quarter.", iso(26, 16)),
  activity(804, "meeting_held", "meeting", "Discovery call — 30 min, brought their platform lead.", iso(26, 15)),
  activity(803, "email_replied", "email", "“Can you send pricing for 400 seats?”", iso(25, 8), true),
  activity(802, "email_clicked", "email", "Pricing page", iso(24, 11), true),
  activity(801, "email_opened", "email", null, iso(24, 11), true),
  activity(800, "email_sent", "email", "Following up on your Kubernetes migration", iso(24, 9)),
] as unknown as import("@leadwolf/types").ActivityRow[];

export const SCORES: ScoreHistoryRow[] = [
  { id: uid(810), icpFit: 88, intentScore: 72, engagementScore: 64, compositeScore: 78, scoredAt: iso(26, 6) },
  { id: uid(811), icpFit: 88, intentScore: 61, engagementScore: 48, compositeScore: 70, scoredAt: iso(19, 6) },
  { id: uid(812), icpFit: 84, intentScore: 55, engagementScore: 31, compositeScore: 62, scoredAt: iso(12, 6) },
  { id: uid(813), icpFit: 84, intentScore: 42, engagementScore: 18, compositeScore: 54, scoredAt: iso(5, 6) },
];

// Shape is {key, label, fieldType, options, value} — `fieldType`, not `type`, and `options` is required
// (null for everything except select).
export const CUSTOM_FIELDS = [
  { key: "account_tier", label: "Account tier", fieldType: "select", options: ["Tier 1", "Tier 2", "Tier 3"], value: "Tier 1" },
  { key: "renewal_date", label: "Renewal date", fieldType: "date", options: null, value: "2026-11-30" },
  { key: "seats", label: "Seats in play", fieldType: "number", options: null, value: 450 },
  { key: "champion", label: "Internal champion", fieldType: "text", options: null, value: "Priya Raghunathan" },
  { key: "security_review", label: "Security review cleared", fieldType: "boolean", options: null, value: true },
] as unknown as CustomFieldValueDto[];

// ── Preview support ─────────────────────────────────────────────────────────────────────────────────────
// Prop values for the standalone component cards. The page-level card drives everything through the fetch
// stub, but a card for FilterPanel or BulkActionBar has to be handed the state the page would own — these
// are that state, shaped exactly like the real thing.

/** An ACTIVE query, not an empty one: panels look identical to their empty state otherwise. */
export const CONTACT_QUERY: ContactQuery = {
  text: "",
  sort: "relevance",
  limit: 50,
  filters: [
    { kind: "term", field: "seniority", op: "include", values: ["vp", "c_suite"] },
    { kind: "term", field: "department", op: "include", values: ["Engineering"] },
    { kind: "bool", field: "has_email", value: true },
  ],
};

export const ACCOUNT_QUERY: AccountQuery = {
  text: "",
  sort: "relevance",
  limit: 50,
  filters: [
    { kind: "term", field: "industry", op: "include", values: ["Software"] },
    { kind: "term", field: "technology", op: "include", values: ["Kubernetes"] },
  ],
};

/** The live per-option counts the rails render next to each facet value, keyed `${field}:${value}`. */
export const FACET_COUNTS = new Map<string, number>(
  CONTACT_FACETS.map((f) => [`${f.field}:${f.value}`, f.count]),
);
export const ACCOUNT_FACET_COUNTS = new Map<string, number>(
  ACCOUNT_FACETS.map((f) => [`${f.field}:${f.value}`, f.count]),
);

/** Teammates for the Owner facet — the page prepends "Me". */
export const OWNERS: OwnerOption[] = [
  { value: USER_ID, label: "Me" },
  { value: uid(901), label: "Dana Whitfield" },
  { value: uid(902), label: "Samuel Ortega" },
  { value: uid(903), label: "Ingrid Møller" },
];

/** The per-browser recent-search row (newest first). */
export const RECENTS: RecentSearch[] = [
  { id: "r1", label: "VP Engineering · United States", query: CONTACT_QUERY, at: 1_784_000_000_000 },
  { id: "r2", label: "“revenue operations”", query: { ...CONTACT_QUERY, text: "revenue operations", filters: [] }, at: 1_783_900_000_000 },
  { id: "r3", label: "Fintech · C-suite", query: { ...CONTACT_QUERY, filters: [{ kind: "term", field: "industry", op: "include", values: ["Financial Services"] }] }, at: 1_783_800_000_000 },
];

/** The client-side rail filter (the MVP faceted model FilterRail applies over loaded rows). */
export const PROSPECT_FILTER: ProspectFilter = {
  query: "",
  seniority: ["vp", "c_suite"],
  emailStatus: ["valid"],
  outreachStatus: [],
  tags: [TAGS[0].id],
  department: "Engineering",
  country: null,
  hasEmail: true,
  hasPhone: false,
};

/** A concrete selection model. The real one is a hook; a card needs a plain object with the same surface. */
export function selectionOf(ids: string[], opts: { allMatching?: boolean; matchTotal?: number } = {}): ProspectBulkSelection {
  const set = new Set(ids);
  return {
    selectedIds: set,
    count: opts.allMatching ? (opts.matchTotal ?? set.size) : set.size,
    isSelected: (id) => set.has(id),
    toggle: () => {},
    clear: () => {},
    setMany: () => {},
    allMatching: opts.allMatching ?? false,
    matchTotal: opts.allMatching ? (opts.matchTotal ?? TOTAL_CONTACTS) : null,
    selectAllMatching: () => {},
    toBulkSelection: () => (opts.allMatching ? { criteria: CONTACT_QUERY } : { contactIds: [...set] }),
  } as ProspectBulkSelection;
}

/** The tags assigned to one record — TagPicker's `assigned` (id/name/colour only). */
export const ASSIGNED_TAGS = TAGS.slice(0, 2).map(({ id, name, color }) => ({ id, name, color }));

/** The result columns the toolbar's column chooser toggles. */
export const COLUMNS = [
  { key: "name", label: "Name" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "seniority", label: "Seniority" },
  { key: "department", label: "Department" },
  { key: "location", label: "Location" },
  { key: "status", label: "Outreach status" },
];
export const VISIBLE_COLUMNS = ["name", "company", "email", "phone"];

// ── AI search ───────────────────────────────────────────────────────────────────────────────────────────
export const AI_SEARCH_RESPONSE = {
  query: {
    text: "",
    sort: "relevance",
    limit: 50,
    filters: [
      { kind: "term", field: "seniority", op: "include", values: ["vp", "c_suite"] },
      { kind: "term", field: "department", op: "include", values: ["Engineering"] },
      { kind: "term", field: "location", op: "include", values: ["United States"] },
      { kind: "bool", field: "has_email", value: true },
    ],
  },
  notes: "Interpreted “senior engineering leaders at US companies with a verified email”. Headcount was not filterable on contacts, so it was dropped.",
  usedRepair: false,
};
