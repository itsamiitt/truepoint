// route.ts — OIDC SSO callback (auth.truepoint.in/sso/oidc/callback, 17 §7). The IdP redirects here with
// `code` + `state`; completeSso validates the assertion (relay-state-bound), JIT-provisions the identity,
// and finalizes the login (cross-domain code → app callback). A Route Handler because it must set cookies.
import { completeSso } from "@/lib/completeSso";

export async function GET(request: Request): Promise<Response> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  await completeSso("oidc", params);
  return new Response(null, { status: 302 }); // unreachable: completeSso always redirects
}
