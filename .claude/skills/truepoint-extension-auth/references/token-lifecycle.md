# Token lifecycle

Two credentials, two tiers, one holder (the service worker). Get the tiers wrong and it's a security bug.

| Credential | Shape | TTL | Where | Code |
|---|---|---|---|---|
| Access | EdDSA JWT, `aud=chrome-extension://<id>`, `scope:["extension"]`, **no `pa` bit** | ~15 min | **memory only** (SW) | `src/background/auth/tokenStore.ts` |
| Refresh | opaque, rotating, extension-scoped | ~30 d | `chrome.storage.session` (memory-backed, no disk) | `src/background/auth/refreshToken.ts` |

## Rules

- **Access token never leaves SW memory.** Not persisted, not messaged to any surface. The SW attaches it to
  outbound requests itself (`api-client.md`).
- **Refresh token stays in `chrome.storage.session`.** No disk, no key material — the as-built refinement of
  ADR-0045 Decision 3 (which said encrypted `storage.local`); it is safer, so keep it there. Cleared on browser
  close by design. Never `storage.local`, never IndexedDB, never a content script.
- **Rotation + reuse detection is the server's, reused as-is.** Refresh calls `/auth/extension/refresh`, which
  rotates via the shipped `packages/auth/src/session.ts` machinery and denylists the old `sid`; a replayed old
  token trips whole-family revocation. The extension just stores whatever refresh token comes back.
- **Proactive refresh on `chrome.alarms`** (~13 min, ahead of the 15-min access TTL) via the
  `BrowserEventManager` `auth-refresh` alarm — never a timer (the SW may be asleep; the alarm wakes it).
- **Reactive refresh** is the API client's one-shot 401-retry-after-refresh (`api-client.md`); if refresh
  itself 401s (revoked/expired), transition to signed-out.
- **Tenancy is in the claims** (`tid`/`wid`), pinned server-side from the verified token — the client never
  asserts tenancy in a body. Decode claims read-only for display (e.g. which workspace); do not trust a decoded
  claim for authorization (the server re-checks).
