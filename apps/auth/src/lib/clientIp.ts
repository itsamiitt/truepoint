// clientIp.ts — re-export only. The implementation moved to packages/auth (`@leadwolf/auth`) so that apps/api
// can key its request throttle by the same trusted-hop rule: `apps-never-import-apps` (dependency-cruiser)
// forbids apps/api importing from here, and a second copy of a security control drifts until one side is
// silently wrong. This file stays so the ~11 existing `@/lib/clientIp` call sites are untouched.
//
// The selection rule and its rationale (Nth-from-last entry, TRUSTED_PROXY_HOPS, W10/#14, AUTH-077) now live in
// packages/auth/src/clientIp.ts.
export { clientIp, clientIpFromHeaders, type HeaderReader } from "@leadwolf/auth";
