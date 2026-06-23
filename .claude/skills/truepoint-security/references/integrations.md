# Integration Security

TruePoint talks to external systems: enrichment providers (Apollo, Clay, Clearbit
and similar), data sources like LinkedIn Lead Sync, and inbound webhooks from
third parties. Every integration is a trust boundary in both directions — data
leaving to a third party, and data and requests arriving from one. This file
covers securing both directions.

---

## Outbound Requests and SSRF

Any request the server makes to an external URL is an outbound trust boundary. If
the URL is influenced by user input, it is an SSRF risk (see
`input-and-injection.md`): an attacker can aim the server at internal services or
the cloud metadata endpoint to steal credentials.

For every outbound request:
- **Allowlist destinations** where the set is known. Enrichment calls go to the
  provider's known API domain — not to an arbitrary URL a user supplied.
- **Validate user-influenced URLs** before fetching: `http(s)` only, and reject
  hostnames that resolve to private, loopback, or link-local ranges (`10.x`,
  `192.168.x`, `127.x`, `169.254.x`, `::1`). Re-check after DNS resolution, since
  a hostname can resolve to an internal IP.
- **Set timeouts and size limits** on outbound responses — a malicious or broken
  endpoint shouldn't be able to hang the server or return an unbounded body.
- **Treat the response as untrusted input** — data coming back from a third-party
  API is validated and escaped like any other external input. A provider returning
  a malicious string that you render unescaped is stored XSS by proxy.

> **Implementation status:** an SSRF guard exists for **outbound webhooks**
> (`packages/core/src/webhooks/ssrfGuard.ts`, surfaced as `SsrfError`), but an
> **outbound-URL allowlist on the enrichment provider calls is not confirmed in code**
> — verify before relying on it. The mandate stands: enrichment outbound requests must
> be allowlisted/validated against internal ranges, not just the webhook path.

---

## Inbound Webhooks Must Be Verified

A webhook endpoint is a public URL that anything on the internet can POST to.
Without verification, an attacker can forge webhook calls — faking a payment, a
data sync, or an event that triggers privileged action.

- **Verify the signature** on every inbound webhook. Providers sign their payloads
  (typically an HMAC of the body with a shared secret) — recompute it and reject
  any request whose signature doesn't match. A webhook handler without signature
  verification is an unauthenticated public mutation endpoint.
- **Verify before processing** — check the signature before parsing or acting on
  the payload, not after.
- **Use the raw body** for signature verification — re-serialising the parsed JSON
  can change bytes and break the check.
- **Guard against replay** — honour the provider's timestamp/nonce so a captured
  valid request can't be replayed. Make webhook handlers idempotent so a duplicate
  delivery (which providers do send) doesn't double-process.
- The webhook signing secret is a secret — stored and handled per `secrets.md`.

---

## OAuth and Third-Party Tokens

For integrations using OAuth (data sources, connected accounts):

- **Request least privilege** — ask only for the scopes the integration needs.
  Don't request write access for a read-only sync.
- **Store tokens as secrets** — access and refresh tokens are credentials; they
  live encrypted, never in the client, never in logs (see `secrets.md`,
  `data-protection.md`).
- **Validate the OAuth state parameter** on callback to prevent CSRF on the
  authorization flow — the `state` you sent must match the one returned.
- **Handle token refresh server-side** and revoke tokens when an integration is
  disconnected — a token that outlives its need is standing risk.

---

## Provider API Keys

Keys for enrichment providers are server-side secrets (see `secrets.md`). The
client never holds them — the browser calls TruePoint's API, and TruePoint's
server calls the provider with the key. This also lets you rate-limit and
authorize the call (a user shouldn't be able to drive unlimited paid enrichment
calls — see `api-security.md`).

---

## Data Leaving to Third Parties

Sending data to an external provider is data leaving your control.

- Send only what the integration needs — don't ship a full prospect record to an
  enrichment provider when an email or domain is what the lookup needs (data
  minimization, `data-protection.md`).
- Be aware of what each provider does with the data, especially for PII subject to
  data-protection law. Sending EU prospect PII to a third party has compliance
  implications — raise it when designing the integration.

---

## Checklist

- Does any outbound request use a user-influenced URL? Is it allowlisted and validated against internal ranges? (SSRF)
- Do outbound requests have timeouts and response size limits?
- Is data returned from third-party APIs validated and escaped as untrusted input?
- Does every inbound webhook verify its signature on the raw body before processing?
- Are webhook handlers idempotent and replay-guarded?
- Do OAuth flows request least privilege, validate `state`, and store tokens as secrets?
- Are provider API keys server-side only, with the call rate-limited and authorized?
- Is only the minimum necessary data sent to each third party?
