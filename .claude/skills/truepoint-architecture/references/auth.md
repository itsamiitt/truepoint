# Auth — Client-Side Patterns

TruePoint uses a centralised auth service at `auth.truepoint.in` (the dedicated
`apps/auth` IdP, package `@leadwolf/auth-app`). No frontend app
handles authentication logic directly; all auth interactions go through the shared
internal `@leadwolf/auth` package. This file covers the **frontend** auth
*implementation pattern* — middleware, session usage, token handling in the browser.

The *enterprise identity model* — SSO/SAML/OIDC, SCIM provisioning, org-defined
roles, record-level and field-level permissions — lives in **truepoint-security**
(enterprise-iam), and the *security discipline* (why tokens never go in
`localStorage`, how access control and tenant scoping work, the threat model) lives
in **truepoint-security** (access-control, frontend-security, secrets). This file is
the client-side "how"; that skill is the model and the "why".

---

## How Auth Works (frontend view)

```
Browser → auth.truepoint.in → issues a session (token in an httpOnly cookie)
                             ↓
         Next.js middleware validates the session on every request
                             ↓
         the resolved identity/role determines which app surfaces render
```

The token is a credential the SDK manages. The app does not parse it by hand, does
not store it in web storage, and does not make authorization decisions on the
client — those are server-enforced (see **truepoint-security**). The role/claims the
client reads are for *rendering* (show/hide), never for *protection*.

> The set of roles is **not** a hardcoded `customer|staff|admin` enum baked into the
> token as the authorization model. Those three are the *surface* a user belongs to;
> within a surface, an org has richer, data-defined roles (see **truepoint-security**
> enterprise-iam and **truepoint-data** ownership-and-sharing). The client treats
> roles/claims as opaque inputs to rendering, resolved via the SDK.

---

## Middleware Pattern

Every app's `middleware.ts` follows this structure. Keep it focused (~60 lines).

```ts
// apps/web/middleware.ts
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest, sessionIsValid } from '@leadwolf/auth'

const PUBLIC_PATHS = ['/login', '/register', '/forgot-password']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) return NextResponse.next()

  const session = await getSessionFromRequest(request)
  if (!sessionIsValid(session)) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Surface gate: this app renders only for the surface it serves.
  // This is a rendering/redirect gate — the security boundary is the backend API.
  if (!session.canAccessSurface('customer')) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

For the internal app, the surface gate lives in `apps/admin/middleware.ts` and gates
the internal/platform-admin surface (operator and platform-admin sections), the same
way `apps/web/middleware.ts` gates the customer surface.

The middleware redirect is **UX, not the security boundary**. An attacker doesn't
use the middleware — they call the backend API directly, which independently
authenticates, authorizes, and tenant-scopes every request (see
**truepoint-platform** api-contract and **truepoint-security** access-control).

---

## Session in Components

Use the SDK's session accessor in server components and route handlers; never read
the cookie directly.

```ts
// server component or route handler
import { getSession } from '@leadwolf/auth'
const session = await getSession()
if (!session) redirect('/login')
const userId = session.userId
```

For client components that need the current user, use the session hook, which reads
from context the root layout provides (fetched once server-side) — it does not fetch
on every render:

```ts
import { useSession } from '@leadwolf/auth'
const { user, isLoading } = useSession()
```

---

## Permission Checks (rendering only)

Client-side permission checks decide what to *show*, not what's *allowed*. Drive UI
visibility from the user's resolved permissions via the SDK / permissions helper —
but the same permission is always enforced server-side, where it actually protects
data (see **truepoint-security** access-control). A hidden button protects nothing
if the endpoint still serves the data.

Never inline a raw role string for a gate. Resolve permissions through the shared
helper so the rule has one definition (see `shared-packages.md` and
**truepoint-security** enterprise-iam).

---

## Token Refresh

Refresh is handled by the auth service via the SDK's `refreshSession()`, called in
exactly two places — the middleware when a session is near expiry, and the API
client's response interceptor on a 401 (refresh once, then redirect to login). Never
implement refresh logic anywhere else.

---

## What NOT to Do

- Never store the raw token in `localStorage`/`sessionStorage` (see
  **truepoint-security** frontend-security).
- Never decode the JWT by hand — use the SDK.
- Never redirect to `auth.truepoint.in` directly from component code — use the SDK's
  redirect helper so the redirect URL stays consistent.
- Never treat a client-side role/permission check as a security boundary — the
  backend is the boundary.
- Never hardcode a role string as a gate outside the shared permissions helper.
