# Enablement gates

The extension is shipped **dark**. Two env gates and a published id stand between the current state and a
working extension; this reference is the checklist for turning it on (and why nothing works until you do).

## The gates

| Gate | Where | Effect |
|---|---|---|
| `EXTENSION_ORIGINS` | `packages/config/src/env.ts` (regex `^chrome-extension://[a-p]{32}$`) | Folds into `appOrigins()` (same file) → gates **both** the API CORS allow-list **and** token-audience verification (`verifyAccessToken`). **Unset ⇒ every credentialed call from the extension is 403'd** (preflight and/or audience). The single most important flag. |
| `CHROME_EXTENSION_ENABLED` | `packages/config/src/env.ts` (explicit-`"true"`-only) | Registers the `chrome_extension` ingest connector. Off ⇒ `POST /ingest` returns 400 "no connector". |
| Published extension id | Chrome Web Store | The value pinned in `EXTENSION_ORIGINS` and the manifest `externally_connectable`; and the target of the enterprise `ExtensionInstallForcelist` policy. |

## Sequence to enable

1. **Publish** the extension (or load-unpacked in dev with a fixed key to get a stable id).
2. **Pin the id** in `EXTENSION_ORIGINS` (and confirm `externally_connectable` matches `app.truepoint.in`).
3. **Set `CHROME_EXTENSION_ENABLED=true`** to light up capture.
4. (Optional) enable the per-tenant flag + `realtimeSse` for the SSE stream.
5. **Legal/compliance sign-off** (ADR-0043 §9; README §3) gates GA of capture regardless of the flags.

## Dev

- For local end-to-end (resolve → card → reveal), run a dev API with `EXTENSION_ORIGINS` set to your unpacked
  extension id and `CHROME_EXTENSION_ENABLED=true`; point `src/shared/env.ts` (or the Vite `define`) at the dev
  origins.
- **Regression guard:** with the gates unset the extension must stay byte-inert — no code path should activate
  without `EXTENSION_ORIGINS` + `CHROME_EXTENSION_ENABLED`. Verify this whenever you touch the auth or capture
  path.
- This host has no `bun`/`docker`; the auth itests run in CI. The token-mint is a credential path — any change
  to it is security-reviewed and CI-itest-gated before enabling (doc 12 §9).
