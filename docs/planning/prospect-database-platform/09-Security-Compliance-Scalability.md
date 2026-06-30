# 09 — Security, Compliance & Scalability

> **Series:** [Prospect Database Platform](./README.md) · **Phase:** 09 · **Status:** ✅ Drafted
> · **Prev:** [`08-Database-Operations-Module`](./08-Database-Operations-Module.md) · **Next:** `10-Implementation-Roadmap`

---

## 1. Executive Summary

The platform multiplies data **sources, volume, and PII egress**, so security/compliance/scale are first-class.
This phase extends [`database-management-research/12`](../database-management-research/12-Security-and-Compliance.md)
(security) + [`…/13`](../database-management-research/13-Performance-and-Scaling.md) (scaling) to the new ingestion,
knowledge-DB, and extension surfaces. **Security has final say** on every tenancy/PII/consent/egress point.

## 2. Security & tenant isolation

- **RLS everywhere.** Overlay tables stay workspace-scoped (`withTenantTx`); the master graph is system-owned
  (`withErTx`/owner); cross-tenant staff ops go through audited `withPlatformTx`. Every new ingestion/ops endpoint
  is tenant-scoped + ownership-checked + capability-gated (`data:*`).
- **The owner-path suppression rule.** The shipped lesson (export Phase 2): any privileged/owner read that gates on
  suppression must use the **explicit-scope** matcher (`findMatchExplicit`), never RLS-dependent `findMatch` — the
  owner bypasses RLS. Every cross-tenant PII path in this platform inherits that rule.
- **PII at rest + in transit.** Email/phone encrypted (`encryptPii`; the documented KMS/envelope seam is a prod
  upgrade); raw ingestion payloads (incl. extension captures) encrypted + retention-swept; blind indexes (HMAC)
  never leave the DB.
- **Reveal/egress gating.** PII egress (export, reveal, extension surface) is **suppression-gated** + audited +
  (for customers) charged. Activate `master_persons.is_suppressed` (P16) so Layer-0 reads are gated too.

## 3. Compliance

- **Consent & sources.** Contributory + extension capture require recorded **consent context + source URL +
  captured-at**; web-form/email-signature sources carry consent. ToS/scraping posture: authorized-view-only,
  rate-limited, robots/ToS-respecting (the BrowserGate guardrails, Phase 06).
- **Residency (GDPR / India DPDP / CCPA / TCPA).** Region/jurisdiction columns (`master_persons.region/
  jurisdiction`) drive residency; EU data stays in-region; exports exclude residency-restricted rows unless
  region-pinned. DSAR delete fans out to evidence + projection + suppression (extend the shipped fan-out to
  `source_records` + `is_suppressed`).
- **Audit immutability.** `audit_log` (tenant) + `platform_audit_log` (staff) are append-only; ingestion, merges,
  enrichment runs, exports, and queue decisions are all audited; lineage provides the "why".
- **Retention.** The shipped retention engine sweeps evidence + raw payloads per class (shadow→enforce, approval-
  gated).

## 4. Abuse & edge defense

- Rate-limit ingestion (esp. extension) per user/tenant; bot/scraping defense; idempotency caps; per-tenant
  enrichment budget breakers (cost-abuse). Telephony (phone reveal) stays TCPA/DNC-aware.

## 5. Scalability (the 10× question)

- **Reads** scale on replicas + cache (masked search projections); **writes** scale on the queue + COPY staging +
  async projection (the `projection_outbox` worker is the throughput-critical component); **dedup/ER** scales on
  measured blocking keys + a dedicated bulk lane below interactive traffic.
- **Cost** scales with metered enrichment — controlled by reuse (Phase 05) + waterfall gating + the spend
  pre-compute (Phase 07).
- **Pooling.** Transaction-mode pooler + LOCAL GUCs (RLS-safe); no unbounded connections; bounded result sets +
  cursor pagination on every list.
- **Enterprise isolation (target).** Residency/dedicated-cluster routing for large tenants (the platform-skill
  target; not yet built).

## 6. Risks · Edge cases

- **Cross-tenant leak via the owner path** — mitigated by the explicit-scope rule (§2); every such path needs an
  isolation itest (a suppressed/foreign subject must never appear).
- **Consent gaps on capture** — reject without consent; legal sign-off before extension GA.
- **Projection lag** under load — back-pressure + monitoring + SLOs (`…/10`/`…/13`).

## 7. Implementation Checklist

- [ ] Explicit-scope suppression on every owner-path PII read · [ ] activate `is_suppressed` (P16) + extend DSAR
  fan-out to evidence · [ ] consent recording + ToS gates (extension/web-form) · [ ] residency filters on egress ·
- [ ] ingestion rate-limits + budget breakers · [ ] cross-tenant isolation itests on all new paths · [ ] SLOs +
  alerting on the projector/queues. **Cross-cuts every phase; Security signs off before any cross-tenant/PII
  path ships.**
