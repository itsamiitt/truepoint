# The service-worker API client

There is exactly one HTTP client in the extension: `src/background/api/client.ts`, in the service worker. UI
and content surfaces never call the API — they message the SW, which calls on their behalf. This keeps the
token in one place and centralizes idempotency, error handling, and refresh.

## What the client does (as-built)

- **Base:** `https://api.truepoint.in/api/v1` (`src/shared/env.ts`).
- **`Authorization: Bearer <access JWT>`** on every request, from the in-memory token store.
- **`Idempotency-Key` on writes** — the platform replays a stored success for a repeated key (the reveal money
  path depends on this; a killed-and-retried SW must not double-charge).
- **RFC-9457 problem-details parsing** → a typed `ErrorClass` (defined in `src/shared/types.ts`; the wire
  request/response schemas are what come from `@leadwolf/types`), so callers switch on error kind, not string
  matching.
- **One silent refresh-and-retry on 401** — refresh the access token once and replay the request; a second 401
  is a real failure.
- **Wire contracts come from `@leadwolf/types`** — request/response schemas are shared with the server; import
  them, don't hand-type payloads.

## Rules

- **Add new endpoints here, typed.** A new call = a method on the client using the shared `@leadwolf/types`
  schema for its request and response, surfaced to UI via a bus message (`truepoint-extension-architecture/references/messaging.md`).
- **Reuse the shared schema on both ends.** If the server response shape isn't in `@leadwolf/types` yet, that's
  a platform gap to close — don't shadow-type it in the extension.
- **Never bypass the client** with a raw `fetch` from a surface, and never forward the token to a surface so it
  can call directly. One client, one token holder.
- **Match the message contract.** When you wire a call to a bus message (e.g. `LOOKUP` → the resolver), the
  client's return shape must match `ResponseFor<T>` in `src/shared/messages.ts` — verify the server response
  matches the message's declared shape before wiring the UI.
- **Rate limits are per-subject** server-side (`rl:api` 120/min, `rl:capture` 2000 records/min, `rl:reveal`
  ~60/min); handle 429 (`RateLimitedError`, `retryAfterSeconds`) as a first-class state, don't hammer.
