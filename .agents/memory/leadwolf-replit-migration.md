---
name: LeadWolf Replit Migration
description: Key decisions and quirks from migrating the LeadWolf Turborepo monorepo to run on Replit.
---

# Architecture
Turborepo monorepo: apps/web (Next.js, port 5000), apps/auth (Next.js, port 3000), apps/api (Hono/Bun, port 3001), apps/workers (BullMQ). All proxied through port 5000 via Next.js rewrites.

# NEXT_PUBLIC_* env vars — Zod optional() vs empty string
`packages/config/src/env.ts` validates ALL env vars with Zod, including `NEXT_PUBLIC_APP_ORIGIN` and `NEXT_PUBLIC_AUTH_ORIGIN` as `z.string().url().optional()`. `optional()` passes `undefined` but NOT an empty string `""`. Setting them to empty in `.env` (e.g. `NEXT_PUBLIC_AUTH_ORIGIN=`) causes Zod to throw "Invalid url" at boot in api, workers, and auth-app.
**Fix:** Do NOT set these vars in `.env` at all. Leave them unset so they're `undefined`.

# Relative URLs for same-domain auth (CORS fix)
`apps/web/src/lib/publicConfig.ts` exports `AUTH_ORIGIN`, `APP_ORIGIN`, `API_BASE`. When auth+API are proxied through the web app's domain, use relative URLs (empty string) for `AUTH_ORIGIN` and `API_BASE` to avoid cross-origin fetch blocks. `APP_ORIGIN` must be `window.location.origin` at runtime (dynamic) because the browser may arrive via the Replit HTTPS proxy OR localhost:5000.

# auth-app basePath
`apps/auth/next.config.mjs` has `basePath: "/auth"`. This means the auth app's internal route `/login` is accessed externally as `/auth/login`. The web app's rewrites map `/auth/:path*` → `http://localhost:3000/auth/:path*`. Next.js dev server logs show the internal path (without basePath prefix), e.g. logs show `GET /login` even though the external path is `/auth/login`.

# APP_ORIGINS allowlist
`isAllowedOrigin()` in `packages/config/src/env.ts` is an EXACT match against `APP_ORIGINS` (comma-separated). The token/refresh and token/exchange routes return 403 (not 401) when origin is not in the list. Must include both the Replit HTTPS proxy domain AND `http://localhost:5000` in `APP_ORIGINS` to support screenshot tools and direct localhost access.
`start.sh` sets: `APP_ORIGINS=${APP_URL},http://localhost:5000`

# External integrations
`STRIPE_WEBHOOK_SECRET`, `APOLLO_API_KEY`, `CLEARBIT_API_KEY` are all `optional()` — app degrades gracefully when absent. Not blocking for dev.

# start.sh — env distribution
`start.sh` writes root `.env`, sources it, copies to each app dir (`apps/api/.env`, `apps/auth/.env.local`, `apps/web/.env.local`, `apps/workers/.env`), runs migrations, then `exec bun run dev` (turbo).
