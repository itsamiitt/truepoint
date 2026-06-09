// route.ts — SAML SSO callback / ACS (auth.truepoint.in/sso/saml/callback, 17 §7). The IdP POSTs (or GETs)
// the SAML Response + RelayState here; completeSso validates the assertion (relay-state-bound), JIT-provisions
// the identity, and finalizes the login. A Route Handler because it must set cookies; accepts POST and GET.
import { completeSso } from "@/lib/completeSso";

async function handle(request: Request): Promise<Response> {
  // SAML binds via HTTP-POST (form-encoded) or HTTP-Redirect (query). Merge both into one param bag.
  const params: Record<string, string> = Object.fromEntries(new URL(request.url).searchParams);
  if (request.method === "POST") {
    const form = await request.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  }
  await completeSso("saml", params);
  return new Response(null, { status: 302 }); // unreachable: completeSso always redirects
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
