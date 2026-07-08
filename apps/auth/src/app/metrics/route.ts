// route.ts — GET /metrics (Phase 1 observability, doc 03 §10). apps/auth is the token MINTER and runs as a
// SEPARATE process from apps/api, so the in-process auth SLI counters it accumulates — login success +
// policy-block (flow.ts) and token-mint (token.ts) — need their OWN scrape endpoint. Renders renderAuthMetrics()
// as Prometheus text. Same gate as the apps/api /metrics route: OFF by default (404 unless METRICS_TOKEN is set)
// and invisible to a wrong/absent Bearer token (also 404 — never advertise it). A scraper carries no user
// session, so the shared secret IS the gate; intended to sit behind an internal-only network.
import { renderAuthMetrics } from "@leadwolf/auth";
import { env } from "@leadwolf/config";

// The counters are live in-process state — never serve a cached/stale scrape.
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const token = env.METRICS_TOKEN;
  if (!token || req.headers.get("authorization") !== `Bearer ${token}`) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(renderAuthMetrics(), {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4" },
  });
}
