# 19 — Observability & Reliability (SRE)

> How we **see** the system and **keep it up**: telemetry, SLOs + error budgets, alerting, on-call,
> incident response, disaster recovery, chaos testing, and FinOps. Operationalizes the performance
> contract in [18](./18-scalability-performance.md) and the tooling sketched in [02 §9](./02-architecture.md).

## 1. Telemetry (the three signals)

| Signal | Tooling ([01](./01-tech-stack.md), [02 §9](./02-architecture.md)) | Scope |
|---|---|---|
| **Metrics** | CloudWatch + Grafana | RED (rate/errors/duration) per endpoint; queue depth/age; DB/replica/Redis; provider/AI cost |
| **Logs** | CloudWatch Logs (structured JSON) | one correlation/request id; `tenant_id`/`workspace_id` tags; **no PII** in logs |
| **Traces** | AWS X-Ray | request → DB/search/queue/provider/AI spans |
| **Errors** | GlitchTip (Sentry-compatible) | exceptions with release + tenant context |
| **Product** | PostHog | funnels, feature usage, Data-Health adoption |
| **Synthetics** | CloudWatch Synthetics | login, search, reveal canaries per region |

Every log/trace carries the request correlation id and tenant/workspace tags so any incident is filterable
by customer. PII never enters logs/traces (encrypted fields stay masked, `03 §2`).

## 2. SLOs & error budgets

- The [18 §2](./18-scalability-performance.md) latency/availability/freshness targets are the **SLOs**.
- Each SLO has a **monthly error budget** (e.g. 99.9% ⇒ ~43 min/mo). Budget **burn rate** is alerted
  (fast-burn + slow-burn windows).
- **Budget policy:** when an SLO's budget is exhausted, risky releases for that surface pause until burn
  recovers; this gates `10` milestone ship decisions.

## 3. Alerting & on-call

- **Symptom-based alerts** (SLO burn, error rate, queue age, DLQ growth, replica lag, budget overrun)
  over cause-based noise.
- **Severity ladder** (SEV1 customer-down → SEV3 degraded) with documented response times.
- **On-call** rotation + escalation; every alert links to a **runbook** (§5). Alert hygiene reviewed so
  pages stay actionable.

## 4. Reliability primitives

- **Multi-AZ** across 3 AZs for ALB/ECS/Aurora/ElastiCache/Typesense/OpenSearch/ClickHouse ([01 §3](./01-tech-stack.md)).
- **Health checks + graceful drain** on deploys (blue/green, `01 §6`); circuit breakers on providers/AI
  (`06 §6`, `23`); typed `503` with `Retry-After` on saturation (`18 §4`).
- **Idempotent** money/automation paths (`H2`, `20`) make retries safe.

## 5. Incident response & runbooks

- **Lifecycle:** detect → triage (severity) → mitigate → communicate (Status page, `13`) → resolve →
  **blameless postmortem** with action items tracked to closure.
- **Runbooks** (in the infra repo, linked here) for: DB failover, replica lag, queue/DLQ backlog, search
  reindex, provider/AI outage, credential rotation, suppression/DSAR escalation.

## 6. Disaster recovery

- **Targets:** **RTO 1 h / RPO 5 min** ([01 §7](./01-tech-stack.md), [ADR-0010](./decisions/ADR-0010-aws-native-self-hosted-stack.md)).
- **Mechanisms:** Aurora PITR + **cross-region warm standby**; S3 cross-region replication; Terraform-coded
  infra for region rebuild; secrets in Secrets Manager (KMS).
- **Failover:** documented, **partly automated** promotion runbook (DNS/endpoint cutover, GUC/role checks);
  **backup-restore is verified** on a schedule (quarterly drill restores to an isolated env and runs the
  search/DB smoke suite) — a restore that isn't tested isn't a backup.

## 7. Chaos engineering & game days

- Scheduled **fault injection** in staging: kill ECS tasks, sever a provider, lag a replica, fill a queue,
  drop an AZ. Validate autoscale, backpressure (`18 §9`), circuit breakers, and SLO adherence.
- **Game days** rehearse SEV1 + DR failover so RTO/RPO are real, not aspirational.

## 8. FinOps — cost monitoring & attribution

- **Cost telemetry:** AWS Cost Explorer + budgets/anomaly alerts; provider (`provider_calls.cost_micros`)
  and AI (`ai_requests`, `23`) spend metered.
- **Attribution:** cost tagged by tenant/workspace/team (the denormalized `tenant_id`/`workspace_id`,
  `03 §2`) → per-tenant cost + margin; per-team budgets (`H18`, `07`) reconcile against spend.
- **Chargeback/optimization:** unit-economics dashboard (cost-per-reveal, cost-per-verified-record,
  AI-cost-per-tenant) drives pricing (`07`) and optimization runbooks (rightsizing, cache hit-rate,
  Haiku-vs-Opus routing `23`).

## Links
- **Links to:** [01 §3/§6/§7](./01-tech-stack.md), [02 §7/§9](./02-architecture.md), [18](./18-scalability-performance.md),
  [10](./10-roadmap.md), [13](./13-platform-admin.md), [20](./20-event-driven-realtime-backbone.md),
  [23](./23-ai-intelligence-layer.md), [ADR-0010](./decisions/ADR-0010-aws-native-self-hosted-stack.md),
  [ADR-0024](./decisions/ADR-0024-performance-slos-and-capacity-model.md)
- **Linked from:** [00 §7](./00-overview.md#7-decision-log), [10](./10-roadmap.md), [13](./13-platform-admin.md), README

## Open questions
1. On-call staffing model + paging tool (PagerDuty vs. Opsgenie) at GA.
2. Error-budget policy enforcement: advisory vs. hard release-freeze, by surface.
3. DR failover automation depth (one-click vs. runbook-guided) for GA.
