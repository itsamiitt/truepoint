# Secrets Management

Secrets are credentials that grant access: API keys for the enrichment providers
(Apollo, Clay, Clearbit and similar), database credentials, signing keys, OAuth
client secrets, and auth tokens. A leaked secret is a direct path to data or to
spending money on a metered third-party API. This file is about keeping secrets
out of every place they can leak.

---

## No Secrets in Code, Ever

A secret committed to the repo is a secret leaked — git history is forever, the
repo is cloned to many machines, and a single push can expose it permanently.

- Never hardcode an API key, password, token, or signing secret in source.
- Never commit a `.env` file with real values. `.env.example` documents the
  variable names with empty or placeholder values; the real values live in the
  secrets manager (see the architecture env-vars and CI/CD skills).
- If you find a secret in code, treat it as already compromised: rotate it, then
  remove it. Removing it from the current file is not enough — it remains in git
  history and must be rotated.

---

## No Secrets on the Client — `NEXT_PUBLIC_` Is Public

This is the most common secret leak in a React/Next app, and it is worth stating
plainly: **anything with the `NEXT_PUBLIC_` prefix is bundled into the JavaScript
sent to the browser. It is public. Every user can read it.**

- API keys for enrichment providers, database URLs, signing secrets, and any
  server-only credential are **never** `NEXT_PUBLIC_` and never referenced in
  client code.
- A third-party API key belongs on the server. The browser calls *your* API; your
  server calls the provider with the key. The key never reaches the client.
- Only genuinely public values (a public analytics ID, a public API base URL) may
  carry `NEXT_PUBLIC_`. If you would mind an attacker having it, it is not public.

```
# .env.example
DATABASE_URL=                  # server-only — no prefix
APOLLO_API_KEY=                # server-only — no prefix, NEVER NEXT_PUBLIC_
NEXT_PUBLIC_APP_URL=           # genuinely public, safe to ship
```

If a feature needs a provider's key in the browser to work, the architecture is
wrong — proxy the call through the server (see `integrations.md`).

---

## The Secrets Manager Is the Source of Truth

Real secret values live in a secrets manager (AWS Secrets Manager, Doppler, or
the platform's equivalent), injected at deploy time. Per the CI/CD skill, the
pipeline pulls them; they are never stored in the repo.

- Each environment has its own secret set. Production secrets never appear in
  staging or development.
- The CI role has read-only access to secrets — it cannot create or modify them.
- Local development uses a local `.env` (gitignored) with development-only
  credentials, never production secrets.

---

## Secrets Never Reach Logs or Errors

A secret logged is a secret leaked to everyone who reads logs.

- Never log a token, key, or credential — see `data-protection.md`.
- Be careful with error objects: an error from an HTTP client may include the
  request headers (with the `Authorization` header) in its message or stack.
  Strip or avoid logging those.
- Never put a secret in a URL query string — URLs end up in logs, browser history,
  and referrer headers. Secrets go in headers or the request body, over TLS.

---

## Application Secrets vs Encryption Keys (KMS)

This file is about **application secrets** — credentials that grant access (provider
API keys, database credentials, OAuth client secrets, signing keys). They live in the
secrets manager (above).

**Encryption keys are a related but distinct concern** with their own home: a **Key
Management Service (KMS)**. Keys that encrypt data at rest or specific sensitive
fields are not stored as plain secrets beside the data — they're KMS-managed, with
**envelope encryption** (a master key wraps per-data keys) and **rotation**, and (for
enterprise tenants) **customer-managed keys / BYOK**. The full discipline is in
`data-protection.md`. The principle is the same — keys never reach the client, the
logs, or git — but encryption-key lifecycle is managed by the KMS, not the secrets
manager.

> **Implementation status:** the KMS is the **target**, not yet present — today the
> app-layer AES-GCM key for PII is an application secret (see `data-protection.md`),
> with no KMS, envelope encryption, or rotation. Keep the mandate.

---

## Rotation

- Secrets are rotatable. When a secret may have been exposed — committed, logged,
  shared in a screenshot, or held by someone who left — rotate it promptly.
- Rotation should not require a code change: because secrets come from the secrets
  manager, rotating is updating the manager and redeploying, not editing source.
- Long-lived secrets are higher risk than short-lived ones. Prefer short-lived,
  automatically-rotated credentials where the platform supports them.

---

## If a Secret Leaks

1. Rotate it immediately — assume it is compromised the moment it left a safe place.
2. Remove it from wherever it leaked (code, logs, config).
3. If it was committed, rotating is mandatory — purging git history is best-effort
   and cannot be relied on, since clones and forks may retain it.
4. Check for misuse: a leaked third-party key may have been used to run up usage
   or exfiltrate data.

---

## Checklist

- Is any secret hardcoded in source or committed in a `.env`? (it shouldn't be)
- Is any server-only credential prefixed `NEXT_PUBLIC_` or referenced in client code?
- Do third-party API calls happen server-side, with the key never reaching the browser?
- Could any secret reach a log, an error message, or a URL query string?
- Is each environment's secrets separate, with production isolated?
- Is every secret rotatable without a code change?
