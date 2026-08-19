# Launch-day runbook — the /prospect read path at scale

Written as Phase 7 S8 of the launch-scale engagement (2026-08-19; architecture doc §7, approved). Format
per `.claude/skills/truepoint-operations/references/runbooks.md`: what it is, how you know it broke, first
checks, mitigation levers (every lever below EXISTS and was verified on the seeded 8.25M-contact stack),
escalation. The staging gate at the bottom is the procedure that must run green before launch claims.

## What this path is

The seller's primary workflow: boot probe → `/prospect` grid (keyset reads) → search/facets/suggest/counts
(scan-class reads, served through the S5 generation-keyed cache, computed on the replica pool) → reveal
(the money write). Design target (operator-locked): sustain 10k RPS, absorb 25k RPS bursts, slice p95 ≤
250ms, primary Postgres ≤ 5k QPS at burst.

## How you know it's broken

- p95 on `/api/v1/search/facets` / `/search/contacts` climbing while `GET /contacts` stays flat → cache
  tier degraded (Redis) or facet recompute storm.
- `GET /ready` 503s → PG probe failing (pool exhaustion or DB down).
- Users report "grid loads, filters hang" → scan-class reads starving (the Phase 2 poison signature).
- `api.error.unhandled` lines with `reveal.decrypt_failed`/`reveal.batch_row_failed` markers → ciphertext
  corruption (storage/key incident — S4 keeps pages serving, but the marker rate is the alarm).
- OTel spans absent → `OTEL_EXPORTER_OTLP_ENDPOINT` unset; the fleet is dark (this is itself a launch
  blocker; do not launch blind).

## First things to check (in order)

1. `redis-cli -u $CACHE_REDIS_URL info memory` (or `$REDIS_URL` if unsplit) — evictions on the DURABLE
   instance mean the roles were never split: queues are at risk, split immediately (lever 5).
2. `SELECT count(*), max(extract(epoch from now()-query_start)) FROM pg_stat_activity WHERE
   usename='leadwolf_app' AND state='active'` — long-runners mean the statement budget is off (lever 3).
3. Facet hit ratio: `INFO keyspace` growth vs `api` facet p95 — a hot workspace churning generations
   (import running?) recomputes per mutation; that is designed behaviour, confirm via the workspace's
   import/bulk job activity before treating it as a fault.
4. Pool waits: `db.tenant.tx` span durations vs the query inside — a gap means pool checkout waits
   (interactive pool exhausted → lever 4/6).

## Mitigation levers (all real; each verified)

1. **Facet/count/suggest cache off** (correctness suspicion): set `SEARCH_FACETS_CACHE_TTL_S=0` /
   `SEARCH_COUNT_CACHE_TTL_S=0` / `SEARCH_SUGGEST_CACHE_TTL_S=0` on the api service, restart. Cost: the
   scan-class reads return to their post-S1 uncached cost (whale ≈ 8.6s facets) — expensive but correct.
2. **Role memo off** (auth staleness suspicion): `ROLE_CACHE_TTL_MS=0`, restart. Cost: one role query per
   gated request (measured 2ms).
3. **Statement budget**: `DB_STATEMENT_TIMEOUT_MS` (api service only; 15000 shipped). Raising it re-opens
   the abandoned-query burn Phase 2 measured (78s+ past client disconnect) — prefer fixing the query.
   NEVER set it on workers (minutes-long sweeps are legal there — env.ts records why).
4. **Replica lever**: `REPLICA_DATABASE_URL` set → facets/suggest/counts/reports move to the replica;
   unset → same reads on the primary but on their own 5-conn pool (still isolated from interactive reads).
   Replica lagging > TTL? Unset it — the cache TTLs (≤60s) bound staleness either way.
5. **Cache/durable Redis split**: `CACHE_REDIS_URL` → dedicated allkeys-lru instance. The durable Redis
   (queues, rate limits, revocation) must stay noeviction+AOF. If one shared instance ever evicts, split
   FIRST, investigate second.
6. **Scale the api**: `docker compose up -d --scale api=N` (stateless since S6 moved the gate memo to the
   shared tier; Caddy's `app./api/*` route dials `api:3001` via compose DNS). Bun is single-threaded — the
   INSTANCE is the scaling unit (Phase 2 F6).
7. **Roll back a step**: S1/S4/S5/S6 are single-commit reverts (b12a8b0f, cab47f75, fa46545d/5e8870bf,
   3495d7bc); S2 is `DROP INDEX CONCURRENTLY idx_contacts_trgm_job_title`; S7 edge route reverts by
   restoring the one-line `app.truepoint.in` block in deploy/Caddyfile.

## Escalation

Pre-production: the repo owner (sunil@thecloso.com) owns every path above. The compliance-classed items
(suppression semantics S-11, reveal/credit correctness) stop-and-page rather than mitigate-and-wait.

## The staging gate (run BEFORE launch; blocks it while red)

Prerequisites the operator owns (Phase 1 UNKNOWNS #3–9): staging stack sized like production, real
Postgres/Redis endpoints, OTLP collector + Prometheus scrape wired, seeded via the engagement's
`seed_stage[A-D].sql` profile (8.25M contacts, whale-heavy).

1. **Load**: healthy mix at the design target (10k RPS) ≥15 min — p95 ≤ 250ms on keyset reads, facet p95
   ≤ 50ms warm, hit ratio ≥ 85%, primary ≤ 5k QPS.
2. **Burst**: 2× target (25k RPS) 15 min — 429 shedding engages per-subject (F7), zero 5xx growth, queued
   writes unaffected.
3. **Soak**: 1h at target — flat memory on api instances, no Redis eviction on the durable instance, p99
   stable.
4. **Cold-cache drill**: `FLUSHDB` on the CACHE instance under full load — the recompute storm must be
   absorbed by single-flight + the 15s statement budget + the replica pool; p95 recovers ≤ 60s; the
   database stays alive. (Local rehearsal 2026-08-19, 8.25M-contact seed, c=8 steady load + 1/s facet
   probes: flush → exactly ONE 13.2s recompute — single-flight held — then warm 40–113ms hits on the very
   next probe; the healthy mix rode through at p95 764ms with zero errors. WATCH ITEM for the staging run:
   the under-load whale recompute (13–14s local) sits close to the 15s statement budget on small hardware —
   confirm prod headroom or the drill's recompute trips the budget and serves a 5xx instead of a slow fill.)
5. **Invalidation spot-check**: bulk status mutation → facet response reflects it ≤ 2s (event bump), and
   after an import promotion ≤ 60s (TTL class) — per the confirmed §4 consistency table.

Record results against the Phase 2 baseline artifact; regressions reopen the relevant step per the
deviation rule (stop, re-propose).
