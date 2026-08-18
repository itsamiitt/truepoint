# Extension intelligence loop — close the capture→lookup→land→display circuit
_2026-08-18 · advances [S-09] [S-13] [S-10] [C-01] [A-01] · plan owner: platform session_

## The finding (four-agent audit, 2026-08-18)

The product already contains every subsystem the end-to-end flow needs — but four seams are
open, so the loop never closes:

1. **`POST /api/v1/ingest` is a validating stub.** It consent-gates, counts, and discards.
   No capture has ever created a contact; the extension then hardcodes `outcome:"saved"`
   (`client.ts:131`) and lies to the user. (`apps/api/src/features/ingest/routes.ts:69-72`)
2. **The DB-first / vendor-fallback flow exists as two disjoint halves.** `LOOKUP` →
   `by-linkedin` (DB check, live) and `VIEW_FETCH` → `fetchAndLandUrl` (vendor fetch + master
   landing, env-armed today) — but the content script discards the fetch result and nothing
   joins the halves. Case normalization also differs between write and lookup.
3. **Contacts save but don't display** — ranked causes: (a) zero cross-feature cache
   invalidation after async import (`prospectKeys.contactSearch` never invalidated anywhere);
   (b) workspace mismatch (claims.wid); (c) suppression anti-join hides rows from search only;
   (d) company column bound to `email_domain` so email-less rows render `—`; (e) "50+" header
   reads a page size as a total.
4. **Forge console: 3 of 5 pages broken** (BFF returns bare arrays/shapes the client doesn't
   unwrap — review/parsers/sync-status), and the error lanes (quarantine reason,
   `sync_state.last_error`, DLQ) have no reader. The extension feeds `apps/api`, not forge —
   by decision (Model A stays dark); the live capture surface is `source_fetch_registry`,
   which has no console surface either.

Systems reused (NOT rebuilt): `linkedinUrlKey` normalizer · contact upsert ladder
(email→linkedin→salesnav partial uniques) · `resolveForImport` master LINK-or-MINT ·
`planFieldWrite` provenance fold · `fetchAndLandUrl` + origin fleet + 30-day registry ·
idempotency middleware (billing pattern) · SSE outbox.

## Slices

**A. Capture landing** — make `/ingest` real for `chrome_extension`:
`packages/core/src/ingestion/landCapture.ts`; per observation: normalize slug (lowercase),
find-or-create overlay contact via the existing ladder, stamp `master_person_id` via
`resolveForImport`, field-provenance fold (`chrome_extension` source, capture confidence),
per-record response `{outcome: created|updated|known, contactId}`. Idempotency middleware on
the route + natural upsert idempotency. Status ladder lives in the response + provenance —
no new status table (the `ingestionJobStatus` dead enum stays dead; captures are synchronous
small writes, not jobs).

**B. One-round-trip lookup** — `POST /api/v1/contacts/lookup {url}`:
normalize (`linkedinUrlKey`) → workspace resolve (case-normalized slug OR sales-nav id) →
found: return masked contact + freshness (`updated_at`/`last_verified_at`) + `source:"database"`
→ miss: `fetchAndLandUrl` (bounded, flag-gated; precedent: the on-view fetch route) →
re-resolve → `source:"vendor"`; statuses `found | fetched | not_found | unavailable |
suppressed`. Fix `fetchAndLandUrl` flag_off→"duplicate" mislabel + burned-clock bug.

**C. Extension wiring** — SW `LOOKUP` calls the new lookup (URL, not slug — Sales-Nav lead
pages start working); `ingest()` consumes the real per-record response; hover card state
ladder: `Checking…` → `In TruePoint · updated Xh ago` / `Fetching from data source…` →
`Captured` / `Not found` / `Unavailable` / error+Retry. Company extracted best-effort.

**D. Web visibility** — invalidate `prospectKeys.all` + `importKeys.all` on import terminal
status; invalidate `listKeys` on add-to-list; company column falls back
`companyName ?? emailDomain` (masked projection joins `accounts.name`); header count uses
`POST /search/count`. Suppression behavior is correct (compliance) and stays.

**E. Forge console** — reshape review/parsers/sync-status BFF payloads server-side (Overview
precedent); Captures page gains quarantine reason + sync `last_error`; new **Source fetches**
page over `source_fetch_registry` (recent fetches, outcome, fetch_count, last_fetched_at,
resolved ids) — the live pipeline's real telemetry.

**F. Gate + deploy + verify** — typecheck/lint/tests, extension rebuild + re-zip, instance
deploy, end-to-end curls. Operator prerequisite: a `linkedin_api` origin (endpoint + key) via
admin → Data sources, else vendor fallback correctly reports `unavailable`.

## Compliance note
Captures remain user-initiated (hard constraint 4 upheld); consent gate + provenance event on
every landing (rule 5); no message/body content; suppression checked on the lookup read path.
