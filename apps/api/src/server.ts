// server.ts — Bun entry point. `bun run --hot src/server.ts` serves the composed Hono app.
import { app } from "./app.ts";
import { runBootWarmup } from "./instrumentation.ts";

// Fire-and-forget boot warmup (perf root cause #8): fill the DB pool + prefetch JWKS so the first real user
// after a deploy/restart doesn't pay those handshakes. Not awaited — listening must start immediately — and
// fully non-fatal internally, with a defensive .catch as a last resort so an unexpected throw can't crash boot.
runBootWarmup().catch(() => {});

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
};
