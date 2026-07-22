# Messaging bus

Content scripts, the side panel, and the popup are thin clients; the service worker is the only privileged
context. They communicate through a **typed, validated** message bus — never by sharing globals or reaching
into each other.

## The contract

- All message types live in `src/shared/messages.ts` as a **Zod discriminated union** (11 request types as of
  M2) plus a `ResponseFor<T>` type map and the broadcast types. Adding a capability = adding a union member +
  its response shape here first, then handling it in the SW router.
- UI/content code sends via the helper in `src/shared/client.ts` (`send()` = `chrome.runtime.sendMessage`,
  `onBroadcast()` for pushed updates). Do not call `chrome.runtime.sendMessage` ad hoc.
- The SW router (`src/background/bus/index.ts`) **validates every inbound message against the schema and drops
  unknowns** — `chrome.runtime` is reachable by any extension page, so an unvalidated message is untrusted input.

## Rules

- **Never put a token or secret in a message to a content script or page.** The content script runs in a page's
  world; anything you send it is reachable by that page. The SW holds the token and makes the authenticated call
  itself (see `truepoint-extension-auth/references/api-client.md`).
- **`onMessageExternal` (from `app.truepoint.in`) is a separate, higher-trust channel** used only for the auth
  handoff, and it is verified by `sender.origin` **and** a nonce before the payload is trusted (see
  `truepoint-extension-auth/references/companion-handoff.md`). Regular in-extension messages use `onMessage`.
- **Keep messages coarse and intent-shaped** (`LOOKUP`, `CAPTURE`, `REVEAL`), not RPC-fine — the SW owns the
  orchestration; the client asks for an outcome and renders the result or the four states.
- **Responses carry typed errors, not thrown strings.** The SW maps RFC-9457 problem-details to an error class
  and returns a structured result the UI can switch on (loading/empty/error/data).

## Adding a message (checklist)

1. Add the request + response to the union and `ResponseFor` in `src/shared/messages.ts`.
2. Handle it in `src/background/bus/index.ts` (validate is automatic; add the case).
3. Call it from the surface via `send()` in `src/shared/client.ts`.
4. If it triggers a write, the SW attaches an `Idempotency-Key` (see the auth skill's api-client reference).
