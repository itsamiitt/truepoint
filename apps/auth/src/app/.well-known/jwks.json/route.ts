// route.ts — GET /.well-known/jwks.json (ADR-0016): the public signing keys apps/api uses to validate the
// access JWT statelessly. Cacheable; publishes current (and, on rotation, next) keys so rotation is seamless.
import { getJwks } from "@leadwolf/auth";

export async function GET(): Promise<Response> {
  const jwks = await getJwks();
  return Response.json(jwks, { headers: { "Cache-Control": "public, max-age=300" } });
}
