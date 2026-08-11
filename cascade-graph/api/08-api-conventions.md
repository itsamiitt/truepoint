# 08 — API Conventions & Structure Format

The rules every endpoint in [`09-api-endpoints.md`](09-api-endpoints.md) follows. Reference platform: **Crustdata** ([docs.crustdata.com](https://docs.crustdata.com/)) — the closest public API over a comparable people/company/technology graph. Its current generation (`x-api-version: 2025-11-01`) was surveyed endpoint-by-endpoint (research pass 2026-08); we copy what earns it and deviate where their own docs expose the cost. Each convention below says which.

---

## 1. The two endpoint classes (copied from Crustdata, kept strict)

Crustdata's entire surface reduces to two read patterns, and so does ours:

| Class | Shape | Answers | Billing |
|---|---|---|---|
| **Enrichment / lookup** | `GET` by identifier (id, domain, alias) | "tell me about THIS entity / its edges" | flat per entity |
| **Discovery / search** | `POST` + filter DSL body | "find entities matching THESE conditions" | per result returned; **0 results = 0 credits** |

Plus two supporting classes: **watchers** (a saved query that runs on *diffs* — Crustdata's Watcher API pattern) and **batch** (the same operations async at 10k scale).

**Deviation from Crustdata:** they POST everything, including pure lookups. We use `GET` for identifier lookups and relationship reads — cacheable, retry-safe, audit-friendly — and reserve `POST` for filter bodies, PII-bearing inputs (email lookups never go in query strings), and mutations. This was flagged in research as their convention *not* worth copying.

## 2. Base URL, versioning, auth

```
https://api.<domain>/v1/...
Authorization: Bearer <api_key>
Content-Type: application/json
```

- **Path-versioned major (`/v1`)**; additive changes (new optional fields/params/endpoints) are non-breaking and ship in place. Crustdata pins with a date header (`x-api-version: 2025-11-01`) and warns that omitting it "defaults to latest, which may break you" — that footgun is the argument for the path version: unversioned requests are impossible.
- JSON keys are `snake_case` throughout (Crustdata convention, kept).
- Every response is a **top-level JSON object**, never a bare array (Crustdata's person-enrich returns a bare array — flagged in research as un-extensible; an object envelope leaves room for `meta`, billing, and provenance without a v2).

## 3. Identifiers

- Public ids are the schema's **prefixed ULIDs** (`org_`, `pn_`, `tech_`, `pos_`, `edu_`, `rel_`, `tv_`). The prefix routes — given any edge id, the server knows its table; clients never send a "which table" discriminator.
- Natural-key lookup is a first-class *resolution* act, not a hidden join: the `identify` endpoints return Crustdata-style **match envelopes** — `{matched_on, match_type, matches: [{match_confidence, entity}]}` — surfacing the two-tier resolver from `06` §4 (identifier hit → single deterministic match; alias/name hit → ranked probabilistic candidates). Crustdata's `company/identify` + per-match `confidence_score` is the copied precedent; we extend it from per-match to per-fact confidence (§6).

## 4. Pagination — opaque cursor, everywhere

```
request:   ?limit=50&cursor=eyJ...          (limit ≤ 100, default 25)
response:  { "results": [...], "next_cursor": "eyJ..." | null }
```

`next_cursor: null` means done. Crustdata's new search already works this way (`profiles`/`next_cursor`); their legacy pages and watcher lists still use `page`/`offset` — we make cursors uniform instead of inheriting the mix (offset pagination breaks under concurrent inserts and deep scans; the schema's keyset indexes exist precisely to serve cursors).

## 5. The filter DSL (discovery + watchers)

Structure copied from Crustdata — leaf conditions with dotted field paths that **mirror the response document**, composed by nestable `and`/`or` groups; the same DSL is reused by search, autocomplete, and watcher `track` conditions:

```json
{
  "filters": {
    "op": "and",
    "conditions": [
      { "field": "positions.current.function", "type": "eq", "value": "marketing" },
      { "op": "or", "conditions": [
        { "field": "current_org.technologies.uses.technology_id", "type": "in", "value": ["tech_01GA…", "tech_01GKP…"] },
        { "field": "current_org.headcount", "type": "gte", "value": 500 }
      ]}
    ]
  },
  "sorts": [{ "field": "positions.current.started_on", "order": "desc" }],
  "limit": 25
}
```

**Deviation — named operators only:** `eq, neq, gt, gte, lt, lte, between, in, not_in, is_null, is_not_null, contains_word, phrase, has_all, geo_distance`. Crustdata's symbolic set (`(.)`, `[.]`, `(!)` and the *reversed* `=<`/`=>`) was flagged in research as unreadable and a guaranteed integration bug; named operators validate cleanly and produce legible errors.

Filterable paths per entity are enumerated in `09` §5; `POST /v1/*/search/autocomplete` (copied from Crustdata) returns the valid values for any enum-ish path so clients never guess.

## 6. Projection, confidence, and evidence — the field-group system

Copied: Crustdata's `fields` array with **section groups**, minimal defaults, and additive per-group pricing ("you pay only for the groups you request"). Ours:

| Group | Contents | Notes |
|---|---|---|
| *(default)* | core entity fields (`org_id`, names, `org_kind`, domain…) | cheapest |
| `positions` / `educations` | the person's typed edges | each edge row carries `confidence`, `valid_from`, `valid_to` |
| `technologies` | org→tech edges, grouped `develops` / `uses` | `uses` rows include `first_seen_at`, `last_seen_at`, `detection_method` |
| `vendors` | the bitemporal ownership ledger | |
| `aliases`, `identifiers` | resolution substrate | |
| `evidence` | the attestation trail per returned edge | premium-priced; the differentiator |

Two knobs no reference platform offers, straight from the schema:

- **`min_confidence=0.8`** — on any relationship read or filter path: only edges at or above the threshold. (Crustdata exposes match confidence but not fact confidence; Diffbot ships origins but no numbers. Per-fact calibrated confidence is ours to sell.)
- **`as_of=2016-01-01`** — valid-time travel on any relationship read (`05` §8's queries as an API param): "who owned Sage Intacct in 2016" is the same endpoint with one param.

Relationship objects always disclose their temporal status:

```json
{ "technology_id": "tech_01WORDPRESS…", "relationship": "uses",
  "confidence": 0.88, "valid_from": "2023-02-10", "valid_to": null,
  "first_seen_at": "2023-02-10", "last_seen_at": "2026-07-30",
  "detection_method": "webappanalyzer" }
```

## 7. Errors — RFC 9457, one shape

```json
{ "type": "https://api.<domain>/problems/filter-invalid-operator",
  "title": "Unknown operator '=<'. Did you mean 'lte'?",
  "status": 400, "code": "filter_invalid_operator" }
```

`application/problem+json` on every error; stable machine `code`; helpful `title`. Statuses: 400 validation · 401 unauthenticated · 402 insufficient credits · 403 not entitled (field-group or endpoint) · 404 not found · 409 conflict (batch idempotency) · 422 semantic (e.g. unresolvable identifier) · 429 rate-limited + `Retry-After`. Deviation justified by Crustdata's own docs: their error body drifts between `{error, description}` and `{error, reason}` per API family, and 403 doubles as "insufficient credits" — one standard shape, and 402 vs 403 kept distinct.

## 8. Credits & rate limits

Crustdata's metering model fits and is copied: **enrichment flat per entity** (+ per field group), **search per result returned** (0 = free), **autocomplete free**, **watcher notifications priced by refresh frequency** (their 30-day → 1-day freshness dial), `GET /v1/usage/credits` and `GET /v1/permissions` for self-inspection. Rate limits per endpoint class (search/enrich generous; any future `/live` real-time class strictest — Crustdata runs 10 rpm live vs 45 rpm autocomplete). `Retry-After` on 429.

**Reserved, not built:** Crustdata's indexed-vs-live path split (`/…/search` vs `/…/search/live`). Phase 1 serves the indexed graph only; the `/live` suffix stays reserved so real-time sourcing can slot in without renaming anything.

## 9. Webhooks (watchers)

Stripe-style HMAC signatures, copied verbatim from Crustdata's (researched, complete) pattern: `x-watch-id`, `x-event-id`, `x-signature: t={ts},v1={hmac_sha256_hex}`; a `POST /v1/watches/{id}/test` endpoint fires a synthetic delivery; run history is pollable as the webhook-down fallback; new watch targets get a **silent baseline** (no notification storm on create/PATCH). Delivery is at-least-once — consumers dedupe on `x-event-id`.

## 10. Batch

`POST /v1/batch/{entity}/{action}` → `{batch_id, status, status_url}` → `GET /v1/batch/{batch_id}` → NDJSON download URLs whose per-line envelope **is byte-identical to the sync response** — one parser for both paths (Crustdata's symmetry, copied). Batch submits accept an `Idempotency-Key` header; replays return the original `batch_id` (409 on key reuse with a different body).

---

## Summary of copy-vs-deviate

| Crustdata convention | Verdict |
|---|---|
| Enrichment (by id) vs discovery (by filters) split | **Copy** — it is the natural API over this schema |
| `{field, type, value}` + `{op, conditions}` DSL, dotted paths mirroring responses, reused by watchers | **Copy** — best idea on their surface |
| Field groups + minimal default + additive pricing | **Copy** — also our confidence/evidence pricing seam |
| Watcher pattern (typed diffs, HMAC, test, silent baseline) | **Copy** — maps 1:1 onto job-change & displacement signals |
| Batch `{batch_id}` + NDJSON reusing sync envelopes | **Copy** |
| Match envelope with per-match confidence | **Copy, extend** to per-fact confidence + evidence |
| Everything-POST, incl. lookups | **Deviate** — GET for lookups/reads |
| Symbolic operators, reversed `=<`/`=>` | **Deviate** — named operators |
| Per-family error-body drift | **Deviate** — RFC 9457 everywhere |
| Date-header versioning, default-latest | **Deviate** — path `/v1` |
| Mixed cursor/page/offset pagination | **Deviate** — cursors everywhere |
