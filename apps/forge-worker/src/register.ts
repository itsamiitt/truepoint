// register — the forge-worker composition root. One shared Redis connection, per-stage Queue producers (all
// `forge-` prefixed so they never collide with the existing apps/workers queues), the real stage deps (S3 blob,
// the Anthropic port, the forge-core parser registry), and a real BullMQ Worker per active stage. Retry/
// deadline/DLQ/leader-lock come from the local primitives. The sync worker is created only when the egress flag
// is on (dark by default, ADR-0047).
import { forgeExtractConfig, forgeFlags, forgeS3Config } from "@leadwolf/config";
import { env } from "@leadwolf/config";
import { ParserRegistry, registerBuiltinParsers } from "@leadwolf/forge-core";
import {
  anthropicExtractionPort,
  defaultAnthropicTransport,
  forgeObjectStore,
} from "@leadwolf/integrations";
import { type Job, Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { buildDeadLetter } from "./deadLetter.ts";
import { asLockRedis, withLeaderLock } from "./leaderLock.ts";
import {
  type ProcessorDeps,
  makeExtractProcessor,
  makeMaintenanceProcessor,
  makeParseProcessor,
  makeResolveProcessor,
  makeSyncProcessor,
  makeVerifyProcessor,
} from "./processors.ts";
import { retryFor } from "./retryPolicies.ts";
import { concurrencyFor, deadlineFor } from "./tuning.ts";
import { withDeadline } from "./withDeadline.ts";

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

// Repeatable-scheduler cadences (P-01.4) — tunable operational defaults.
const SYNC_DRAIN_MS = 10_000; // drain up to 50 sync_outbox rows every 10s
const MAINTENANCE_TICK_MS = 60_000; // reconcile/decay tick every 60s (matches the leader-lock TTL)

function makeQueue(stage: string): Queue {
  const { attempts, backoff } = retryFor(stage);
  return new Queue(`forge-${stage}`, {
    connection,
    defaultJobOptions: {
      attempts,
      backoff,
      // Redis hygiene — mirror the platform queues (apps/api import/reveal/reverification): completed jobs age
      // out (24h or last 1000) so Redis doesn't grow unbounded (the #1 BullMQ outage class); failed jobs are
      // KEPT for inspection/DLQ triage (P-01.17).
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: false,
    },
  });
}

export const queues = {
  captureIngest: makeQueue("capture-ingest"),
  parse: makeQueue("parse"),
  aiExtract: makeQueue("ai-extract"),
  extract: makeQueue("extract"),
  resolve: makeQueue("resolve"),
  verify: makeQueue("verify"),
  quality: makeQueue("quality"),
  sync: makeQueue("sync"),
  maintenance: makeQueue("maintenance"),
} as const;

const registry = new ParserRegistry();
registerBuiltinParsers(registry);

const deps: ProcessorDeps = {
  blob: forgeObjectStore(forgeS3Config),
  registry,
  extractPort: anthropicExtractionPort({
    apiKey: forgeExtractConfig.apiKey,
    baseUrl: forgeExtractConfig.baseUrl,
    version: forgeExtractConfig.version,
    model: forgeExtractConfig.model,
    fetchJson: defaultAnthropicTransport,
  }),
  queues: { aiExtract: queues.aiExtract, resolve: queues.resolve, verify: queues.verify },
  leader: (fn) =>
    withLeaderLock(asLockRedis(connection), "forge:maintenance", 60_000, crypto.randomUUID(), fn),
};

function makeWorker<T>(stage: string, processor: (job: Job<T>) => Promise<void>): Worker<T> {
  const worker = new Worker<T>(
    `forge-${stage}`,
    withDeadline(stage, deadlineFor(stage), processor),
    {
      connection,
      concurrency: concurrencyFor(stage),
    },
  );
  worker.on("failed", (job, err) => {
    const dead = buildDeadLetter({
      queue: `forge-${stage}`,
      jobId: job?.id ?? "unknown",
      error: err?.message ?? String(err),
      attemptsMade: job?.attemptsMade ?? 0,
      maxAttempts: retryFor(stage).attempts,
    });
    if (dead) console.error(`[forge-dlq] ${JSON.stringify(dead)}`);
  });
  return worker;
}

/** Boot the active-DAG workers. Sync is created only when the egress is enabled (dark by default). */
export function startWorkers(): { queues: string[]; workers: Worker[]; env: string } {
  const workers: Worker[] = [
    makeWorker("parse", makeParseProcessor(deps)),
    makeWorker("ai-extract", makeExtractProcessor(deps)),
    makeWorker("resolve", makeResolveProcessor(deps)),
    makeWorker("verify", makeVerifyProcessor(deps)),
    makeWorker("maintenance", makeMaintenanceProcessor(deps)),
  ];
  // Repeatable schedulers (P-01.4): nothing else enqueues forge-maintenance / forge-sync, so without these the
  // maintenance tick never fires and the sync outbox never drains. BullMQ dedups repeatable jobs by their repeat
  // key, so registering on every boot is idempotent; the maintenance processor is leader-locked (single writer
  // across replicas) and the sync drain is effectively-once (applyItem dedups on event_id). The sync scheduler is
  // gated with its worker so drain jobs are never enqueued without a consumer.
  void queues.maintenance.add("forge-maintenance-tick", {}, { repeat: { every: MAINTENANCE_TICK_MS } });
  if (forgeFlags.syncEgressEnabled) {
    workers.push(makeWorker("sync", makeSyncProcessor(deps)));
    void queues.sync.add("forge-sync-drain", {}, { repeat: { every: SYNC_DRAIN_MS } });
  }
  return { queues: Object.keys(queues), workers, env: env.NODE_ENV };
}
