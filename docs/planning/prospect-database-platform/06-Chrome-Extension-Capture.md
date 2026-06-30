# 06 — Chrome Extension Capture

> **Series:** [Prospect Database Platform](./README.md) · **Phase:** 06 · **Status:** ✅ Drafted
> · **Prev:** [`05-Internal-Knowledge-Database`](./05-Internal-Knowledge-Database.md) · **Next:** `07-Enrichment-Engine`

---

## 1. Executive Summary

A browser extension that lets a user capture a prospect/company from supported pages (LinkedIn, company sites,
public directories) and push it into the platform. Architecturally it is **one connector on the unified ingestion
contract** (Phase 03): it captures + consents in the page, then **enqueues** an evidence envelope to the server,
where the *same* validate → resolve → enrich → suppress → project pipeline runs. The extension **never writes the
database directly** and never enriches in the page — this is what keeps dedup, suppression, and compliance correct
(gap P07).

## 2. Objectives

- Capture prospect/company/contact/title/social/metadata with minimal friction.
- Consent + compliance + suppression-aware **from the first byte**; server-side processing only.
- Idempotent, queue-backed, rate-limited; auto-dedup + auto-enrich downstream.

## 3. Research synthesis & compliance posture

Apollo/ZoomInfo extensions capture inline from LinkedIn/Gmail/CRM (Phase 01 §3.5). But "BrowserGate" (June 2026)
shows the live ToS/scraping/consent risk. **Decision (Security has final say):** capture only what the user is
authorized to see, record **consent context + source URL + captured-at**, never bulk-scrape, rate-limit per user,
honor robots/ToS, and run suppression server-side so a do-not-contact subject is never surfaced/enriched. This is
the *advantage-with-guardrails* posture (vs. aggressive scraping, which we reject on compliance grounds).

## 4. Proposed Architecture

```
[content script] capture fields + sourceUrl + consent  →  [extension bg] POST /api/v1/ingest
   (source=chrome_extension, idempotencyKey=hash(sourceUrl+fields), consent=...)        │
                                                                                          ▼
                                         server: validate(consent+shape) → enqueue → unified pipeline (Phase 04)
                                         → dedup (no double-insert) → resolve → suppression gate → enrich → project
```

- **Auth:** the extension uses the user's session (the shared `@leadwolf/auth`); scope = the user's tenant/
  workspace; `requireOrgRole` server-side.
- **Idempotency:** `hash(sourceUrl + captured fields)` so re-capturing the same profile is a no-op (returns the
  existing record).
- **Consent/compliance gate:** the envelope MUST carry a `consent` context; the server rejects capture without it
  and logs source URL + captured-at for audit. Suppressed subjects: captured → server detects suppression →
  records the attempt, surfaces nothing, enriches nothing.
- **Queue:** capture acks fast; processing is async on the `ingestion` queue (no user-facing latency).

## 5. Database · API

- Reuse `ingestion_jobs` + `source_records` (source=`chrome_extension`, with `sourceUrl` + `consent` in metadata).
- `POST /api/v1/ingest` (the unified entry) + a lightweight `GET /api/v1/ingest/recent` for the extension's
  "recently captured" panel. No new tables.

## 6. UI/UX (extension)

- A capture button on supported pages; a panel showing the captured fields + a "saved / duplicate / suppressed"
  state + a link to the record. Four states (loading/error/empty/data), consent affirmation, clear source
  attribution. (Design per `@leadwolf/ui` tokens where the extension shares the design system.)

## 7. Workflows · Dependencies · Edge cases

- **Workflow:** capture → consent → enqueue → server pipeline → record + dedup + enrich + score.
- **Dependencies:** Phase 03 (ingestion contract) + Phase 04 (pipeline) + the suppression gate (shipped).
- **Edge cases:** an unsupported page (no capture); a profile already in the DB (dedup → "already saved");
  a suppressed subject (no surface); rate-limit hit (queue/throttle); a captured field that fails validation
  (reject with reason, surfaced in the panel); offline (queue locally, retry).

## 8. Migration · Rollback · Risks

- **Migration:** ship behind `CHROME_EXTENSION_ENABLED` + a per-tenant flag; the extension is additive (a new
  connector). **Rollback:** flag off → the connector is disabled; no data path change. **Risks:** ToS/scraping
  exposure (legal sign-off, Phase 09); PII-at-source consent; the extension store review process.

## 9. Testing · Security · Scalability

Tests: idempotent re-capture; suppression blocks surfacing/enrichment; consent-missing rejection; cross-tenant
isolation (a user only captures into their own workspace). Security: session auth, `requireOrgRole`, server-side
suppression + consent, encrypted PII, audit of source URL + captured-at; **no provider keys or DB access in the
extension**. Scale: async queue + rate limits; the extension is a thin producer.

## 10. Implementation Checklist

- [ ] Extension capture content-script + consent UI · [ ] `chrome_extension` connector (server) · [ ] consent/ToS
  gate + audit · [ ] dedup/suppression server-side · [ ] "recently captured" read · [ ] flag + per-tenant gate ·
- [ ] compliance/legal sign-off (Phase 09). **Depends on:** Phase 03 + 04. **Note:** the extension app itself is a
  new build target — sequence after the server connector is itest-proven.
