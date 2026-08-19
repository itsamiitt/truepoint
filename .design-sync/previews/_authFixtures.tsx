// Shared fixtures for the apps/auth cards.
//
// Not a component and not a card: files prefixed with `_` are preview helpers, so package-build logs a
// harmless "stale preview" line for it.
//
// The account-security sections take their data as props — no fetch, no context — so these are the whole
// seam. Dates are fixed constants rather than Date.now() arithmetic: a card whose "3 days ago" changes on
// every capture churns its own render hash and clears its grade on every sync.

/** The session that backs THIS browser is never offered for revoke — `current: true` is what marks it. */
export const SESSIONS = [
  {
    id: "ses_01hq9m1",
    current: true,
    device: "Chrome 141 on macOS",
    ipAddress: "203.0.113.14",
    createdAt: new Date("2026-08-18T07:02:00Z"),
    lastSeenAt: new Date("2026-08-18T09:14:00Z"),
    expiresAt: new Date("2026-09-17T07:02:00Z"),
  },
  {
    id: "ses_01hq9m2",
    current: false,
    device: "Safari 19 on iPhone",
    ipAddress: "198.51.100.7",
    createdAt: new Date("2026-08-14T18:41:00Z"),
    lastSeenAt: new Date("2026-08-17T21:03:00Z"),
    expiresAt: new Date("2026-09-13T18:41:00Z"),
  },
  {
    id: "ses_01hq9m3",
    current: false,
    device: "Edge 141 on Windows",
    ipAddress: "192.0.2.55",
    createdAt: new Date("2026-08-02T09:20:00Z"),
    lastSeenAt: new Date("2026-08-11T13:37:00Z"),
    expiresAt: new Date("2026-09-01T09:20:00Z"),
  },
];

/** Login history reuses the session view — same shape, read-only presentation. */
export const HISTORY = [
  ...SESSIONS,
  {
    id: "ses_01hq9m4",
    current: false,
    device: "Firefox 143 on Ubuntu",
    ipAddress: "198.51.100.90",
    createdAt: new Date("2026-07-28T11:12:00Z"),
    lastSeenAt: new Date("2026-07-28T12:44:00Z"),
    expiresAt: new Date("2026-08-27T11:12:00Z"),
  },
];

/** One verified TOTP authenticator plus a registered passkey — the common two-factor shape. */
export const MFA_METHODS = [
  {
    id: "mfa_01hq9p1",
    type: "totp",
    label: "1Password",
    verifiedAt: new Date("2026-03-11T10:04:00Z"),
    lastUsedAt: new Date("2026-08-18T07:02:00Z"),
    createdAt: new Date("2026-03-11T10:02:00Z"),
  },
  {
    id: "mfa_01hq9p2",
    type: "webauthn",
    label: "MacBook Touch ID",
    verifiedAt: new Date("2026-05-02T16:20:00Z"),
    lastUsedAt: new Date("2026-08-15T08:31:00Z"),
    createdAt: new Date("2026-05-02T16:19:00Z"),
  },
];

export const SECTIONS = [
  { id: "password", label: "Password" },
  { id: "mfa", label: "Two-factor" },
  { id: "sessions", label: "Sessions" },
  { id: "history", label: "Login history" },
];

/** A page ground for the auth cards — the shells are full-height layouts, not inline blocks. */
export const ground: React.CSSProperties = {
  background: "var(--tp-canvas, #f7f8fa)",
  borderRadius: 8,
  overflow: "auto",
};
