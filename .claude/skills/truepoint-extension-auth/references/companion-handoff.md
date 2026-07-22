# Companion-window login & handoff

Cookies can't cross into the extension, and `launchWebAuthFlow` can't host TruePoint's multi-step MFA/SSO/
WebAuthn login (ADR-0044 failed for this reason — doc 12 §2). So the extension opens the **real web login**
and has a credential handed back. This is ADR-0045.

## The flow (as-built)

1. `login()` (`src/background/auth/index.ts` → `companionTab.ts`) generates a `state` nonce (stored in
   `chrome.storage.session`) and opens `https://app.truepoint.in/auth/extension?state=<nonce>&ext_id=<id>`.
2. The handoff page `apps/web/src/app/auth/extension/page.tsx` runs under the user's real `truepoint.in`
   session (silent-refreshing it), then `POST`s `/auth/extension/mint` (`credentials:"include"`).
3. The mint route `apps/auth/src/app/extension/mint/route.ts` resolves the user from the `lw_refresh` cookie,
   creates a **separate revocable session family**, and returns `{ accessToken (aud=extension), tokenType,
   expiresIn, refreshToken }` — refresh token in the **body**, no `Set-Cookie`.
4. The page `chrome.runtime.sendMessage(extId, { type:"AUTH_HANDOFF", accessToken, refreshToken, expiresIn, state })`.
5. The SW's `chrome.runtime.onMessageExternal` handler (registered synchronously in `index.ts`) **verifies
   `sender.origin === "https://app.truepoint.in"` AND `state` matches**, stores the tokens, and closes the tab.

Refresh/logout ride the sibling routes `/auth/extension/{refresh,logout}`.

## Rules

- **Verify origin AND nonce, every time.** `chrome.runtime` is reachable by any `externally_connectable` page;
  the payload alone is never trusted. Reject on mismatch and clear the pending nonce.
- **`externally_connectable` stays `https://app.truepoint.in/*`** — the handoff can't originate from LinkedIn
  or anywhere else.
- **Silent verification uses a background inactive tab** (the shipped `companionTab.ts`, `chrome.tabs.create({active:false})`)
  when an existing web session can be reused. **Interactive login for a signed-out user needs a *visible*
  surface** able to host MFA/WebAuthn (ADR-0045 §1 specifies a popup window). Whether that visible path exists
  is X16 — verify on-device; if a signed-out user can't complete login through a background tab, add the
  `chrome.windows.create({type:"popup"})` path.
- **Re-scope (workspace/org switch)** goes through `/auth/extension/refresh` with `{workspaceId}`/`{tenantId}`,
  which re-mints with the new `wid`/`tid` and denylists the old `sid` — never mutate claims client-side.
- **Logout** clears local tokens and calls `/auth/extension/logout` to revoke the server session; local clear
  must succeed even if the network call fails.
