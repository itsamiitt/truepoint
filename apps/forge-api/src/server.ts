// @leadwolf/forge-api entry — Bun.serve over the Hono app, composing the REAL deps from env. Re-homed from
// @forge/api: authentication is the EXISTING @leadwolf/auth (resolveStaff/resolveCaller in ./middleware/auth.ts),
// and every Forge repo call runs under withForgeTx (@leadwolf/db) — there is NO createDb here, the tx wrapper
// owns the leadwolf_forge connection. The DB/Redis/object-store are not exercised locally (staging/CI); this
// wiring only has to typecheck. Capture + sync egress stay DARK until the gating flags flip (ADR-0046).
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
  getPipelineOverviewCounts,
  getSyncStatusCounts,
  landRawCapture,
  listParsers,
  listReviewTasks,
  promoteVerifiedRecord,
  withForgeTx,
} from "@leadwolf/db";
import { type LandDeps, landEnvelope } from "@leadwolf/forge-core";
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
    enqueue: {
      enqueue: async (jobId, data) => {
        await parseQueue.add("forge-parse", data, { jobId });
      },
    },
    newBatchId: () => crypto.randomUUID(),
  };
}

const app = createForgeApi({
  captures: {
    // Land verbatim + enqueue parse inside ONE leadwolf_forge tx (withForgeTx owns the connection).
    land: (envelope) => withForgeTx((tx) => landEnvelope(makeLandDeps(tx), envelope)),
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
      // DB-backed (Phase 3), each read under its own withForgeTx — the shape is the console's contract (13 §5).
      overview: () => withForgeTx((tx) => getPipelineOverviewCounts(tx)),
      reviewTasks: () => withForgeTx((tx) => listReviewTasks(tx)),
      parsers: () => withForgeTx((tx) => listParsers(tx)),
      syncStatus: () => withForgeTx((tx) => getSyncStatusCounts(tx)),
    },
  },
  review: {
    resolveStaff,
    // the four-eyes promotion write-set (verified_records + sync_outbox in one tx), Phase 5.
    promote: (input) => withForgeTx((tx) => promoteVerifiedRecord(tx, input)),
  },
});

const port = Number(process.env.FORGE_API_PORT ?? 3005);

export default { port, fetch: app.fetch };
