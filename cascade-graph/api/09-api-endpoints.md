# 09 — API Endpoint Catalog

Every endpoint the graph needs — no more. Each maps to backing tables from files `02`–`04` and, where it serves one, to the cookbook query in `05` it wraps. Conventions (auth, cursors, filter DSL, field groups, errors, credits) are fixed in [`08-api-conventions.md`](08-api-conventions.md) and not repeated per endpoint. The machine-readable contract for everything below — full request/response schemas, validated — is [`openapi.yaml`](openapi.yaml); when this prose and the spec disagree, fix whichever is wrong and keep them in sync.

Design rule carried from the brief: **endpoints exist because a consumer question exists.** The catalog is organized by question family. Anything not answering a real question (generic graph-query language, arbitrary traversal depth) is explicitly out of scope — deep multi-hop belongs to the projection layer (`06` §7), not the public API.

---

## 0. The brief's questions → their endpoint calls

| Question (from the original brief) | Call |
|---|---|
| Where does Alex work? | `GET /v1/people/pn_01ALEX…?fields=positions` |
| Who works at Sage? (Alex, Siya) | `GET /v1/organizations/org_01SAGE…/people?relationship=employee&current=true` |
| Where did Alex study? (SPPU) | `GET /v1/people/pn_01ALEX…?fields=educations` |
| Alumni of SPPU? | `GET /v1/organizations/org_01SPPU…/people?edge=education&education_status=completed` |
| **What did Sage build?** (Intacct, 50, X3 — never WordPress) | `GET /v1/organizations/org_01SAGE…/technologies?relationship=develops` |
| **What does Sage run?** (WordPress, GA, GKP — never its own products) | `GET /v1/organizations/org_01SAGE…/technologies?relationship=uses` |
| **Who made the tools Sage runs?** (Google) | same call with `&fields=vendors` — each `uses` row expands its technology's `creator` |
| What did Google build? | `GET /v1/organizations/org_01GOOGLE…/technologies?relationship=develops` |
| Who uses Google Analytics? | `GET /v1/technologies/tech_01GA…/organizations?relationship=uses` |
| Who created GA / owned Intacct in 2016? | `GET /v1/technologies/{id}/vendors` · `…/vendors?as_of=2016-01-01` |
| People at companies using a Google-built product | `POST /v1/people/search` — filter example in §5.1 |
| SPPU alumni now at ERP builders | `POST /v1/people/search` — filter example in §5.2 |
| How do we know X? (evidence) | `GET /v1/evidence/{edge_id}` or `fields=evidence` on any read |
| Tell me when someone leaves / a company drops a tool | `POST /v1/watches` (§7) or `GET /v1/changes` (§7.3) |

---

## 1. Entity reads (enrichment class — flat credit per entity)

### 1.1 `GET /v1/organizations/{org_id}`
One organization (company OR school — same endpoint, `org_kind` in the payload).
**Params:** `fields` groups: `aliases`, `identifiers`, `technologies`, `vendors_of`, `related`, `people_summary`, `evidence`. **Tables:** `organizations` (+ per group).
```json
{ "organization": {
    "org_id": "org_01SAGE…", "org_kind": "company",
    "legal_name": "Sage Group plc", "display_name": "Sage",
    "primary_domain": "sage.com", "country_code": "GB",
    "confidence": 0.97, "last_updated_at": "2026-07-30T…"
} }
```

### 1.2 `GET /v1/organizations/identify`
Resolve a raw string/identifier to canonical orgs — the resolver (`06` §4) as an endpoint. **Params:** exactly one of `domain=`, `wikidata_qid=`, `linkedin_slug=` (deterministic — `organization_identifiers`) or `name=` (probabilistic — `organization_aliases` + Splink candidates); optional `kind=company|school`. **Response:** match envelope (08 §3):
```json
{ "matched_on": "Sage", "match_type": "name",
  "matches": [
    { "match_confidence": 0.93, "organization": { "org_id": "org_01SAGE…", "…": "…" } },
    { "match_confidence": 0.41, "organization": { "org_id": "org_01SAGEIT…", "…": "…" } }
  ] }
```
An identifier hit returns exactly one match at `match_confidence: 1.0`. Zero-billed on no match.

### 1.3 `GET /v1/people/{person_id}` · 1.4 `POST /v1/people/identify`
Person profile with `fields` groups `positions`, `educations`, `evidence`. Identify is **POST** (lookup keys may be PII — emails stay out of query strings/logs): body takes one of `profile_url`, `email_hash`, or `{name, org}`; same match envelope. **Tables:** `persons`, `person_identifiers`, `person_positions`, `person_educations`.

### 1.5 `GET /v1/technologies/{technology_id}` · 1.6 `GET /v1/technologies/identify?name=GA4`
Catalog entry (`tech_kind`, category, `cpe23`, `wikidata_qid`; groups `aliases`, `vendors`, `adopters_summary`). Identify resolves via `technology_aliases` — "GA4" → Google Analytics. **Tables:** `technologies`, `technology_aliases`, `technology_categories`.

---

## 2. Relationship reads (the typed traversals — one endpoint per direction)

All of these: cursor-paginated, `min_confidence=`, `as_of=`, `status=open|closed|all` (default `open`), optional `fields=evidence`.

### 2.1 ⭐ `GET /v1/organizations/{org_id}/technologies?relationship=develops|uses`
**The develops-vs-uses fix as an API.** `relationship` is required — the API never lets a caller accidentally merge portfolio and stack. **Query it serves:** `05` §3. **Tables:** `org_technology_relations` ⋈ `technologies`.
```json
{ "organization_id": "org_01SAGE…", "relationship": "uses",
  "results": [
    { "technology": { "technology_id": "tech_01WORDPRESS…", "canonical_name": "WordPress" },
      "confidence": 0.88, "valid_from": "2023-02-10", "valid_to": null,
      "first_seen_at": "2023-02-10", "last_seen_at": "2026-07-30",
      "detection_method": "webappanalyzer", "detected_on_domain": "sage.com",
      "creator": { "org_id": "org_01AUTOMATTIC…", "display_name": "Automattic" } }
  ], "next_cursor": null }
```
`creator` (from `technology_vendors[creator]`) rides along when `fields=vendors` — "what does Sage run **and who made it**" (`05` §5) is this one call.
**Displacement variant:** `status=closed&closed_since=90d` → "what did Sage recently drop" (`05` §4).

### 2.2 `GET /v1/technologies/{technology_id}/organizations?relationship=uses|develops`
The reverse traversal: adopter list (`uses` — the outreach list) or maker (`develops`). Same row shape, org-side. **Tables:** `org_technology_relations` ⋈ `organizations` (`idx_otr_tech_type`).

### 2.3 `GET /v1/technologies/{technology_id}/vendors`
The bitemporal ownership ledger, verbatim: `creator` / `current_owner` / `former_owner` rows with validity intervals. With `as_of=2016-01-01`: "Intacct Inc., not Sage." **Tables:** `technology_vendors`. **Query:** `05` §4/§8.

### 2.4 `GET /v1/organizations/{org_id}/people`
Who is/was at this org. **Params:** `edge=employment|education` (default `employment`); employment: `relationship=employee|founder|board_member|advisor|contractor|intern`, `current=true|false`, `function=`, `seniority=`; education (school orgs): `education_status=current|completed` (alumni = `completed` — the derived predicate, `02` §4). **Tables:** `person_positions` / `person_educations` ⋈ `persons`. **Queries:** `05` §1–2 ("who works at Sage" → Alex + Siya; "alumni of SPPU").

### 2.5 `GET /v1/people/{person_id}/positions` · `/educations`
The person-side edge lists (same rows as the `fields` groups on 1.3, as standalone paginated reads). **`/colleagues`** is the one convenience 2-hop: current coworkers via shared `org_id` (`05` §1) — kept because it's the single most-asked join; anything deeper goes through search.

### 2.6 `GET /v1/organizations/{org_id}/related?type=parent_of|subsidiary_of|competitor|supplies|buys_from|partner`
Org↔org edges. **Tables:** `company_edges`.

---

## 3. Evidence (the trust surface)

### 3.1 `GET /v1/evidence/{edge_id}`
The attestation trail behind any edge — the id prefix routes (`pos_` → positions, `rel_` → org-tech, `tv_` → vendors, `edu_` → educations), so one endpoint serves every edge table. **Tables:** `relationship_attestations` (+ `sources`). **Query:** `05` §6.
```json
{ "edge_id": "pos_01ALEX…", "edge_kind": "person_position",
  "fused_confidence": 0.910,
  "attestations": [
    { "source_class": "licensed_provider", "confidence": 0.900,
      "raw_assertion": "Alex Mehta — Software Engineer, Sage", "seen_at": "2026-07-28" },
    { "source_class": "web_public", "confidence": 0.850,
      "raw_assertion": "Alex Mehta | Sage | Engineering", "seen_at": "2026-03-11" }
  ] }
```
Premium-priced (08 §6). This endpoint is the productized differentiator: no incumbent shows *why* it believes an edge.

---

## 4. Discovery (search class — per-result billing)

### 4.1 `POST /v1/organizations/search`
Filterable paths: `org_kind`, `country_code`, `headcount_range`, `founded_year`, `technologies.uses.technology_id`, `technologies.uses.category` (ltree subtree), `technologies.develops.category`, `technologies.dropped.technology_id` + `technologies.dropped.since`, `related.parent_of.org_id`, `people.function_headcount`… **Tables:** `organizations` + `org_technology_relations` + projections.

### 4.2 `POST /v1/people/search`
Filterable paths: `positions.current.org_id|function|seniority|relationship`, `positions.past.org_id`, `educations.org_id|degree|fields_of_study`, `educations.completed` (bool — the alumni predicate), plus **org-hop sub-paths** on the current employer: `current_org.technologies.uses.technology_id`, `current_org.technologies.uses.developed_by_org_id`, `current_org.org_kind`, `current_org.country_code`. **Tables:** `person_positions`/`person_educations` ⋈ `organizations` ⋈ `org_technology_relations` (2–3 typed hops — inside the OLTP depth budget, `05` §5).

### 4.3 `POST /v1/technologies/search`
By `category` (ltree), `tech_kind`, `developed_by_org_id`, `is_open_source`, adopter-count ranges. **Tables:** `technologies` + aggregates.

### 4.4 `POST /v1/{organizations|people|technologies}/search/autocomplete`
Valid values (+ counts) for any enum-ish filter path — copied from Crustdata; free; what keeps filter garbage out.

### §5 Worked filter examples (the brief's two chains)

**5.1 "Marketing people at companies that use a Google-built product":**
```json
{ "filters": { "op": "and", "conditions": [
    { "field": "positions.current.function", "type": "eq", "value": "marketing" },
    { "field": "current_org.technologies.uses.developed_by_org_id", "type": "eq", "value": "org_01GOOGLE…" }
] }, "limit": 25 }
```
Four typed hops (`develops` ← tech ← `uses` ← org ← `employee`), expressed as two filter lines because the org-hop paths pre-compose the join (`05` §5's SQL, served from the `org_technology_current` projection).

**5.2 "SPPU alumni now at ERP builders":**
```json
{ "filters": { "op": "and", "conditions": [
    { "field": "educations.org_id", "type": "eq", "value": "org_01SPPU…" },
    { "field": "educations.completed", "type": "eq", "value": true },
    { "field": "current_org.technologies.develops.category", "type": "eq", "value": "software.enterprise.erp" }
] } }
```

---

## 6. *(reserved)* `/…/live` — real-time sourcing

Not built in phase 1; the path suffix is reserved per 08 §8 so live collection can arrive without renames.

---

## 7. Change tracking (watchers — the Crustdata Watcher pattern over our edge events)

The graph's edge lifecycle (open / close / re-open, `06` §6) *is* the event stream; watchers subscribe to it. Signals map directly: **job change** = `position` closed + opened for the same person; **displacement** = `uses` closed; **acquisition** = `vendors.current_owner` changed.

### 7.1 `POST /v1/watches`
```json
{ "kind": "entity",
  "entities": { "org_ids": ["org_01SAGE…"] },
  "track": { "op": "or", "conditions": [
      { "field": "technologies.uses", "type": "removed" },
      { "field": "people.employee.current", "type": "removed" }
  ] },
  "config": { "every_hours": 24, "max_results_per_run": 100 },
  "fields": ["technologies", "positions"],
  "notifications": [{ "type": "webhook", "url": "https://client.example/hooks/graph" }] }
```
`kind: "entity"` diffs a fixed set (up to 10k ids); `kind: "discovery"` re-runs a saved §4 search and delivers *new matches*. Diff operators extend the filter DSL: `added`, `removed`, `changed` (with `from`/`to`) — Crustdata's typed-diff design. Creation runs a **silent baseline**; deliveries are HMAC-signed with a test endpoint (08 §9). **Tables:** watchers own tables + the edge tables' `valid_to`/`recorded_at`.

### 7.2 `GET /v1/watches` · `GET|PATCH|DELETE /v1/watches/{id}` · `POST /v1/watches/{id}/test` · `GET /v1/watches/{id}/runs`
CRUD, synthetic delivery, run history (the poll fallback when the consumer's webhook was down).

### 7.3 `GET /v1/changes?since=<cursor>&types=position_opened,position_closed,uses_opened,uses_closed,vendor_changed`
The pull alternative: a cursor-ordered delta feed of edge events for consumers who'd rather poll than host a webhook (CRM-sync friendly). Same event objects as webhook `results[]`.

---

## 8. Batch (async, 10k-scale)

- `POST /v1/batch/{entity}/{action}` — `entity ∈ organizations|people|technologies`, `action ∈ enrich|identify|search`; body = array of the sync inputs; `Idempotency-Key` honored. → `{ "batch_id": "…", "status": "pending", "status_url": "/v1/batch/…" }`
- `GET /v1/batch/{batch_id}` — status + NDJSON download URLs; each line = the sync envelope (one parser, 08 §10).
- `GET /v1/batch?status=&cursor=` — job list.

---

## 9. Meta

| Endpoint | Purpose |
|---|---|
| `GET /v1/usage/credits` | Balance, burn by endpoint class, expiry |
| `GET /v1/permissions` | Which endpoints + field groups this key may use (Crustdata's self-inspection endpoint, copied) |
| `GET /v1/taxonomies/technology-categories` | The ltree category tree |
| `GET /v1/sources/{source_id}` | Source metadata behind an attestation (name, type, license class, reliability prior) |

---

## 10. Endpoint count discipline

**23 routes** total (excluding reserved `/live`): 6 entity reads/identifies · 7 relationship reads · 1 evidence · 4 search + autocomplete · 6 watcher/changes · 3 batch · 4 meta. Everything in the brief is answerable; nothing exists without a named question. When a new question arrives, the order of preference is: (1) a filter path on an existing search, (2) a `fields` group on an existing read, (3) only then a new route.

## 11. Build order (extends `07`)

1. **Phase A (with schema Steps 1–5):** 1.1–1.6 entity reads + identifies · 2.1–2.4 relationship reads. This alone answers every direct question in the brief.
2. **Phase B (with Step 6):** 3.1 evidence · `min_confidence` · `as_of`.
3. **Phase C (with Step 7 ingestion + projections):** §4 search + autocomplete (search serves from projections, not OLTP) · §8 batch.
4. **Phase D (last — needs stable edge events):** §7 watchers + changes feed.

Acceptance criterion per phase: the §0 table's calls return the seeded example answers — T1–T11's assertions, through HTTP.
