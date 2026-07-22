# Manifest (`manifest.config.ts`)

The manifest is authored in TypeScript via `@crxjs/vite-plugin`'s `defineManifest` and compiled by the
Vite build — never hand-edit a `manifest.json`. Every field is a security surface; the default answer to
"can I add a permission?" is no.

## As-built shape (the baseline to preserve)

- `manifest_version: 3`, `minimum_chrome_version: "116"` (Side Panel API + MV3 baseline).
- `action.default_popup: src/ui/popup/index.html`
- `background.service_worker: src/background/index.ts`, `type: "module"`
- `side_panel.default_path: src/ui/panel/index.html`
- `permissions: ["storage", "alarms", "activeTab", "scripting", "sidePanel"]`
- `host_permissions: ["https://api.truepoint.in/*", "https://*.linkedin.com/*"]`
- `optional_host_permissions: ["https://*/*", "http://*/*"]` — opt-in, per-host, on a user gesture
- `externally_connectable.matches: ["https://app.truepoint.in/*"]`
- `content_scripts`: LinkedIn only — `matches: ["https://*.linkedin.com/*"]`, `run_at: "document_idle"`,
  `all_frames: false`
- `content_security_policy.extension_pages: "script-src 'self'; object-src 'self'; font-src 'self'"`
- **No `options_ui`/`options_page`, no `web_accessible_resources`, no `identity`, no `cookies`, no
  `webRequest`.**

## Rules

- **Never `*://*/*` in `host_permissions`** (ADR-0043 §2). New always-on hosts need a security review; ad-hoc
  hosts go in `optional_host_permissions`, requested with `chrome.permissions.request` on a user gesture and
  revocable.
- **`externally_connectable` stays locked to `https://app.truepoint.in/*`.** It is the auth-handoff channel;
  widening it widens the token-injection surface. Any handoff is still verified by `sender.origin` + a nonce
  (see `truepoint-extension-auth/references/companion-handoff.md`). Never `<all_urls>`.
- **`web_accessible_resources` should stay absent.** If a feature genuinely needs one, scope its `matches` to
  `https://*.linkedin.com/*` (never `<all_urls>`) **and** set `use_dynamic_url: true`. LinkedIn's "BrowserGate"
  (Apr 2026) fingerprints extensions by probing `chrome-extension://<id>/<known-file>` across ~6,200 known IDs;
  a static WAR entry is the exact vector it reads. See `truepoint-extension-linkedin/references/anti-fingerprint-and-tos.md`.
- **CSP stays strict** — `'self'` only, no `unsafe-eval`, no remote origins. MV3 forbids remotely-hosted code;
  the CSP is what enforces it at runtime. Self-host fonts (`font-src 'self'`) — remote fonts are blocked.
- **Keep the CSP and permission set minimal for Web Store review.** Every permission you request is a review
  question and an install-time warning; drop `identity` unless the `prompt=none` fallback ships (ADR-0045 §5).
- **Icons** are generated (`scripts/gen-icons.mjs`) — regenerate, don't hand-place.

When you add a permission or host, record why in the PR and, if it changes the store-review posture, in
`references/build-release-and-store.md`'s checklist.
