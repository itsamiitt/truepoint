// @leadwolf/forge-api entry — Bun.serve over the Hono app, composing the REAL deps from env. Re-homed from
// @forge/api: authentication is the EXISTING @leadwolf/auth (resolveStaff/resolveCaller in ./middleware/auth.ts),
// and every Forge repo call runs under withForgeTx (@leadwolf/db) — there is NO createDb here, the tx wrapper
// owns the leadwolf_forge connection. The DB/Redis/object-store are not exercised locally (staging/CI); this
// wiring only has to typecheck. Capture + sync egress stay DARK until the gating flags flip (ADR-0046).

import { checkRequestRate } from "@leadwolf/auth";
import {
  ENDPOINT_ALLOWLIST,
  ENVELOPE_MAX_BYTES,
  PAYLOAD_BYTE_LIMIT_PER_MIN,
  RECORD_LIMIT_PER_MIN,
  RECORD_MAX_BYTES,
  env,
  forgeFlags,
  forgeS3Config,
  isTenantCaptureEnabled,
} from "@leadwolf/config";
import {
  type Tx,
  closeDb,
  getApprovalRequest,
  getOverviewCounts,
  getSyncStatusCounts,
  landRawCapture,
  listParsers,
  listRecentCaptures,
  listReviewTasks,
  promoteVerifiedRecord,
  userRepository,
  withForgeTx,
} from "@leadwolf/db";
import { type LandDeps, type PromotionCandidate, landEnvelope } from "@leadwolf/forge-core";
import { forgeObjectStore, forgeRateLimiter } from "@leadwolf/integrations";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { createForgeApi } from "./app.ts";
import { resolveCaller, resolveStaff } from "./middleware/auth.ts";

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
// The "forge-" prefix keeps this producer distinct from the existing "parse" queue (apps/workers).
const parseQueue = new Queue("forge-parse", { connection });

const objectStore = forgeObjectStore(forgeS3Config);

/** Build the per-tx LandDeps: the store binds to the injected tx; the object store + parse queue are shared. */
function makeLandDeps(tx: Tx): LandDeps {
  return {
    store: { land: (row) => landRawCapture(tx, row) },
    objectStore, // real S3/MinIO (Phase 4)
    newBatchId: () => crypto.randomUUID(),
  };
}

const app = createForgeApi({
  // Real coarse throttle + the /metrics secret. Both are injected rather than imported inside the app factory so
  // the test harness composes the same app without a Redis client or a live secret.
  rateLimit: checkRequestRate,
  metricsToken: env.METRICS_TOKEN,
  captures: {
    // Land verbatim in ONE leadwolf_forge tx; enqueue parse AFTER it commits (P-01.7) so a parse job is never
    // dispatched before its raw_captures row exists and a rolled-back envelope enqueues nothing. jobId = content
    // hash keeps an accidental double-enqueue a no-op.
    land: async (envelope) => {
      const { ack, landed } = await withForgeTx((tx) => landEnvelope(makeLandDeps(tx), envelope));
      await Promise.all(
        landed.map((contentHash) =>
          parseQueue.add("forge-parse", { contentHash }, { jobId: contentHash }),
        ),
      );
      return ack;
    },
    rateLimit: forgeRateLimiter(connection, {
      recordLimit: RECORD_LIMIT_PER_MIN,
      byteLimit: PAYLOAD_BYTE_LIMIT_PER_MIN,
    }),
    resolveCaller,
    gate: { captureEnabled: forgeFlags.captureEnabled, isTenantEnabled: isTenantCaptureEnabled },
    caps: {
      maxEnvelopeBytes: ENVELOPE_MAX_BYTES,
      maxRecordBytes: RECORD_MAX_BYTES,
      endpointAllowlist: ENDPOINT_ALLOWLIST,
    },
  },
  bff: {
    resolveStaff,
    readers: {
      // DB-backed (Phase 3), each read under its own withForgeTx — the shape is the console's contract (13 §5):
      // the OverviewSummary the console renders (count tiles + the recent-captures feed), NOT the raw
      // medallion funnel — serving the funnel here crashed the Overview page on `recentCaptures.length`.
      overview: () =>
        withForgeTx(async (tx) => {
          const counts = await getOverviewCounts(tx);
          const recent = await listRecentCaptures(tx, 8);
          return {
            ...counts,
            recentCaptures: recent.map((r) => ({
              id: r.id,
              source: r.source,
              status: r.status,
              capturedAt: r.capturedAt.toISOString(),
            })),
          };
        }),
      reviewTasks: () => withForgeTx((tx) => listReviewTasks(tx)),
      parsers: () => withForgeTx((tx) => listParsers(tx)),
      syncStatus: () => withForgeTx((tx) => getSyncStatusCounts(tx)),
      captures: () =>
        withForgeTx(async (tx) => {
          const rows = await listRecentCaptures(tx);
          return { captures: rows.map((r) => ({ ...r, capturedAt: r.capturedAt.toISOString() })) };
        }),
      // Owner-connection read of the caller's OWN identity (same posture as resolveStaff's platform_staff
      // read). Mapped to { email } only — UserRecord carries passwordHash and must never cross this seam.
      identity: async (userId) => ({
        email: (await userRepository.findById(userId))?.email ?? null,
      }),
    },
  },
  review: {
    resolveStaff,
    // the four-eyes promotion write-set (verified_records + sync_outbox in one tx), Phase 5.
    promote: (input) => withForgeTx((tx) => promoteVerifiedRecord(tx, input)),
    // Load the maker + candidate from the persisted approval_request (P-01.10) — never the request body.
    loadApprovalRequest: (id) =>
      withForgeTx(async (tx) => {
        const row = await getApprovalRequest(tx, id);
        return row
          ? {
              requestedByUserId: row.requestedByUserId,
              status: row.status,
              candidate: row.payload as PromotionCandidate,
            }
          : null;
      }),
  },
});

const port = Number(process.env.FORGE_API_PORT ?? 3005);

/** Idle timeout (seconds). Bun's default is 10s; raised for parity with apps/api so a slow capture upload on a
 *  poor connection is not severed mid-body. */
const IDLE_TIMEOUT_SECONDS = 65;

/** Bound the graceful drain, mirroring apps/api and apps/workers. */
const DRAIN_TIMEOUT_MS = 15_000;

let draining = false;

// An explicit Bun.serve (rather than `export default { port, fetch }`) so shutdown has a handle to stop
// accepting connections. `maxRequestBodySize` is pinned to the SAME envelope cap the capture route enforces:
// without it Bun's 128MB default means a single request is fully buffered into memory and JSON.parsed BEFORE
// the route's 413 can fire, so the cap was bypassable by simply sending a big body.
const server = Bun.serve({
  port,
  fetch: app.fetch,
  maxRequestBodySize: ENVELOPE_MAX_BYTES,
  idleTimeout: IDLE_TIMEOUT_SECONDS,
});

// Graceful shutdown. This matters more here than in apps/api: the capture route COMMITS the landing tx and
// THEN enqueues the parse job, so a SIGTERM inside that window permanently loses the enqueue (the
// reconciliation sweep that would recover it is still a TODO in the worker). Draining in-flight requests
// closes that window for the common case. Redis and the DB pool are closed after the drain, not before.
async function shutdown(signal: string): Promise<void> {
  if (draining) return;
  draining = true;
  console.info(`forge-api: draining (${signal})`);
  const drained = await Promise.race([
    Promise.resolve(server.stop()).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS)),
  ]);
  if (!drained)
    console.error(`forge-api: drain timed out after ${DRAIN_TIMEOUT_MS}ms, closing anyway`);
  await parseQueue.close().catch(() => {});
  await connection.quit().catch(() => {});
  await closeDb().catch(() => {});
  console.info("forge-api: drained, exiting");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
