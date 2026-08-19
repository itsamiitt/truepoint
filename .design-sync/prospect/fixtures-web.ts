// fixtures-web.ts — the workspace data every apps/web surface outside the prospect grid renders.
//
// Split from ../prospect/fixtures.ts, which stays focused on the contact/account search grid. Shapes mirror
// the zod schemas in @leadwolf/types and the per-feature `types.ts` files exactly, so the REAL components
// render populated state without an api.
//
// These exist because an EMPTY envelope is not enough for most of these surfaces: they read scalars and
// objects (`creditBalance.toLocaleString()`, `prefs.in_app`, `profile.name.trim()`), and a missing key is
// `undefined` on the very next line. Seven surfaces crashed exactly that way before this file existed.
//
// PII posture: every person here is invented and every domain is a reserved example domain.
//
// Timestamps are fixed constants. A card whose "3 minutes ago" changes on every capture churns its own
// render hash and clears its grade on every sync.

// ── home ────────────────────────────────────────────────────────────────────────────────────────────────
export const HOME_SUMMARY = {
  creditBalance: 12_480,
  burn: [
    { day: "2026-08-12", credits: 184 },
    { day: "2026-08-13", credits: 212 },
    { day: "2026-08-14", credits: 168 },
    { day: "2026-08-15", credits: 241 },
    { day: "2026-08-16", credits: 62 },
    { day: "2026-08-17", credits: 48 },
    { day: "2026-08-18", credits: 266 },
  ],
  recentReveals: [
    { id: "rv_01", contactId: "ct_01hq8m4pv7", revealType: "email", creditsConsumed: 1, revealedAt: "2026-08-18T09:12:00Z" },
    { id: "rv_02", contactId: "ct_01hq8m5rt2", revealType: "phone", creditsConsumed: 3, revealedAt: "2026-08-18T08:58:00Z" },
    { id: "rv_03", contactId: "ct_01hq8m6xk9", revealType: "email", creditsConsumed: 1, revealedAt: "2026-08-18T08:41:00Z" },
    { id: "rv_04", contactId: "ct_01hq8m7bn4", revealType: "email", creditsConsumed: 0, revealedAt: "2026-08-18T08:22:00Z" },
    { id: "rv_05", contactId: "ct_01hq8m8qq1", revealType: "phone", creditsConsumed: 3, revealedAt: "2026-08-17T17:04:00Z" },
  ],
  hotLeads: [
    { id: "ct_01hq8m4pv7", firstName: "Priya", lastName: "Raghunathan", jobTitle: "VP of Revenue Operations", emailDomain: "ramp.com", priorityScore: 92, outreachStatus: "replied", isRevealed: true },
    { id: "ct_01hq8m5rt2", firstName: "Daniel", lastName: "Okonkwo", jobTitle: "Chief Technology Officer", emailDomain: "vanta.com", priorityScore: 88, outreachStatus: "in_sequence", isRevealed: true },
    { id: "ct_01hq8m6xk9", firstName: "Aisling", lastName: "Byrne", jobTitle: "Senior Product Manager", emailDomain: "linear.app", priorityScore: 81, outreachStatus: "new", isRevealed: true },
    { id: "ct_01hq8m9zz3", firstName: "Mareike", lastName: "Vogel", jobTitle: "Director of Demand Generation", emailDomain: "figma.com", priorityScore: 78, outreachStatus: "new", isRevealed: false },
    { id: "ct_01hq8ma4t8", firstName: "Kenji", lastName: "Watanabe", jobTitle: "Chief Financial Officer", emailDomain: "mercury.com", priorityScore: 74, outreachStatus: "meeting_booked", isRevealed: false },
  ],
  recentImports: [
    { sourceName: "CSV import", sourceFile: "emea-prospects-q3.csv", contactCount: 4_820, importedAt: "2026-08-18T07:19:00Z" },
    { sourceName: "CSV import", sourceFile: "webinar-attendees.csv", contactCount: 312, importedAt: "2026-08-15T14:02:00Z" },
    { sourceName: "Extension", sourceFile: null, contactCount: 48, importedAt: "2026-08-14T11:36:00Z" },
  ],
  // providerName is an INTERNAL id; the UI renders sourceLabel(id), and every VENDOR id deliberately
  // collapses to "Data source" (packages/types/src/sourceLabel.ts). Which vendor supplied a field is a
  // commercial detail, so naming it in the product would turn every provider swap into a UI migration.
  // Sources the CUSTOMER owns keep their names — that asymmetry is the point, so the fixture shows both.
  enrichmentActivity: [
    { providerName: "zoominfo", status: "ok", cacheHit: false, calledAt: "2026-08-18T09:12:00Z" },
    { providerName: "hubspot", status: "ok", cacheHit: true, calledAt: "2026-08-18T09:11:00Z" },
    { providerName: "chrome_extension", status: "ok", cacheHit: false, calledAt: "2026-08-18T09:08:00Z" },
    { providerName: "apollo", status: "no_match", cacheHit: false, calledAt: "2026-08-18T09:04:00Z" },
    { providerName: "database", status: "ok", cacheHit: true, calledAt: "2026-08-18T08:58:00Z" },
    { providerName: "coresignal", status: "error", cacheHit: false, calledAt: "2026-08-18T08:55:00Z" },
  ],
  sequenceSnapshot: { activeSequences: 4, enrolled: 1_284, sent: 3_908, replied: 214 },
  activityFeed: [
    { id: "af_01", action: "contact.revealed", entityType: "contact", entityId: "ct_01hq8m4pv7", actorUserId: "u_priya", occurredAt: "2026-08-18T09:12:00Z" },
    { id: "af_02", action: "list.member_added", entityType: "list", entityId: "li_emea", actorUserId: "u_daniel", occurredAt: "2026-08-18T08:47:00Z" },
    { id: "af_03", action: "sequence.enrolled", entityType: "sequence", entityId: "sq_outbound", actorUserId: "u_priya", occurredAt: "2026-08-18T08:31:00Z" },
    { id: "af_04", action: "import.completed", entityType: "import", entityId: "imp_01hq8z1", actorUserId: null, occurredAt: "2026-08-18T07:19:00Z" },
    { id: "af_05", action: "contact.tagged", entityType: "contact", entityId: "ct_01hq8m5rt2", actorUserId: "u_marta", occurredAt: "2026-08-17T16:20:00Z" },
  ],
  todaysTasks: [
    { id: "tk_01", kind: "follow_up", contactId: "ct_01hq8m4pv7", dueAt: "2026-08-18T14:00:00Z" },
    { id: "tk_02", kind: "review_reply", contactId: "ct_01hq8m5rt2", dueAt: "2026-08-18T15:30:00Z" },
    { id: "tk_03", kind: "reveal", contactId: "ct_01hq8m9zz3", dueAt: "2026-08-18T17:00:00Z" },
    { id: "tk_04", kind: "custom", contactId: null, dueAt: "2026-08-18T18:00:00Z" },
  ],
  recentReplies: [
    { id: "rp_01", contactId: "ct_01hq8m4pv7", sequenceId: "sq_outbound", channel: "email", repliedAt: "2026-08-18T09:02:00Z" },
    { id: "rp_02", contactId: "ct_01hq8m6xk9", sequenceId: "sq_outbound", channel: "email", repliedAt: "2026-08-17T18:44:00Z" },
    { id: "rp_03", contactId: "ct_01hq8ma4t8", sequenceId: null, channel: "linkedin", repliedAt: "2026-08-17T12:10:00Z" },
  ],
};

// ── data health (the workspace data-quality rollup, same shape the admin fleet view uses per workspace) ──
const q = (total: number) => ({
  total,
  withName: Math.round(total * 0.99),
  withEmail: Math.round(total * 0.92),
  withPhone: Math.round(total * 0.41),
  withTitle: Math.round(total * 0.88),
  withCompany: Math.round(total * 0.96),
  withLinkedin: Math.round(total * 0.74),
  withLocation: Math.round(total * 0.81),
  emailValid: Math.round(total * 0.82),
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
  multiSourceContacts: Math.round(total * 0.31),
  conflictContacts: Math.round(total * 0.02),
});

export const DATA_QUALITY = q(48_120);

export const DATA_QUALITY_HISTORY = [
  { capturedAt: "2026-08-18T04:00:00Z", metrics: q(48_120) },
  { capturedAt: "2026-08-11T04:00:00Z", metrics: q(46_004) },
  { capturedAt: "2026-08-04T04:00:00Z", metrics: q(43_881) },
  { capturedAt: "2026-07-28T04:00:00Z", metrics: q(41_202) },
];

export const REVERIFICATION_RUNS = [
  { id: "vr_01", startedAt: "2026-08-18T02:00:00Z", finishedAt: "2026-08-18T02:41:00Z", scanned: 18_420, reverified: 16_902, errored: 141 },
  { id: "vr_02", startedAt: "2026-08-11T02:00:00Z", finishedAt: "2026-08-11T02:38:00Z", scanned: 17_004, reverified: 15_881, errored: 96 },
];

export const RETENTION_RUNS_WEB = [
  { id: "rr_01", dataClass: "provider_calls", mode: "enforce", candidateCount: 12_408, deletedCount: 12_408, cutoff: "2025-08-18T00:00:00Z", runStartedAt: "2026-08-18T03:00:00Z", runFinishedAt: "2026-08-18T03:04:00Z" },
  { id: "rr_02", dataClass: "activities", mode: "shadow", candidateCount: 8_814, deletedCount: 0, cutoff: "2024-08-18T00:00:00Z", runStartedAt: "2026-08-18T03:04:00Z", runFinishedAt: "2026-08-18T03:06:00Z" },
  { id: "rr_03", dataClass: "raw_captures", mode: "disabled", candidateCount: 0, deletedCount: 0, cutoff: null, runStartedAt: "2026-08-18T03:06:00Z", runFinishedAt: "2026-08-18T03:06:00Z" },
];

/** DuplicatePairView (packages/types/src/dedupReview.ts) — NAMES ONLY, by contract. The review identifies
 *  which record was auto-pointed at which canonical; it never carries the email or phone that made them
 *  match, because reveal is a separate metered path. */
export const DUPLICATE_PAIRS = [
  { duplicateId: "00000000-0000-4000-8000-00000000d101", duplicateName: "Priya Raghunathan", duplicateCreatedAt: "2026-08-17T09:20:00Z", canonicalId: "00000000-0000-4000-8000-00000000d001", canonicalName: "Priya Raghunathan" },
  { duplicateId: "00000000-0000-4000-8000-00000000d102", duplicateName: "Dan Okonkwo", duplicateCreatedAt: "2026-08-16T14:02:00Z", canonicalId: "00000000-0000-4000-8000-00000000d002", canonicalName: "Daniel Okonkwo" },
  { duplicateId: "00000000-0000-4000-8000-00000000d103", duplicateName: "A. Byrne", duplicateCreatedAt: "2026-08-15T11:41:00Z", canonicalId: "00000000-0000-4000-8000-00000000d005", canonicalName: "Aisling Byrne" },
];

/** MergePreview (packages/types/src/contactMerge.ts) — the side-by-side matrix the review drawer decides on.
 *  It is zod-PARSED by mergeApi, so a wrong field name is a thrown error, not a blank cell. Only the seven
 *  CONTACT_PROVENANCE_FIELDS are decidable; `survivorPinned` marks a value a human already asserted, which
 *  the merge cannot overwrite. */
export const MERGE_PREVIEW = {
  survivorContactId: "00000000-0000-4000-8000-00000000d001",
  loserContactId: "00000000-0000-4000-8000-00000000d101",
  fields: [
    { field: "firstName", survivorValue: "Priya", loserValue: "Priya", survivorPinned: false },
    { field: "lastName", survivorValue: "Raghunathan", loserValue: "Raghunathan", survivorPinned: false },
    { field: "jobTitle", survivorValue: "VP of Revenue Operations", loserValue: "VP RevOps", survivorPinned: true },
    { field: "seniorityLevel", survivorValue: "vp", loserValue: "vp", survivorPinned: false },
    { field: "department", survivorValue: "Operations", loserValue: null, survivorPinned: false },
    { field: "locationCountry", survivorValue: "United States", loserValue: "United States", survivorPinned: false },
    { field: "locationCity", survivorValue: null, loserValue: "New York", survivorPinned: false },
  ],
  childImpact: { list_members: 4, activities: 22, contact_reveals: 2, record_tags: 3, email_message: 11, email_thread: 4, scores: 1 },
};

// ── credits / billing ───────────────────────────────────────────────────────────────────────────────────
/** GET /credits/me is wrapped: the caller destructures `{ plan }` off the body. */
export const CREDITS_ME = {
  plan: {
    plan: "team",
    planName: "Team",
    seatLimit: 25,
    seatsUsed: 14,
    workspaceLimit: 5,
    workspacesUsed: 3,
    revealCreditBalance: 12_480,
    features: { search: true, exports: true, crm_sync: true, api: true },
  },
};

export const CREDIT_BALANCE = { balance: 12_480 };

/** GET /credits/usage is a keyset PAGE of individual reveals, not a rollup. `dataSource` is the
 *  RevealDataSource enum - apollo | zoominfo | linkedin | internal - and the table maps every VENDOR value to
 *  the same customer-facing "Data source"; an off-enum value falls through and prints the raw id. */
export const CREDIT_USAGE = {
  reveals: [
    { id: "00000000-0000-4000-8000-00000000e001", contactId: "00000000-0000-4000-8000-00000000d001", revealType: "email", dataSource: "zoominfo", creditsConsumed: 1, revealedAt: "2026-08-18T09:12:00Z", revealedByUserId: "u_priya" },
    { id: "00000000-0000-4000-8000-00000000e002", contactId: "00000000-0000-4000-8000-00000000d002", revealType: "phone", dataSource: "apollo", creditsConsumed: 3, revealedAt: "2026-08-18T08:58:00Z", revealedByUserId: "u_daniel" },
    { id: "00000000-0000-4000-8000-00000000e003", contactId: "00000000-0000-4000-8000-00000000d003", revealType: "email", dataSource: "zoominfo", creditsConsumed: 1, revealedAt: "2026-08-18T08:41:00Z", revealedByUserId: "u_priya" },
    { id: "00000000-0000-4000-8000-00000000e004", contactId: "00000000-0000-4000-8000-00000000d004", revealType: "email", dataSource: "internal", creditsConsumed: 0, revealedAt: "2026-08-18T08:22:00Z", revealedByUserId: "u_marta" },
  ],
  nextCursor: null,
};

export const CREDIT_LEDGER = {
  entries: [
    { id: "cl_01", entryType: "spend", delta: -1, balanceAfter: 12_480, reason: "Reveal — email", createdAt: "2026-08-18T09:12:00Z" },
    { id: "cl_02", entryType: "spend", delta: -12, balanceAfter: 12_481, reason: "Bulk reveal — 12 contacts", createdAt: "2026-08-18T08:44:00Z" },
    { id: "cl_03", entryType: "credit_back", delta: 3, balanceAfter: 12_493, reason: "Non-match refund — nothing on file", createdAt: "2026-08-18T08:44:00Z" },
    { id: "cl_04", entryType: "grant", delta: 12_000, balanceAfter: 12_490, reason: "Monthly plan grant — Team", createdAt: "2026-08-01T00:00:00Z" },
  ],
  nextCursor: null,
};

/** GET /credits/subscription is WRAPPED: the caller destructures `{ subscription }`, and a bare body reads
 *  as null - which renders the month-to-month default rather than the subscription that exists. */
export const SUBSCRIPTION = {
  plan: "team",
  planName: "Team",
  status: "active",
  term: "annual",
  currentPeriodEnd: "2027-02-01T00:00:00Z",
  cancelAtPeriodEnd: false,
  autoRenew: true,
};

export const REVEAL_COSTS = { email: 1, phone: 3 };

/** GET /pricing/plans + /pricing/credit-packs — publicPlanSchema / publicCreditPackSchema. `features` is the
 *  entitlement-flag MAP (a record of booleans), not a list of marketing bullets; money is integer cents,
 *  USD-authoritative. A null limit means unlimited; a null grant means no recurring grant.
 *
 *  These two routes are fetched with the GLOBAL fetch, not fetchWithAuth — the pricing page is public — which
 *  is why the stub shims globalThis.fetch as well as exporting fetchWithAuth. */
export const PUBLIC_PLANS = {
  plans: [
    { key: "free", name: "Free", seatLimit: 1, workspaceLimit: 1, monthlyCreditGrant: null, sortOrder: 1,
      features: { search: true, exports: false, crm_sync: false, api: false, sso: false } },
    { key: "community", name: "Community", seatLimit: 3, workspaceLimit: 1, monthlyCreditGrant: 250, sortOrder: 2,
      features: { search: true, exports: true, crm_sync: false, api: false, sso: false } },
    { key: "pro", name: "Pro", seatLimit: 10, workspaceLimit: 3, monthlyCreditGrant: 2_000, sortOrder: 3,
      features: { search: true, exports: true, crm_sync: true, api: true, sso: false } },
    { key: "team", name: "Team", seatLimit: 50, workspaceLimit: null, monthlyCreditGrant: 12_000, sortOrder: 4,
      features: { search: true, exports: true, crm_sync: true, api: true, sso: true } },
  ],
};

export const PUBLIC_PACKS = {
  packs: [
    { key: "pack_1k", name: "1,000 credits", credits: 1_000, priceCents: 24_900, currency: "USD", sortOrder: 1 },
    { key: "pack_5k", name: "5,000 credits", credits: 5_000, priceCents: 109_900, currency: "USD", sortOrder: 2 },
    { key: "pack_25k", name: "25,000 credits", credits: 25_000, priceCents: 479_900, currency: "USD", sortOrder: 3 },
  ],
};

// ── settings: user ──────────────────────────────────────────────────────────────────────────────────────
export const USER_PROFILE = {
  id: "00000000-0000-4000-8000-000000000301",
  name: "Priya Raghavan",
  email: "priya.raghavan@northwind.example",
  timezone: "Europe/London",
  locale: "en-GB",
  avatarUrl: null,
};

export const NOTIFICATION_PREFS = {
  reply: { in_app: true, email: true },
  task: { in_app: true, email: false },
  low_credit: { in_app: true, email: true },
  digest: { in_app: false, email: true },
};

// ── settings: tenant / security ─────────────────────────────────────────────────────────────────────────
export const ORGANIZATION = { name: "Northwind Logistics", logoUrl: "", region: "eu" };

/** AuthPolicy. `mfaEnforcement` is exactly off | optional | required - there is no
 *  "required_for_admins", and an off-enum value renders as "Off", which reads as a WEAKER posture than the
 *  one actually configured. Timeouts are SECONDS on the wire and the panel shows minutes. */
export const AUTH_POLICY = {
  mfaEnforcement: "required",
  allowedMethods: ["password", "sso", "passkey"],
  disableSocial: true,
  requireSso: false,
  ipAllowlist: ["203.0.113.0/24"],
  sessionTimeoutSeconds: 28_800,
  idleTimeoutSeconds: 3_600,
  maxConcurrentSessions: 5,
};

export const IDENTITY = {
  provider: "password",
  domains: ["northwind.example"],
  verifiedDomains: ["northwind.example"],
  scimEnabled: false,
};

/** GET /settings/security/identity/domains - DomainView. `joinPolicy` is what a claimed domain BUYS: it
 *  decides whether someone with an address at that domain is routed to SSO, joins automatically, or has to
 *  request access. Status is pending | verified | failed. */
export const IDENTITY_DOMAINS = {
  domains: [
    { id: "00000000-0000-4000-8000-00000000c001", domain: "northwind.example", status: "verified", joinPolicy: "sso_only", verifiedAt: "2026-06-02T10:20:00Z" },
    { id: "00000000-0000-4000-8000-00000000c002", domain: "northwind-labs.example", status: "pending", joinPolicy: "request_access", verifiedAt: null },
    { id: "00000000-0000-4000-8000-00000000c003", domain: "nwlogistics.example", status: "failed", joinPolicy: "request_access", verifiedAt: null },
  ],
};

/** GET /settings/security/identity/scim/tokens - the MASKED view. Never the token value and never its hash:
 *  the plaintext exists once, in the create response, and only a SHA-256 digest is stored. */
export const SCIM_TOKENS = {
  tokens: [
    { id: "00000000-0000-4000-8000-00000000c101", name: "Okta production", createdAt: "2026-06-02T10:40:00Z", lastUsedAt: "2026-08-18T04:00:00Z", revokedAt: null },
    { id: "00000000-0000-4000-8000-00000000c102", name: "Okta sandbox", createdAt: "2026-05-11T09:00:00Z", lastUsedAt: null, revokedAt: "2026-07-30T12:00:00Z" },
  ],
};

export const SSO_CONFIG = {
  enabled: true,
  protocol: "saml",
  provider: "okta",
  entityId: "https://auth.truepoint.in/saml/northwind",
  ssoUrl: "https://northwind.okta.example/app/truepoint/sso/saml",
  metadataUrl: "https://northwind.okta.example/app/truepoint/sso/saml/metadata",
  certificate: "",
  defaultRole: "member",
  attributeMapping: { email: "NameID", firstName: "givenName", lastName: "sn" },
};

/** GET /settings/security/auth-audit. The envelope key is `events`, not `entries`, and an AuthAuditEntry is
 *  deliberately SHAPED - action, actor, ip, origin, time. No metadata blob and no user agent: an audit log is
 *  a place a stray PII field would live forever. */
export const AUTH_AUDIT = {
  events: [
    { id: "aa_01", action: "auth.policy_updated", actorUserId: "00000000-0000-4000-8000-000000000301", ipAddress: "203.0.113.14", originDomain: "app.truepoint.in", occurredAt: "2026-08-14T11:02:00Z" },
    { id: "aa_02", action: "auth.session_revoked", actorUserId: "00000000-0000-4000-8000-000000000301", ipAddress: "203.0.113.14", originDomain: "app.truepoint.in", occurredAt: "2026-08-11T09:41:00Z" },
    { id: "aa_03", action: "auth.mfa_enrolled", actorUserId: "00000000-0000-4000-8000-000000000302", ipAddress: "198.51.100.7", originDomain: "auth.truepoint.in", occurredAt: "2026-08-09T08:12:00Z" },
    { id: "aa_04", action: "auth.login_failed", actorUserId: null, ipAddress: "198.51.100.7", originDomain: "auth.truepoint.in", occurredAt: "2026-08-08T22:47:00Z" },
    { id: "aa_05", action: "auth.member_invited", actorUserId: "00000000-0000-4000-8000-000000000302", ipAddress: "198.51.100.7", originDomain: "app.truepoint.in", occurredAt: "2026-08-04T16:30:00Z" },
  ],
};

export const TENANT_MEMBERS = {
  members: [
    { userId: "u_priya", email: "priya.raghavan@northwind.example", fullName: "Priya Raghavan", role: "owner", status: "active", lastSeenAt: "2026-08-18T09:14:00Z" },
    { userId: "u_daniel", email: "daniel.okafor@northwind.example", fullName: "Daniel Okafor", role: "admin", status: "active", lastSeenAt: "2026-08-18T08:02:00Z" },
    { userId: "u_marta", email: "marta.svensson@northwind.example", fullName: "Marta Svensson", role: "member", status: "active", lastSeenAt: "2026-08-17T15:20:00Z" },
    { userId: "u_tom", email: "tom.beckett@northwind.example", fullName: "Tom Beckett", role: "member", status: "invited", lastSeenAt: null },
  ],
};

/** GET /auth/session - the SessionProfile the shell probes once and shares. `workspaceId` has to be an id
 *  the /workspaces list actually contains, or the switcher renders "No workspace" while holding three. */
export const SESSION_PROFILE = {
  userId: "00000000-0000-4000-8000-000000000301",
  tenantId: "00000000-0000-4000-8000-000000000201",
  workspaceId: "ws_emea",
  role: "owner",
  scope: ["search:read", "reveal:write", "outreach:write", "export:write"],
};

/** GET /workspaces/current - WorkspaceGeneral, a FLAT object (name/slug/region/timezone). The collection
 *  below is a different route; answering the singular one with it leaves every field empty. */
export const WORKSPACE_CURRENT = {
  name: "EMEA New Business",
  slug: "emea-new-business",
  region: "eu-west-1",
  timezone: "Europe/London",
};

export const WORKSPACES = {
  workspaces: [
    { id: "ws_emea", name: "EMEA New Business", slug: "emea-new-business", isDefault: true, status: "active", memberCount: 9, createdAt: "2025-11-04T09:12:00Z" },
    { id: "ws_expansion", name: "Enterprise Expansion", slug: "enterprise-expansion", isDefault: false, status: "active", memberCount: 4, createdAt: "2026-02-18T10:44:00Z" },
    { id: "ws_partners", name: "Partnerships", slug: "partnerships", isDefault: false, status: "active", memberCount: 2, createdAt: "2026-05-06T15:29:00Z" },
  ],
};

/** The panel reads `userName` / `userEmail` / `ipAddress` and derives a device label from the RAW
 *  `userAgent` - it does not take a pre-formatted device string, which is why a `device` key renders as
 *  "Unknown device". */
export const WORKSPACE_SESSIONS = {
  sessions: [
    { id: "ses_a1", userId: "00000000-0000-4000-8000-000000000301", userName: "Priya Raghavan", userEmail: "priya.raghavan@northwind.example",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      ipAddress: "203.0.113.14", createdAt: "2026-08-18T07:02:00Z", lastSeenAt: "2026-08-18T09:14:00Z", current: true },
    { id: "ses_a2", userId: "00000000-0000-4000-8000-000000000302", userName: "Daniel Okafor", userEmail: "daniel.okafor@northwind.example",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
      ipAddress: "198.51.100.7", createdAt: "2026-08-17T18:41:00Z", lastSeenAt: "2026-08-18T08:02:00Z", current: false },
    { id: "ses_a3", userId: "00000000-0000-4000-8000-000000000303", userName: "Marta Svensson", userEmail: "marta.svensson@northwind.example",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      ipAddress: "192.0.2.55", createdAt: "2026-08-11T09:20:00Z", lastSeenAt: "2026-08-17T15:20:00Z", current: false },
  ],
};

// ── settings: enrichment ────────────────────────────────────────────────────────────────────────────────
export const AUTO_ENRICH = {
  enabled: true,
  triggers: ["on_import", "on_reveal"],
  fieldAllowlist: ["email", "phone", "jobTitle", "linkedinUrl"],
  monthlyBudgetMicros: 2_000_000_000,
  monthToDateMicros: 812_000_000,
  providerPriority: {
    version: 1,
    email: ["zoominfo", "apollo", "coresignal"],
    phone: ["zoominfo", "apollo"],
    disabled: ["pdl"],
  },
  verification: { verifyBeforeAccept: true, acceptCatchAll: "flag" },
};

/** The standalone provider-priority read, same shape as the policy's nested field. */
export const PROVIDER_PRIORITY = {
  version: 1,
  email: ["zoominfo", "apollo", "coresignal"],
  phone: ["zoominfo", "apollo"],
  disabled: ["pdl"],
};

// ── settings: mailboxes / email ─────────────────────────────────────────────────────────────────────────
/** MailboxView (features/settings-mailboxes/types.ts). NO credential ever appears in this DTO (D7) — the
 *  SMTP row carries its failure REASON, never the password that produced it. */
export const MAILBOXES = {
  mailboxes: [
    { id: "mb_01", provider: "google", address: "priya.raghavan@northwind.example", sendingDomainId: "sd_01", status: "connected", lastError: null, connectedAt: "2026-05-02T09:00:00Z" },
    { id: "mb_02", provider: "microsoft", address: "daniel.okafor@northwind.example", sendingDomainId: "sd_01", status: "connected", lastError: null, connectedAt: "2026-06-14T11:20:00Z" },
    { id: "mb_03", provider: "smtp", address: "outbound@northwind.example", sendingDomainId: "sd_02", status: "error", lastError: "SMTP AUTH rejected the credential (535)", connectedAt: "2026-07-01T08:00:00Z" },
  ],
};

/** SendingDomainView. The per-record DNS fields are `*State` and their vocabulary is exactly
 *  unverified | pass | fail — "pending"/"none" are DNS words, not this enum, and a wrong one renders blank. */
export const SENDING_DOMAINS = {
  domains: [
    { id: "sd_01", domain: "northwind.example", status: "verified", spfState: "pass", dkimState: "pass", dmarcState: "pass", trackingCname: "click.northwind.example", trackingCnameState: "pass", region: "eu-west-1", verifiedAt: "2026-05-02T09:20:00Z" },
    { id: "sd_02", domain: "mail.northwind.example", status: "verifying", spfState: "pass", dkimState: "unverified", dmarcState: "unverified", trackingCname: null, trackingCnameState: "unverified", region: "eu-west-1", verifiedAt: null },
    { id: "sd_03", domain: "send.contoso.example", status: "failed", spfState: "fail", dkimState: "fail", dmarcState: "unverified", trackingCname: null, trackingCnameState: "unverified", region: "us-east-1", verifiedAt: null },
  ],
};

export const SEND_QUOTA = { quota: 900, used: 182, periodStart: "2026-08-18T00:00:00Z" };

// ── sequences / templates / inbox ───────────────────────────────────────────────────────────────────────
/** SequenceView. `status` is exactly active | paused | archived — there is no "draft", and an unknown value
 *  renders an EMPTY status badge rather than falling back. */
export const SEQUENCES = {
  sequences: [
    { id: "00000000-0000-4000-8000-00000000a101", name: "EMEA outbound - Q3", status: "active", stepCount: 4, enrolledCount: 812,
      metrics: { sent: 2_404, opened: 1_388, clicked: 402, replied: 148, bounced: 62 } },
    { id: "00000000-0000-4000-8000-00000000a102", name: "Re-engage - no reply 30d", status: "active", stepCount: 3, enrolledCount: 402,
      metrics: { sent: 1_204, opened: 588, clicked: 141, replied: 52, bounced: 31 } },
    { id: "00000000-0000-4000-8000-00000000a103", name: "Webinar follow-up", status: "paused", stepCount: 2, enrolledCount: 70,
      metrics: { sent: 300, opened: 184, clicked: 62, replied: 14, bounced: 6 } },
    { id: "00000000-0000-4000-8000-00000000a104", name: "Expansion - pilot (archived)", status: "archived", stepCount: 3, enrolledCount: 0,
      metrics: { sent: 0, opened: 0, clicked: 0, replied: 0, bounced: 0 } },
  ],
};

export const TEMPLATES = {
  templates: [
    { id: "tp_01", name: "Intro — ops leaders", channel: "email", subject: "Quick question about {{company}} ops", shared: true, status: "active", updatedAt: "2026-08-12T10:00:00Z", version: 4 },
    { id: "tp_02", name: "Follow-up — no reply", channel: "email", subject: "Re: {{company}}", shared: true, status: "active", updatedAt: "2026-08-08T15:30:00Z", version: 2 },
    { id: "tp_03", name: "LinkedIn connect", channel: "linkedin", subject: null, shared: false, status: "draft", updatedAt: "2026-08-16T11:12:00Z", version: 1 },
  ],
};

/** EnrollmentEntry — the step index is `currentStep`, and `status` is exactly enrolled | active | replied |
 *  completed | unsubscribed | bounced. "sent" is a SEND event, not an enrollment status, and an unknown
 *  value renders an empty badge. */
/** GET /templates/:id and /templates/:id/versions. A content edit APPENDS an immutable version rather than
 *  overwriting, which is why the history is its own surface and why `currentVersion` is a number, not a flag. */
/** GET /compliance/suppression - the MASKED management view. It never carries the email/phone blind-index
 *  columns (HMACs of PII): an email match surfaces by TYPE only, which is why the email rows below have a
 *  null domain and no address anywhere. Domain and contact_id matches carry their human-readable key. */
export const SUPPRESSIONS = {
  entries: [
    { id: "00000000-0000-4000-8000-00000000b001", scope: "workspace", match_type: "email", domain: null, contact_id: null, reason: "Unsubscribed via footer link", created_at: "2026-08-17T14:22:00Z" },
    { id: "00000000-0000-4000-8000-00000000b002", scope: "tenant", match_type: "domain", domain: "northwind.example", contact_id: null, reason: "Existing customer - handled by CS", created_at: "2026-08-12T09:00:00Z" },
    { id: "00000000-0000-4000-8000-00000000b003", scope: "workspace", match_type: "contact_id", domain: null, contact_id: "00000000-0000-4000-8000-00000000d003", reason: "Asked not to be contacted", created_at: "2026-08-04T16:40:00Z" },
    { id: "00000000-0000-4000-8000-00000000b004", scope: "workspace", match_type: "email", domain: null, contact_id: null, reason: null, created_at: "2026-07-29T11:05:00Z" },
  ],
};

export const TEMPLATE_DETAIL: Record<string, unknown> = {
  tp_01: {
    id: "tp_01", name: "Intro - ops leaders", channel: "email", status: "active", shared: true,
    subject: "Quick question about {{company}} ops",
    body: "Hi {{first_name}},\n\nI work with RevOps teams at companies like {{company}} who are tired of paying for a contact database that quietly goes stale. We charge only when a reveal returns verified data.\n\nWorth fifteen minutes next week?\n\n{{sender_name}}",
    currentVersion: 4, updatedAt: "2026-08-12T10:00:00Z", canEdit: true,
  },
  tp_03: {
    id: "tp_03", name: "LinkedIn connect", channel: "linkedin", status: "draft", shared: false,
    subject: null,
    body: "Hi {{first_name}} - saw you lead {{job_title}} at {{company}}. Connecting for the RevOps notes I share.",
    currentVersion: 1, updatedAt: "2026-08-16T11:12:00Z", canEdit: false,
  },
};

export const TEMPLATE_VERSIONS = {
  versions: [
    { version: 4, subject: "Quick question about {{company}} ops", body: "Hi {{first_name}},\n\nI work with RevOps teams at companies like {{company}}...", createdByUserId: "00000000-0000-4000-8000-000000000301", createdAt: "2026-08-12T10:00:00Z" },
    { version: 3, subject: "A question about {{company}} ops", body: "Hi {{first_name}},\n\nWe help RevOps teams keep contact data accurate...", createdByUserId: "00000000-0000-4000-8000-000000000301", createdAt: "2026-07-28T14:20:00Z" },
    { version: 2, subject: "{{company}} ops", body: "Hi {{first_name}},\n\nQuick one...", createdByUserId: "00000000-0000-4000-8000-000000000302", createdAt: "2026-07-02T09:05:00Z" },
    { version: 1, subject: "Intro", body: "Hi {{first_name}},\n\nIntroducing TruePoint.", createdByUserId: "00000000-0000-4000-8000-000000000302", createdAt: "2026-06-14T16:40:00Z" },
  ],
};

export const ENROLLMENTS = {
  entries: [
    { id: "en_01", contactId: "00000000-0000-4000-8000-00000000d001", status: "active", currentStep: 2, lastEventAt: "2026-08-18T09:00:00Z" },
    { id: "en_02", contactId: "00000000-0000-4000-8000-00000000d005", status: "replied", currentStep: 1, lastEventAt: "2026-08-18T08:44:00Z" },
    { id: "en_03", contactId: "00000000-0000-4000-8000-00000000d003", status: "bounced", currentStep: 3, lastEventAt: "2026-08-17T16:02:00Z" },
    { id: "en_04", contactId: "00000000-0000-4000-8000-00000000d002", status: "unsubscribed", currentStep: 2, lastEventAt: "2026-08-17T11:20:00Z" },
    { id: "en_05", contactId: "00000000-0000-4000-8000-00000000d009", status: "completed", currentStep: 4, lastEventAt: "2026-08-16T14:05:00Z" },
  ],
};

// ── inbox ───────────────────────────────────────────────────────────────────────────────────────────────
// NOTE ON DATES IN THIS BLOCK. The screenshot harness PINS the browser clock to 2024-05-15T12:00:00Z so
// captures are reproducible. Surfaces that print an ABSOLUTE date are unaffected and use the 2026 timeline
// like the rest of this file; the inbox and notifications print RELATIVE time (`formatRelative` /
// `formatDue`), so their timestamps sit around the pinned instant instead — otherwise every row reads
// "Due in 825d". The skew is the harness's, not the component's.
export const THREADS = {
  threads: [
    { id: "th_01", contactId: "00000000-0000-4000-8000-00000000d001", contactName: "Priya Raghunathan", contactTitle: "VP of Revenue Operations", accountName: "Ramp",
      sequenceId: "00000000-0000-4000-8000-00000000a101", sequenceName: "EMEA outbound - Q3", channel: "email",
      snippet: "Happy to chat — how about Thursday?", unread: true, assigneeId: null, lastMessageAt: "2024-05-15T10:42:00Z" },
    { id: "th_02", contactId: "00000000-0000-4000-8000-00000000d005", contactName: "Aisling Byrne", contactTitle: "Senior Product Manager", accountName: "Linear",
      sequenceId: "00000000-0000-4000-8000-00000000a101", sequenceName: "EMEA outbound - Q3", channel: "email",
      snippet: "Can you send over pricing?", unread: false, assigneeId: null, lastMessageAt: "2024-05-14T16:20:00Z" },
    { id: "th_03", contactId: "00000000-0000-4000-8000-00000000d003", contactName: "Mareike Vogel", contactTitle: "Director of Demand Generation", accountName: "Figma",
      sequenceId: null, sequenceName: null, channel: "linkedin",
      snippet: "Thanks for connecting.", unread: false, assigneeId: null, lastMessageAt: "2024-05-13T09:05:00Z" },
  ],
};

/** GET /inbox/:id — the same thread WITH its messages. Bodies live only here, on the detail the user opened;
 *  nothing in the list carries a message body. */
export const THREAD_DETAIL = {
  ...THREADS.threads[0],
  messages: [
    { id: "im_01", direction: "outbound", at: "2024-05-14T09:02:00Z", body: "Hi Priya — we help RevOps teams keep their contact data accurate without buying a second database. Worth fifteen minutes?" },
    { id: "im_02", direction: "inbound", at: "2024-05-15T10:42:00Z", body: "Happy to chat — how about Thursday? Mornings are better for me." },
  ],
};

export const TASKS = {
  tasks: [
    { id: "tk_01", title: "Follow up with Priya Raghunathan", status: "open", source: "follow_up", dueAt: "2024-05-16T14:00:00Z", contactName: "Priya Raghunathan", createdAt: "2024-05-14T09:10:00Z" },
    { id: "tk_02", title: "Review reply from Aisling Byrne", status: "open", source: "reply", dueAt: "2024-05-15T15:30:00Z", contactName: "Aisling Byrne", createdAt: "2024-05-14T16:22:00Z" },
    { id: "tk_03", title: "Top up credits before the EMEA push", status: "snoozed", source: "low_credits", dueAt: "2024-05-13T09:00:00Z", contactName: null, createdAt: "2024-05-10T08:00:00Z" },
    { id: "tk_04", title: "Clean up the EMEA list", status: "done", source: "manual", dueAt: null, contactName: null, createdAt: "2024-05-09T11:00:00Z" },
  ],
};

// ── lists / notifications / announcements / sales navigator ─────────────────────────────────────────────
export const LISTS = {
  lists: [
    { id: "li_emea", name: "EMEA new business", kind: "static", memberCount: 1_284, sharedWith: "workspace", updatedAt: "2026-08-18T08:47:00Z" },
    { id: "li_cfo", name: "Fintech CFOs", kind: "dynamic", memberCount: 402, sharedWith: "workspace", updatedAt: "2026-08-17T10:12:00Z" },
    { id: "li_champ", name: "Champions", kind: "static", memberCount: 64, sharedWith: "private", updatedAt: "2026-08-11T14:00:00Z" },
  ],
};

/** Relative-time surface — see the dates note above THREADS. */
export const NOTIFICATIONS = {
  unreadCount: 2,
  notifications: [
    { id: "nt_01", kind: "reply", title: "Priya Raghunathan replied", body: "Happy to chat — how about Thursday?", read: false, createdAt: "2024-05-15T10:42:00Z" },
    { id: "nt_02", kind: "low_credit", title: "Credits running low", body: "You have 12,480 credits left this period.", read: false, createdAt: "2024-05-15T06:00:00Z" },
    { id: "nt_03", kind: "task", title: "Task due today", body: "Follow up with Aisling Byrne", read: true, createdAt: "2024-05-14T17:00:00Z" },
  ],
};

export const ANNOUNCEMENTS_WEB = {
  announcements: [
    { id: "ann_01", title: "Scheduled maintenance — 24 Aug, 02:00–03:00 UTC", body: "Search may be briefly unavailable while we roll out an index upgrade. Reveals and imports are unaffected.", level: "info", type: "banner", startsAt: "2026-08-20T00:00:00Z", endsAt: "2026-08-24T04:00:00Z" },
  ],
};

/** SalesNavLinkDTO. `linkType` is the LINK_TYPE_LABELS vocabulary — profile | account | saved_search |
 *  lead_list | account_list | inmail_thread. "lead" is not in it, and an unknown key renders an EMPTY badge.
 *
 *  Assisted capture only: a row is a URL the user pasted, plus their own note and labels. Nothing here was
 *  scraped and nothing is automated against LinkedIn. */
export const SALES_NAV_LINKS = {
  links: [
    { id: "sn_01", linkType: "profile", url: "https://www.linkedin.com/sales/lead/ACwAAB1", externalId: "ACwAAB1", note: "Warm intro via the Q3 webinar", labels: ["champion"], contactId: "ct_01hq8m4pv7", accountId: null, capturedAt: "2026-08-18T09:14:00Z", createdAt: "2026-08-18T09:14:02Z" },
    { id: "sn_02", linkType: "saved_search", url: "https://www.linkedin.com/sales/search/people?savedSearchId=88214", externalId: "88214", note: null, labels: [], contactId: null, accountId: null, capturedAt: "2026-08-18T08:03:00Z", createdAt: "2026-08-18T08:03:04Z" },
    { id: "sn_03", linkType: "account", url: "https://www.linkedin.com/sales/company/12849302", externalId: "12849302", note: "Target account", labels: ["tier-1"], contactId: null, accountId: "ac_northwind", capturedAt: "2026-08-17T19:40:00Z", createdAt: "2026-08-17T19:40:06Z" },
  ],
};

// ── developer / integrations ────────────────────────────────────────────────────────────────────────────
/** ApiKey. `scopes` is the documented ApiKeyScope vocabulary - search:read | reveal:write |
 *  outreach:write | export:write - and the panel renders SCOPE_LABEL[scope], so "read"/"write" render as
 *  EMPTY chips. Only the non-secret `prefix` is ever stored or shown; the secret exists once, at creation. */
export const API_KEYS = {
  keys: [
    { id: "ak_01", name: "Production", prefix: "tp_live_8f2a", scopes: ["search:read", "reveal:write"], lastUsedAt: "2026-08-18T09:10:00Z", createdAt: "2026-05-02T09:00:00Z" },
    { id: "ak_02", name: "Reporting (read-only)", prefix: "tp_live_2b41", scopes: ["search:read"], lastUsedAt: "2026-08-17T02:00:00Z", createdAt: "2026-07-14T11:00:00Z" },
    { id: "ak_03", name: "CI smoke tests", prefix: "tp_live_c07d", scopes: ["search:read", "export:write"], lastUsedAt: null, createdAt: "2026-08-16T08:30:00Z" },
  ],
};

/** Webhook. `active` is a boolean (not a status string), `events` is the WebhookEvent vocabulary, and
 *  `secretPrefix` is the only part of the signing secret that survives creation. */
export const WEBHOOKS = {
  webhooks: [
    { id: "wh_01", url: "https://hooks.northwind.example/truepoint", events: ["reveal.completed", "score.updated"], active: true, secretPrefix: "whsec_a1b2", createdAt: "2026-06-02T10:00:00Z" },
    { id: "wh_02", url: "https://hooks.northwind.example/legacy", events: ["outreach.status_changed"], active: false, secretPrefix: "whsec_7c4e", createdAt: "2026-04-18T15:20:00Z" },
  ],
};

/** GET /webhooks/deliveries - the WIRE shape, which is not the view shape: `status` is the outcome word,
 *  `responseCode` is the HTTP code, and the timestamp is `attemptedAt`. The api layer renames all three, so a
 *  fixture written in view terms lands as empty badges and em dashes. Includes the synthetic self-ping. */
export const WEBHOOK_DELIVERIES = {
  deliveries: [
    { id: "wd_01", webhookId: "wh_01", event: "reveal.completed", status: "succeeded", responseCode: 200, attemptedAt: "2026-08-18T09:12:04Z" },
    { id: "wd_02", webhookId: "wh_01", event: "score.updated", status: "succeeded", responseCode: 200, attemptedAt: "2026-08-18T08:41:10Z" },
    { id: "wd_03", webhookId: "wh_02", event: "outreach.status_changed", status: "failed", responseCode: 502, attemptedAt: "2026-08-17T22:04:00Z" },
    { id: "wd_04", webhookId: "wh_01", event: "webhook.test", status: "pending", responseCode: null, attemptedAt: "2026-08-17T21:59:00Z" },
  ],
};

export const OAUTH_APPS = {
  apps: [
    { id: "oa_01", name: "Northwind internal dashboard", clientId: "tp_cid_9a12", redirectUris: ["https://dash.northwind.example/callback"], scopes: ["search:read"], createdAt: "2026-06-20T10:00:00Z" },
    { id: "oa_02", name: "Revenue ops warehouse sync", clientId: "tp_cid_4b71", redirectUris: ["https://etl.northwind.example/oauth/callback", "http://localhost:5173/callback"], scopes: ["search:read", "export:write"], createdAt: "2026-07-08T14:30:00Z" },
  ],
};

/** GET /custom-fields?entity=... - the settings panel's DEFINITIONS list (the prospect slice's
 *  /custom-fields/values/... route is a different shape and is matched separately in the stub router). */
export const CUSTOM_FIELDS = {
  definitions: [
    { id: "cf_01", key: "account_tier", label: "Account tier", fieldType: "select", entity: "contact", options: ["Strategic", "Growth", "SMB"], required: true, archived: false, ordering: 1 },
    { id: "cf_02", key: "renewal_date", label: "Renewal date", fieldType: "date", entity: "contact", options: null, required: false, archived: false, ordering: 2 },
    { id: "cf_03", key: "champion", label: "Champion", fieldType: "boolean", entity: "contact", options: null, required: false, archived: false, ordering: 3 },
    { id: "cf_04", key: "legacy_owner", label: "Legacy owner", fieldType: "text", entity: "contact", options: null, required: false, archived: true, ordering: 4 },
  ],
};

export const TEAMS = {
  teams: [
    { id: "tm_01", name: "EMEA", memberCount: 6, createdAt: "2026-02-10T09:00:00Z" },
    { id: "tm_02", name: "Enterprise", memberCount: 4, createdAt: "2026-04-02T09:00:00Z" },
  ],
};

// ── CRM sync (customer-facing view) ─────────────────────────────────────────────────────────────────────
/** CrmConnectionView. There is no credential FIELD here to leak into — the repository's safeColumns
 *  projection omits oauth_token_enc, so the view model simply has nowhere to put one. */
export const CRM_CONNECTIONS_WEB = {
  connections: [
    { id: "cx_01", provider: "hubspot", status: "connected", syncMode: "two_way", environment: "production",
      externalAccountId: "24518830", instanceUrl: "https://app.hubspot.com/contacts/24518830",
      lastError: null, lastRefreshAt: "2026-08-18T08:00:00Z", connectedAt: "2026-06-02T10:14:00Z" },
  ],
};

/** CrmSyncStreamView — the per-object watermark the incremental runs advance. */
export const CRM_STREAMS = {
  streams: [
    { id: "st_01", objectType: "contact", direction: "push", watermark: "2026-08-18T08:04:00Z", backfillStatus: "complete" },
    { id: "st_02", objectType: "account", direction: "pull", watermark: "2026-08-18T07:32:00Z", backfillStatus: "complete" },
    { id: "st_03", objectType: "contact", direction: "pull", watermark: null, backfillStatus: "pending" },
  ],
};

/** CrmMappingView. `authority` is which side wins when both changed — the field that decides whether a
 *  sync overwrites a human edit, which is why a required mapping cannot simply be switched off.
 *  `direction` is exactly inbound | outbound | bidirectional | disabled - "push"/"two_way" are not in the
 *  editor's vocabulary and fall back to the first option, which silently misstates which way data flows. */
export const CRM_MAPPINGS = {
  mappings: [
    { id: "mp_01", objectType: "contact", tpField: "email", crmField: "email", direction: "bidirectional", authority: "truepoint", transform: "lowercase", isRequired: true, enabled: true },
    { id: "mp_02", objectType: "contact", tpField: "jobTitle", crmField: "jobtitle", direction: "outbound", authority: "truepoint", transform: "none", isRequired: false, enabled: true },
    { id: "mp_03", objectType: "contact", tpField: "linkedinUrl", crmField: "linkedin_url", direction: "inbound", authority: "crm", transform: "none", isRequired: false, enabled: false },
    { id: "mp_04", objectType: "account", tpField: "accountDomain", crmField: "domain", direction: "bidirectional", authority: "truepoint", transform: "lowercase", isRequired: true, enabled: true },
  ],
};

/** CrmConflictView. The timestamp field is `createdAt` (the table's "Raised" column reads it directly — a
 *  differently-named key renders "Invalid Date", not an empty cell). tpValue/crmValue arrive ALREADY masked
 *  by the repository write path, which is why the phone below shows only its tail. */
export const CRM_CONFLICTS = {
  conflicts: [
    { id: "cf_a1", connectionId: "cx_01", objectType: "contact", field: "jobTitle", tpValue: "VP of Revenue Operations", crmValue: "VP RevOps", createdAt: "2026-08-18T08:02:00Z" },
    { id: "cf_a2", connectionId: "cx_01", objectType: "contact", field: "phone", tpValue: "••• ••• 0142", crmValue: "••• ••• 0142 ext 21", createdAt: "2026-08-17T16:20:00Z" },
    { id: "cf_a3", connectionId: "cx_01", objectType: "account", field: "accountDomain", tpValue: "northwind.example", crmValue: "www.northwind.example", createdAt: "2026-08-17T11:48:00Z" },
  ],
};

export const CRM_RUNS = {
  runs: [
    { id: "cr_01", direction: "push", objectType: "contact", trigger: "schedule", mode: "incremental", status: "completed",
      recordsSeen: 1_284, recordsCreated: 402, recordsUpdated: 861, recordsFailed: 3, recordsConflicted: 18, apiCalls: 214,
      startedAt: "2026-08-18T08:00:00Z", finishedAt: "2026-08-18T08:04:00Z", failedReason: null },
    { id: "cr_02", direction: "pull", objectType: "account", trigger: "schedule", mode: "incremental", status: "completed",
      recordsSeen: 402, recordsCreated: 12, recordsUpdated: 388, recordsFailed: 2, recordsConflicted: 4, apiCalls: 88,
      startedAt: "2026-08-18T07:30:00Z", finishedAt: "2026-08-18T07:32:00Z", failedReason: null },
    { id: "cr_03", direction: "push", objectType: "contact", trigger: "manual", mode: "backfill", status: "failed",
      recordsSeen: 4_820, recordsCreated: 1_204, recordsUpdated: 0, recordsFailed: 3_616, recordsConflicted: 0, apiCalls: 1_204,
      startedAt: "2026-08-17T22:00:00Z", finishedAt: "2026-08-17T22:11:00Z",
      failedReason: "REQUEST_LIMIT_EXCEEDED - daily API cap reached" },
  ],
};

// ── reports ─────────────────────────────────────────────────────────────────────────────────────────────
/** GET /reports/summary — reportsSummarySchema, and it is zod-PARSED (mergeApi's sibling pattern), so a
 *  near-miss shape is a thrown error and a page stuck in its skeleton, not a half-filled report.
 *
 *  It carries COUNTS, never view models: labels, conversion percentages and bar maxima are derived on the
 *  client by the pure rollups. And the team buckets carry a user id with NO name - returning names here
 *  would quietly turn a report into a new place user identities are exposed. */
export const REPORTS_SUMMARY = {
  contactTotal: 48_120,
  withEmail: 44_270,
  funnel: [
    { status: "new", count: 48_120 },
    { status: "in_sequence", count: 1_284 },
    { status: "replied", count: 214 },
    { status: "meeting_booked", count: 38 },
    { status: "disqualified", count: 402 },
    { status: "nurture", count: 1_106 },
    { status: "unsubscribed", count: 96 },
  ],
  creditsByDay: [
    { day: "2026-08-12", reveals: 604, credits: 812 },
    { day: "2026-08-13", reveals: 712, credits: 941 },
    { day: "2026-08-14", reveals: 588, credits: 704 },
    { day: "2026-08-15", reveals: 902, credits: 1_188 },
    { day: "2026-08-16", reveals: 214, credits: 262 },
    { day: "2026-08-17", reveals: 188, credits: 241 },
    { day: "2026-08-18", reveals: 1_604, credits: 1_872 },
  ],
  creditsByType: [
    { revealType: "email", reveals: 3_604, credits: 3_604 },
    { revealType: "phone", reveals: 1_208, credits: 3_624 },
  ],
  team: [
    { userId: "00000000-0000-4000-8000-000000000301", revealed: 1_884, credits: 2_402, engaged: 412 },
    { userId: "00000000-0000-4000-8000-000000000302", revealed: 1_526, credits: 1_810, engaged: 288 },
    { userId: "00000000-0000-4000-8000-000000000303", revealed: 1_402, credits: 1_808, engaged: 341 },
  ],
  health: [
    { status: "valid", count: 39_460 },
    { status: "catch_all", count: 2_887 },
    { status: "unverified", count: 2_406 },
    { status: "risky", count: 1_925 },
    { status: "invalid", count: 1_444 },
    { status: "unknown", count: 962 },
  ],
  memberOptions: [
    "00000000-0000-4000-8000-000000000301",
    "00000000-0000-4000-8000-000000000302",
    "00000000-0000-4000-8000-000000000303",
  ],
};

// ── enrichment jobs / imports ───────────────────────────────────────────────────────────────────────────
export const ENRICHMENT_JOBS_WEB = {
  jobs: [
    {
      jobId: "ej_01", sourceName: "emea-contacts-aug.csv", status: "completed", progress: 1,
      counts: { total: 4_820, processed: 4_820, matched: 4_102, enriched: 3_884, charged: 3_884, failed: 18 },
      creditEstimateMicros: 4_000_000_000, creditSpentMicros: 3_884_000_000,
      createdAt: "2026-08-18T07:20:00Z", startedAt: "2026-08-18T07:20:10Z",
      completedAt: "2026-08-18T07:41:00Z", failedReason: null,
    },
    {
      jobId: "ej_02", sourceName: "webinar-signups.csv", status: "running", progress: 0.6,
      counts: { total: 312, processed: 188, matched: 172, enriched: 164, charged: 164, failed: 2 },
      creditEstimateMicros: 300_000_000, creditSpentMicros: 164_000_000,
      createdAt: "2026-08-18T09:02:00Z", startedAt: "2026-08-18T09:02:08Z",
      completedAt: null, failedReason: null,
    },
    {
      jobId: "ej_03", sourceName: "apac-accounts-q3.csv", status: "failed", progress: 0,
      counts: { total: 1_120, processed: 0, matched: 0, enriched: 0, charged: 0, failed: 0 },
      creditEstimateMicros: 1_100_000_000, creditSpentMicros: 0,
      createdAt: "2026-08-17T16:30:00Z", startedAt: "2026-08-17T16:30:04Z",
      completedAt: "2026-08-17T16:31:00Z",
      failedReason: "Provider returned 503 for every batch - circuit opened",
    },
  ],
};

const counts = (total, created, matched, rejected) => ({
  total, created, matched, duplicate: Math.max(0, total - created - matched - rejected),
  skipped: 0, rejected, deduped: 0, unprocessed: 0,
});

export const IMPORT_JOBS_WEB = {
  jobs: [
    {
      jobId: "00000000-0000-4000-8000-00000000f001", status: "completed", mode: "bulk",
      sourceName: "csv_import", sourceFilename: "emea-prospects-q3.csv",
      createdAt: "2026-08-18T07:14:00Z", startedAt: "2026-08-18T07:14:12Z",
      completedAt: "2026-08-18T07:19:42Z", percent: 1, stage: "done",
      counts: counts(4_820, 3_991, 742, 87),
      createdBy: { userId: "00000000-0000-4000-8000-000000000301" }, parentJobId: null,
    },
    {
      jobId: "00000000-0000-4000-8000-00000000f002", status: "processing", mode: "bulk",
      sourceName: "csv_import", sourceFilename: "webinar-attendees.csv",
      createdAt: "2026-08-18T09:02:00Z", startedAt: "2026-08-18T09:02:06Z",
      completedAt: null, percent: 0.62, stage: "matching",
      counts: counts(312, 188, 20, 4),
      createdBy: { userId: "00000000-0000-4000-8000-000000000302" }, parentJobId: null,
    },
    {
      jobId: "00000000-0000-4000-8000-00000000f003", status: "failed", mode: "bulk",
      sourceName: "csv_import", sourceFilename: "clinic-contacts.xlsx",
      createdAt: "2026-08-17T16:22:00Z", startedAt: "2026-08-17T16:22:20Z",
      completedAt: "2026-08-17T16:22:38Z", percent: 0, stage: "rejected",
      counts: { total: 1_120, created: 0, matched: 0, duplicate: 0, skipped: 0, rejected: 0, deduped: 0, unprocessed: 1_120 },
      createdBy: { userId: "00000000-0000-4000-8000-000000000301" }, parentJobId: null,
    },
  ],
  nextCursor: null,
};

/** GET /imports/:jobId — importJobDetailV2. The drawer reads `statusV2` FIRST and only falls back to the
 *  legacy `status`; a body without it degrades every job to "Waiting to start" regardless of what it did.
 *  Keyed by job id, because the route is per-job and returning the LIST here is what caused exactly that. */
export const IMPORT_JOB_DETAILS: Record<string, unknown> = {
  "00000000-0000-4000-8000-00000000f001": {
    statusV2: "completed", mode: "bulk", sourceFilename: "emea-prospects-q3.csv",
    createdAt: "2026-08-18T07:14:00Z", startedAt: "2026-08-18T07:14:12Z", completedAt: "2026-08-18T07:19:42Z",
    percent: 1, stage: "done", counts: counts(4_820, 3_991, 742, 87),
    createdBy: { userId: "00000000-0000-4000-8000-000000000301" }, parentJobId: null,
    mergeMode: "update", preservePopulated: true,
    rejectHistogram: { missing_email: 41, invalid_email: 28, missing_name: 12, duplicate_in_file: 6 },
    previewSummary: null,
  },
  "00000000-0000-4000-8000-00000000f002": {
    statusV2: "running", mode: "bulk", sourceFilename: "webinar-attendees.csv",
    createdAt: "2026-08-18T09:02:00Z", startedAt: "2026-08-18T09:02:06Z", completedAt: null,
    percent: 0.62, stage: "matching", counts: counts(312, 188, 20, 4),
    createdBy: { userId: "00000000-0000-4000-8000-000000000302" }, parentJobId: null,
    mergeMode: "update", preservePopulated: true, rejectHistogram: { invalid_email: 4 }, previewSummary: null,
  },
  "00000000-0000-4000-8000-00000000f003": {
    statusV2: "failed", mode: "bulk", sourceFilename: "clinic-contacts.xlsx",
    createdAt: "2026-08-17T16:22:00Z", startedAt: "2026-08-17T16:22:20Z", completedAt: "2026-08-17T16:22:38Z",
    percent: 0, stage: "rejected",
    counts: { total: 1_120, created: 0, matched: 0, duplicate: 0, skipped: 0, rejected: 0, deduped: 0, unprocessed: 1_120 },
    createdBy: { userId: "00000000-0000-4000-8000-000000000301" }, parentJobId: null,
    mergeMode: "update", preservePopulated: true, rejectHistogram: {}, previewSummary: null,
  },
};

/** GET /imports/bulk/:jobId — the polled status BulkImportProgress renders (bulkImportJobStatusResponse).
 *  The file key is `sourceName` and the fraction is `progress` (0..1) — NOT sourceFilename/percent: the
 *  component computes bulkPercent(job.progress), and an absent key renders a literal "NaN%".
 *  `counts.total` is read directly, so a missing counts object is a crash rather than an empty panel. */
export const BULK_IMPORT_STATUS = {
  jobId: "00000000-0000-4000-8000-00000000f002",
  sourceName: "webinar-attendees.csv",
  status: "processing",
  progress: 0.62,
  counts: { total: 312, created: 188, matched: 20, duplicate: 96, skipped: 0, rejected: 4, deduped: 0, unprocessed: 4 },
  rejectedRowsUrl: null,
  createdAt: "2026-08-18T09:02:00Z",
  startedAt: "2026-08-18T09:02:06Z",
  completedAt: null,
  failedReason: null,
};
