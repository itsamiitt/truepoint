# Handoff & token threat model

`truepoint-security` has final say here; this reference is the extension-specific checklist. The whole design
assumes the extension holds a bearer credential in a hostile-adjacent environment (a browser also running
LinkedIn's page and, potentially, other extensions).

## Threats & mitigations

- **Token exfiltration to a page/content script.** Mitigation: the token never leaves SW memory / `storage.session`
  and is never messaged to a surface; the SW makes the authenticated call itself. A content script that could
  read the token would hand it to LinkedIn's page context.
- **Forged handoff over `externally_connectable`.** Any page matching `app.truepoint.in/*` can `sendMessage` the
  extension. Mitigation: verify `sender.origin` **and** the SW-generated `state` nonce before trusting an
  `AUTH_HANDOFF`; `externally_connectable` is narrowed to `https://app.truepoint.in/*` (never a wildcard).
- **Injected/unknown bus messages.** Mitigation: the SW validates every inbound message against the Zod schema
  and drops unknowns (`truepoint-extension-architecture/references/messaging.md`).
- **Refresh token at rest.** Mitigation: `storage.session` is memory-backed (no disk) and cleared on browser
  close; rotation + reuse-detection + short access TTL + `sid` denylist bound the blast radius; the extension's
  `sid` family is independently revocable without touching the web session.
- **Over-privileged token.** Mitigation: mint drops the `pa` super-admin bit and scopes `aud` to the extension
  id; a stolen extension token can't act as an admin or as the web app.
- **Remote-code / config tampering.** Mitigation: no remotely-hosted code (strict CSP). The remote-config
  **signature check is a marked TODO (X09)** — `remoteConfig.ts` is currently a local-cache scaffold with no
  remote fetch; until the signed fetch ships, treat unsigned/unverified config as all-flags-off. Config can
  only ever flip flags, never change behavior.
- **CSRF/XSS.** The extension pages are `'self'`-CSP with no remote origins; the API is bearer-token (no ambient
  cookie to forge); inputs from the page are untrusted and validated server-side.

## Non-negotiables

- No `cookies`, `webRequest`, or (unless the `prompt=none` fallback ships) `identity` permission.
- No token in a log line, a URL, a message payload to a surface, or persistent disk storage.
- Any change that widens `externally_connectable`, moves a token to disk, or relaxes nonce/origin checks is a
  security review, not a refactor.
