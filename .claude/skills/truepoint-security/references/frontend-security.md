# Frontend Security

The browser is an untrusted, attacker-controllable environment. A user — or
someone who has compromised a user's machine or is using browser dev tools — can
read everything the client holds, modify any client-side logic, and call the API
directly with any payload. This file is about what that means for the TruePoint
frontend.

The governing principle: **the client is a convenience and a presentation layer.
It enforces nothing. Every security decision is made and enforced on the server.**

---

## The Client Enforces Nothing

Anything the frontend does to restrict behaviour, an attacker can undo:

- Hiding a button does not prevent the action — the attacker calls the API
  directly. Authorization is enforced server-side (see `access-control.md`).
- Disabling a field does not protect it — the attacker sends the field anyway.
  The server allowlists what it accepts (see `api-security.md`).
- Client-side validation does not protect the server — the attacker skips it. The
  server re-validates everything (see below).

Use client-side restrictions for UX — they make the product clearer and faster.
Never rely on them for security. For every client-side guard, ask: "what happens
if someone calls the API without it?" The server must have the answer.

---

## Client-Side Validation Is UX, Not Security

Validating input in the browser gives the user fast feedback — that is good
design (see the design skill's form-validation guidance). But it is not a security
control: an attacker bypasses the browser entirely.

Every input the client validates, the server validates again against its schema
(see `input-and-injection.md`). The client check improves the experience; the
server check is what actually protects the system. Both exist; only the server one
is a security boundary.

---

## No Secrets in Client Code

Anything in the frontend bundle is readable by every user — JavaScript shipped to
the browser is not secret.

- No API keys, no signing secrets, no server credentials in client code or in
  `NEXT_PUBLIC_` variables (which are bundled and public — see `secrets.md`).
- Third-party provider calls that need a key go through the server, never directly
  from the browser.
- If a feature seems to need a secret in the browser, the design is wrong — proxy
  it through the server.

---

## Browser Storage and Tokens

What the client stores can be read by any script running on the page — including
injected script if an XSS slips through.

- **Auth tokens are not stored in `localStorage` or `sessionStorage`.** They are
  held in the way the auth setup prescribes (see the architecture auth skill). In this
  codebase (`apps/web/src/lib/authClient.ts`, ADR-0016) the **access token lives in
  memory only**; the **refresh token is an `HttpOnly` + `Secure` + `SameSite=Strict`
  cookie scoped to the auth origin** (`auth.truepoint.in`) and rides a same-site
  credentialed refresh fetch — it never touches the app-domain JS. Only the transient
  PKCE verifier/state sit in `sessionStorage`, and those are not tokens.
- **No sensitive data in `localStorage`/`sessionStorage`.** It persists, it is
  readable by any script, and it is trivially inspected. Keep PII and anything
  sensitive in memory for the session, not in browser storage.
- Note this also aligns with the design/artifact rule that browser storage isn't
  used — here the reason is security, not just convention.

---

## XSS Defence on the Client

React escapes rendered strings by default, which prevents most XSS. The places
that bypass it need care (see `input-and-injection.md` for the full treatment):

- **`dangerouslySetInnerHTML`** — never pass user-influenced content to it without
  sanitising via a vetted sanitiser (DOMPurify) first. Reaching for it is a
  decision that needs a reason.
- **URLs in `href`/`src`** — validate user-supplied URLs are `http(s)` before
  using them, so a `javascript:` URI can't execute.
- Remember stored XSS: content another user entered (a prospect name, a note)
  rendered as raw HTML executes in your user's session. Let React escape it.

---

## Content Security Policy

A Content Security Policy (CSP) header limits what the browser will load and
execute — it is a strong second line of defence against XSS by disallowing inline
script and restricting script sources.

- TruePoint serves a CSP that restricts script, style, and connection sources to
  known origins.

> **Implementation status:** a strict CSP is the **target** — not yet confirmed served
> by the web app / Caddy edge. Keep the mandate; add and tune the CSP header (script,
> style, connect-src to known origins) before relying on it as a second line against XSS.
- Avoid inline event handlers and inline `<script>` that force a loose CSP — they
  are exactly what a strict CSP is meant to block.
- When adding a third-party script or an external connection, it must fit the CSP
  allowlist — don't loosen the policy to accommodate a convenience.

---

## Checklist

- Does any security decision rely on the client (hidden button, disabled field, client validation)? It must also be enforced server-side.
- Is any secret or API key present in client code or a `NEXT_PUBLIC_` var?
- Are auth tokens or sensitive data stored in `localStorage`/`sessionStorage`? (they shouldn't be)
- Is `dangerouslySetInnerHTML` used with unsanitised content?
- Are user-supplied URLs validated to `http(s)` before use in links/images?
- Does new client code fit the CSP, rather than requiring it to be loosened?
