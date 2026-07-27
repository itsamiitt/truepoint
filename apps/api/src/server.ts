// server.ts — Bun entry point. `bun run --hot src/server.ts` serves the composed Hono app.
//
// Uses an explicit Bun.serve() rather than `export default { port, fetch }` because a graceful drain needs a
// handle on the server to stop accepting connections. Under `--hot` Bun reloads the fetch handler in place
// (the listening socket persists), so this stays hot-reload-safe.

import { closeDb } from "@leadwolf/db";
import { app } from "./app.ts";
import { runBootWarmup } from "./instrumentation.ts";
import { installRoleCacheInvalidator } from "./lib/roleCache.ts";
import { beginDraining } from "./lifecycle.ts";

// Fire-and-forget boot warmup (perf root cause #8): fill the DB pool + prefetch JWKS so the first real user
// after a deploy/restart doesn't pay those handshakes. Not awaited — listening must start immediately — and
// fully non-fatal internally, with a defensive .catch as a last resort so an unexpected throw can't crash boot.
runBootWarmup().catch(() => {});

/** Request-body ceiling. Bun's default is 128 MB, so without this ANY route buffers an arbitrarily large body
 *  into memory before Zod ever rejects it. 2 MB comfortably exceeds every JSON write this API accepts; the
 *  bulk/import upload surfaces enforce their own (larger) admission caps on their own routes. */
const MAX_REQUEST_BODY_BYTES = 2_000_000;

/** Connection idle timeout (seconds). MUST exceed the SSE heartbeat interval — Bun's default is 10s, which is
 *  SHORTER than the 15s heartbeat in features/events, so the default would silently kill every event stream
 *  between heartbeats the moment REALTIME_SSE_ENABLED is flipped on. */
const IDLE_TIMEOUT_SECONDS = 65;

/** Bound the graceful drain, mirroring apps/workers/src/index.ts: in-flight requests get this long to finish
 *  before we close the pool and exit anyway. Comfortably exceeds a healthy request; a wedged one is abandoned. */
const DRAIN_TIMEOUT_MS = 15_000;

// Registers the role-cache invalidator into @leadwolf/db's seam so a membership mutation clears this
// process's cached role. A no-op unless ROLE_CACHE_TTL_MS is set — and it must run BEFORE the first request,
// or a mutation early in the process's life would leave a stale entry behind.
installRoleCacheInvalidator();

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  idleTimeout: IDLE_TIMEOUT_SECONDS,
});

// Graceful shutdown. Without this, every `docker compose up -d` recreate (i.e. every deploy) drops whatever
// was in flight, and the shared postgres.js pool is never drained. Order matters: fail readiness first so the
// edge stops sending new work, then stop accepting, then close the pool.
async function shutdown(signal: string): Promise<void> {
  if (!beginDraining()) return; // ignore repeated signals while a drain is already in flight
  console.info(`api: draining (${signal})`);
  const drained = await Promise.race([
    // stop() without `true` lets in-flight requests complete instead of severing their connections.
    Promise.resolve(server.stop()).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS)),
  ]);
  if (!drained) console.error(`api: drain timed out after ${DRAIN_TIMEOUT_MS}ms, closing anyway`);
  await closeDb().catch(() => {});
  console.info("api: drained, exiting");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
