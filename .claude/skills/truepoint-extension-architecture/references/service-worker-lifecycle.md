# Service-worker lifecycle

An MV3 extension service worker is **not persistent**. Chrome terminates it ~30 seconds after its last
event; any top-level variable is gone on the next wake. Design every background concern to survive death and
cold restart.

## Rules

- **Never `setInterval`/`setTimeout` for periodic work.** Use `chrome.alarms` (minimum 1-minute period). The
  as-built `BrowserEventManager` (`src/background/events/manager.ts`) registers alarms for `drain`, `flush`,
  and `auth-refresh`; add periodic work there, not with a timer.
- **Persist anything that must outlive the worker.** Durable queues and caches are IndexedDB-backed
  (`src/shared/idb.ts`; the capture queue is `src/background/queue/captureQueue.ts`). Small settings/flags go
  in `chrome.storage.local`; the access token is memory-only and the refresh token is `chrome.storage.session`
  (see `references/state-and-storage.md`). Re-read state on startup — never assume warm memory.
- **Every background write is idempotent.** A worker killed mid-flight must recover cleanly. The capture queue
  keys each item by `SHA-256(sourceUrl + captured fields)`, backs off with an attempt cap (8), and re-drains on
  the next alarm. Ingest is a server-side no-op on replay (ADR-0043 §3).
- **Warm-up on wake is explicit.** `src/background/index.ts` re-loads remote config and runs a silent auth
  refresh on start-up, and registers the persistent `onMessageExternal` handoff listener at top level (it must
  be registered synchronously on every wake, or an auth handoff can be missed).
- **Register all event listeners synchronously at the top level.** Listeners added inside an async callback
  are not guaranteed to be present when the worker is re-spawned for an event.
- **Offscreen documents:** the SW can `fetch` the token endpoint directly, so **no offscreen document is needed
  for auth** (ADR-0045 / doc 12 §3.5). Only reach for an offscreen document if you need a DOM API the worker
  lacks (e.g. `DOMParser`, audio) — and give it its own lifecycle; it is not a keepalive hack.

## Do not

- Do not add a keepalive port/ping loop to defeat the 30s timeout — it drains battery and fails review. If work
  must be periodic, it belongs on an alarm; if it must be durable, it belongs in IndexedDB.
- Do not store the access token or any secret in IndexedDB or `storage.local` (see `state-and-storage.md`).
