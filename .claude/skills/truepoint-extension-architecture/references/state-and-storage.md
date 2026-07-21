# State & storage tiers

The extension uses four storage tiers, each with a deliberate trust and durability level. Putting a value in
the wrong tier is a security or correctness bug.

| Tier | What lives here | Why | Code |
|---|---|---|---|
| **Memory (SW only)** | the access JWT + decoded claims | never persisted; dies with the worker; unreadable by any other context | `src/background/auth/tokenStore.ts` |
| **`chrome.storage.session`** | the rotating refresh token; the pending-auth nonce | memory-backed (no disk), cleared on browser close, **not readable by content scripts** | `src/background/auth/refreshToken.ts` |
| **`chrome.storage.local`** | non-secret settings + cached feature flags | small, durable, survives restart | `src/shared/storage.ts` |
| **IndexedDB** | the capture queue, the local "recent" list, buffered telemetry | durable, structured, survives worker death | `src/shared/idb.ts` |

## Rules

- **Secrets never touch `storage.local` or IndexedDB.** The access token is memory-only; the refresh token is
  `storage.session` (no disk). This is the as-built choice and it is safer than the encrypted-`storage.local`
  that ADR-0045 Decision 3 originally specified (no key material to manage, no token at rest) — see doc 14's
  drift log. Do not "improve" it by moving the token to `storage.local`.
- **Content scripts get no direct storage of trust.** They ask the SW over the bus; the SW owns the tiers.
- **Client UI state is local + simple.** Panel/popup use React `useState`/`useReducer`. ADR-0043 §8 named
  Zustand; as-built there is none, and the current surfaces don't need it. Introduce Zustand only if state is
  genuinely shared across distant components in a surface — not by default.
- **The SW's live objects are caches, not sources of truth.** `CreditsStore`, `RemoteConfig`, and the token
  store re-hydrate from their durable tier (or a fresh fetch) on wake; treat a cold read as the normal case.
- **Bump the IndexedDB version deliberately** when the schema changes, with a migration in `src/shared/idb.ts`;
  a killed worker may open the DB at any version.
