# 12 — Observability

> **Priority:** P1 (a feature you cannot see is a feature you cannot operate) · **Effort:** ~6–9 eng-weeks
> · **Phase:** F1 (baseline) → F2 (SLOs + DATA plane) · Cite problems as **P-01.x**.

## Executive summary

Forge is effectively unobservable. It logs with bare `console.*`, forge-api logs nothing on error
(a 500's cause is invisible), and `/metrics` emits static gauges (`forge_api_up 1`,
`forge_workers_up`) with no queue depth, latency, failure, stage, or token-spend signal
(P-01.27). There is no distributed tracing, no request IDs, and no SLOs. The irony is that
`packages/forge-core/src/observability.ts` already ships the *right* primitives — a Prometheus
renderer, a `DEFAULT_SLOS` table (capture 300 ms, parse 5 s, extract 30 s, sync 60 s), an alert
classifier, and a queue-depth autoscale formula — but they are **unused in production**
(fact-pack §3.1/§5). The work is therefore less "invent observability" and more "wire up what exists,
propagate context through jobs, and add the metrics that reveal a silent break."

The recommendation is the small-team standard: **OpenTelemetry for traces and context propagation
through job payloads, a `forge_*` metrics catalog centered on age-of-oldest and DLQ rate, freshness
SLOs per stage, and a single ClickHouse-backed observability app (SigNoz)** rather than a
three-system Grafana LGTM stack. This ties directly to the ClickHouse recommendation in
`09-storage-strategy.md` and the per-record pipeline-state table in `08-pipeline-architecture.md`,
which is the product-facing lineage layer that no amount of queue introspection can replace.

## Current state

- **Logging:** `console.info/warn/error` only — worker boot/shutdown, the quarantine warn
  (`processors.ts:80`), the DLQ error (`register.ts:85`), the maintenance tick. forge-api logs
  nothing (no request log, no error log).
- **Metrics:** `renderPrometheus` emits bare `name value` lines with no HELP/TYPE
  (`observability.ts:15-26`); forge-api exposes constant `forge_api_up 1` (`app.ts:19`); the worker
  exposes `forge_workers_up`/`forge_worker_count`. No queue, latency, failure, or spend metrics.
- **Tracing:** none. No OTel imports, no request IDs.
- **Spend telemetry:** `extraction_runs` rows never populate `latency_ms`/`input_tokens`/
  `output_tokens` even though the Anthropic port returns them (`extraction.ts:283-303`) — token
  spend is unmeasured (P-01.21).
- **Unused assets:** `DEFAULT_SLOS`, `classifyAlerts`, `desiredWorkers` (`observability.ts:28-93`)
  have zero production callers.
- **Design intent (planning doc-15):** two OTel planes — a SYSTEM plane and a DATA plane (five
  monitors per medallion layer: freshness, volume, schema, distribution, lineage), PII-free by
  construction, `forge_*` prefix, `outbox_oldest_pending_seconds` as the sync page signal
  (fact-pack §2.1).

## Problems identified

- **P-12.1 (= P-01.27) — DEBT · No usable telemetry.** Static `/metrics` and `console.*` logging
  mean a silent break is invisible; the first incident question ("since when?") has no answer.
- **P-12.2 — DEBT · No context propagation.** Without a trace ID threaded through the BullMQ payload,
  a slow capture→verify flow cannot be followed across api → queue → worker → provider.
- **P-12.3 (= P-01.21) — DEBT · Spend is unmeasured**, so the metered-enrichment FinOps discipline
  (`15-cost-optimization.md`) has nothing to meter against.
- **P-12.4 — DEBT · The shipped observability helpers are dead code**, so the SLO/alert intent exists
  only on paper.
- **P-12.5 — RISK · `/metrics` is unauthenticated and public** (`13-security.md` P-13.10) — both a
  security exposure and, once real metrics land, an information-disclosure surface.

## Research findings

- **OTel context propagation through job payloads is the standard** (inject W3C trace context at
  enqueue, extract in the worker); BullMQ shipped official OTel support in Nov 2024 via `bullmq-otel`
  ([announcement](https://bullmq.io/news/241104/telemetry-support/)).
- **The metrics that matter for a pipeline:** queue depth, **age-of-oldest-message** (the canonical
  staleness signal — SQS made it first-class), arrival-vs-drain rate, per-stage latency percentiles,
  retry counts, DLQ depth + arrival rate, and error-class distribution
  ([AWS SQS oldest-message metric](https://aws.amazon.com/about-aws/whats-new/2016/08/new-amazon-cloudwatch-metric-for-amazon-sqs-monitors-the-age-of-the-oldest-message/),
  [Datadog data-streams](https://www.datadoghq.com/blog/data-streams-monitoring-sqs/)).
- **SLO practice:** define freshness SLOs per stage ("95% of records verified within 10 minutes");
  page on burn rate (>5× expected for >10 min) and on oldest-age > 5× SLO, not on raw depth
  ([queue-backlog SLO account](https://medium.com/@systemdesignwithsage/the-queue-backlog-that-slowly-eroded-our-system-slos-bc7503941d2d)).
- **Stack for a small team:** a single ClickHouse-backed platform (SigNoz; or HyperDX/ClickStack,
  ClickHouse-acquired Mar 2025) beats Grafana LGTM, which is three stateful systems with three query
  languages and UI-level correlation
  ([ClickHouse OSS observability](https://clickhouse.com/resources/engineering/best-open-source-observability-solutions),
  [SigNoz](https://signoz.io/grafana-alternative/)).
- **Per-record lineage is a Postgres table** partitioned by batch and aggregated into per-batch
  counters for the UI — never derived from queue introspection (`08-pipeline-architecture.md`).

## Enterprise best practices

Every service emits all three signals — structured PII-free logs (event name, `requestId`,
`traceId`, tenant id, status), traces that follow a request across services and into the jobs it
enqueues, and RED/USE metrics — and every critical path has an SLO that drives burn-rate alerting.
Observability is wired at build time (a success signal, an alertable error, a dashboard that would
show a silent drop, and a one-line runbook), not bolted on after the first incident. For a data
platform specifically, the DATA plane (freshness/volume/schema/distribution monitors per layer) is
as important as the SYSTEM plane, because a pipeline can be green on RED metrics while silently
producing garbage.

## Recommended architecture

**Baseline (F1):**
- **Structured, PII-free JSON logging** in forge-api and forge-worker, correlated by `requestId`/
  `traceId`; forge-api logs every error with enough context to act and zero PII.
- **OpenTelemetry** via `bullmq-otel`: a trace ID minted at the capture edge, propagated in the job
  payload through parse → extract → resolve → verify → sync and into the Anthropic call.
- **A real `forge_*` metrics catalog** (wire up `renderPrometheus`), with proper HELP/TYPE:

| Metric | Type | What it reveals |
|---|---|---|
| `forge_capture_ack_seconds` | histogram | Ingest latency (SLO 300 ms p95) |
| `forge_queue_depth{queue}` | gauge | Backlog per stage |
| `forge_queue_oldest_seconds{queue}` | gauge | **Staleness — the primary page signal** |
| `forge_stage_latency_seconds{stage}` | histogram | Per-stage duration |
| `forge_stage_failures_total{stage,error_class}` | counter | Failure rate + taxonomy |
| `forge_dlq_depth{queue}` / `forge_dlq_arrivals_total` | gauge/counter | Dead-letter health |
| `forge_extraction_cost_micros_total{tenant,model}` | counter | AI spend (feeds `15`) |
| `forge_grounding_ratio` | histogram | Extraction quality (feeds `11`) |
| `forge_outbox_oldest_pending_seconds` | gauge | Sync freshness (page > SLO) |

**SLOs + DATA plane (F2):**
- Freshness SLOs per stage as a table (capture ack 300 ms p95; parse/extract/resolve within N min;
  "95% verified within 10 min"; `outbox_oldest_pending_seconds` page), driving burn-rate alerts.
- The **DATA plane**: five monitors per medallion layer — freshness (age of newest row), volume
  (row-count deltas vs trailing window, z-score), schema (payload-shape hash drift), distribution
  (per-field null/enum distributions), lineage (records with complete provenance). These reuse the
  same per-batch metrics table the DQ framework builds (`04-data-quality-framework.md`).
- **SigNoz** self-hosted on the ClickHouse from `09-storage-strategy.md` — one app, one query
  surface, logs/traces/metrics correlated.
- **Per-record lineage/status** surfaced from the Postgres `pipeline_state` table
  (`08-pipeline-architecture.md`) into the operator console's Jobs and Data-quality surfaces.

```text
capture-edge ──trace-id──► parse ──► extract ──► resolve ──► verify ──► sync
     │            (propagated in job payload; span per stage)            │
     ▼                                                                   ▼
  forge_capture_ack_seconds        forge_stage_* / forge_dlq_*     forge_outbox_oldest_pending_seconds
     └──────────────► OTel collector ──► SigNoz (ClickHouse) ──► dashboards + burn-rate alerts
  per-record status ─► forge.pipeline_state (Postgres, partitioned) ─► console Jobs/DQ surfaces
```

### Concrete wiring

OTel init + trace-context propagation through the job payload (the plumbing that makes a slow
capture→verify flow followable across api → queue → worker → Anthropic):

```ts
// apps/forge-api/src/instrumentation.ts (new) — imported first, before the Hono app
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
new NodeSDK({ traceExporter: new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_ENDPOINT }) }).start();

// producer (forge-api): inject W3C trace context into the job so the worker continues the trace
import { propagation, context } from "@opentelemetry/api";
const carrier: Record<string, string> = {};
propagation.inject(context.active(), carrier);
await parseQueue.add("forge-parse", { contentHash, _otel: carrier }, { jobId: contentHash });

// consumer (forge-worker): extract and run the handler inside the propagated span
const ctx = propagation.extract(context.active(), job.data._otel ?? {});
await context.with(ctx, () => tracer.startActiveSpan(`forge.${stage}`, async (span) => {
  try { await handler(job); } finally { span.end(); }
}));
```

Wire the already-shipped `packages/forge-core/src/observability.ts` helpers into a real registry so
`/metrics` reports the catalog above instead of a static gauge:

```ts
// forge-worker: emit real per-stage signals (renderPrometheus already exists, it just has no callers)
const stageLatency = new Histogram({ name: "forge_stage_latency_seconds", labelNames: ["stage"] });
const dlqDepth     = new Gauge({ name: "forge_dlq_depth", labelNames: ["queue"] });
const oldest       = new Gauge({ name: "forge_queue_oldest_seconds", labelNames: ["queue"] });

worker.on("completed", (job) => stageLatency.observe({ stage }, (Date.now() - job.timestamp) / 1000));
setInterval(async () => {                              // sampled, bounded label set (queue, not per-record)
  for (const q of QUEUES) {
    dlqDepth.set({ queue: q.name }, await q.getFailedCount());
    const [head] = await q.getWaiting(0, 0);
    oldest.set({ queue: q.name }, head ? (Date.now() - head.timestamp) / 1000 : 0);
  }
}, 15_000);
// also: populate extraction_runs.{latency_ms,input_tokens,output_tokens} from the port return
// (extraction.ts:283-303 currently omits them — the FinOps signal in 15-cost-optimization.md)
```

Alert on staleness and SLO burn, not raw depth (the freshness SLO from `DEFAULT_SLOS`):

```yaml
# sync freshness — page when the outbox stops draining (the design's outbox_oldest_pending_seconds signal)
- alert: ForgeSyncStalled
  expr: forge_outbox_oldest_pending_seconds > 300      # 5× the 60s sync SLO
  for: 2m
  labels: { severity: page }                           # runbook: sync-failure = P1 (truepoint-operations)
# capture ack SLO burn (300ms p95 target from DEFAULT_SLOS)
- alert: ForgeCaptureAckSLOBurn
  expr: histogram_quantile(0.95, rate(forge_capture_ack_seconds_bucket[5m])) > 0.3
  for: 10m
```

## Implementation details

- `apps/forge-api/src/instrumentation.ts` (new) + `apps/forge-worker/src/instrumentation.ts` (new):
  OTel init; wrap the Hono app and BullMQ workers with `bullmq-otel`.
- Replace `console.*` with a structured logger (reuse the pattern of `apps/workers/src/logger.ts`);
  add request-id middleware to forge-api.
- Wire `packages/forge-core/src/observability.ts` (`renderPrometheus`, `DEFAULT_SLOS`,
  `classifyAlerts`, `desiredWorkers`) into real registries; populate `extraction_runs` token/latency
  fields from the port return (`extraction.ts:283-303`).
- Deploy SigNoz alongside ClickHouse (`docker-compose.prod.yml`); restrict `/metrics` to internal
  scrapers (`13-security.md`).
- Dashboards + a one-line runbook per critical path (`truepoint-operations` runbooks): sync-failure =
  P1 (`outbox_oldest_pending_seconds` breach), DLQ growth, capture-ack SLO burn, grounding-ratio
  drop, per-tenant spend spike.

## Migration strategy

Purely additive; nothing to backfill. Land the baseline in F1 so the F1 correctness work is itself
observable (the E2E itest can assert metrics), then layer SLOs, the DATA plane, and SigNoz in F2 once
ClickHouse exists.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| PII leaks into logs/traces | Medium | High | PII-free-by-construction logging; log IDs/shapes, never payloads; a log-scrubbing test |
| Metric cardinality blows up ClickHouse | Low | Medium | Bounded label sets (stage/queue/tenant-bucket, not per-record) |
| Alert fatigue from raw-depth alerts | Medium | Medium | Alert on burn rate + oldest-age, not depth |

## Success metrics

- A 500 in forge-api produces a structured, PII-free error log with a request/trace id.
- `/metrics` exposes queue depth, age-of-oldest, DLQ size, per-stage latency, and token spend.
- Every critical path has a freshness SLO and a burn-rate alert with a runbook line.
- The DATA-plane monitors would fire on a payload-shape drift or a per-field null-rate spike within
  minutes (the DOM-change early warning).

## Effort & priority

**P1**, ~3–4 eng-weeks for the F1 baseline (logging, OTel, real metrics) and ~3–5 for the F2 SLOs +
DATA plane + SigNoz. It is sequenced immediately after the F1 correctness fixes because those fixes
should ship observable.

## Future enhancements

Trace-based exemplars linking a slow SLO burn to the exact record and provider call; automated
anomaly detection on the DATA-plane distributions (beyond z-score) once history accumulates
(`11-ai-assisted-processing.md`); customer-facing pipeline-status transparency for enterprise tenants.
