# List Tab — Rollout Phases, Work Units & Verification (09)

> Cites the **Locked Decisions (D1–D5)** and **Vocabulary** in `00-overview.md`. This doc is the
> execution contract: the ordered phases, what each delivers, how phases depend on each other, the
> implementation work-unit decomposition, and the end-to-end verification recipe.

## 1. Sequencing principles
- **Backend-light first.** The Lists backend, import pipeline, enrichment, and reveal already exist, so we
  surface and wire before we build new subsystems.
- **Every phase ships behind a flag.** Use the existing platform **feature-flags** (`apps/api/.../admin`
  provider) — `lists.tab`, `lists.import`, `lists.dynamic`, gated per-tenant for staged rollout.
- **Isolation + money rules are not deferred.** D1/D4 (isolation) and D5 (cost-before-spend, credit-back)
  are enforced in the phase that introduces the relevant path, never "later".
- **Each phase is independently mergeable** and leaves the product in a shippable state.

## 2. Phases

### Phase 0 — Data-model & foundations
**Goal:** the schema every later phase needs.
- Extend `packages/db/src/schema/lists.ts`: `list_kind ∈ {static,dynamic}` (default `static`), list metadata
  (`description` exists; add `color`/`icon`/`tags`/`notes` as needed), `source` provenance, optional
  `saved_query` link for dynamic lists (Phase 4 reads it), retention/`archived_at`/`deleted_at`.
- Extend `list_members`: `added_via ∈ {search,import,manual,api}`, `source_import_id` link.
- RLS: extend `packages/db/src/rls/lists.sql` (mirror contacts) — workspace isolation, FORCE where the writer
  is `leadwolf_app`. Add **list audit events** to the customer-visible `audit_log` (created, renamed,
  member-added/removed, bulk-action) via `withTenantTx`.
- **Isolation-guarantee itest** (model on `packages/db/test/savedSearches.itest.ts`): two workspaces + multiple
  owners; assert list read/write/member-ops never cross `app.current_workspace_id`.
- **Done when:** migrations apply, RLS proven, audit rows written, itest green.

### Phase 1 — Lists tab (surface)
**Goal:** a usable Lists destination over the existing backend.
- Add the 7th destination in `apps/web/src/components/shell/navConfig.ts`; create `app/(shell)/lists/page.tsx`
  + `app/(shell)/lists/[id]/page.tsx`; create `apps/web/src/features/lists/` mirroring `features/prospect`.
- **List index:** cards/table of lists (name, member count, owner, updated), create/rename/delete, four states.
- **List detail:** members table **reusing** the prospect `DataTable` + `BulkActionBar` + masking + density +
  column chooser; per-row actions; remove-from-list.
- **Fix** `apps/web/src/features/prospect/api.ts` `addContactsToList()` (the stubbed/404-degrade path) to use
  the working `POST /lists/:id/members`.
- **Done when:** create a list, see members, remove a member, all workspace-scoped + masked.

### Phase 2 — Upload-your-own-data → list
**Goal:** bring-your-own-data lands in a list.
- Import wizard that **targets a list** (existing or "create new list"): reuse `apps/web/src/features/import`
  + `apps/api/.../import/routes.ts` + `core/src/import/runImport.ts`; pass a `listId` so landed rows are added
  as members (`added_via='import'`, `source_import_id` set).
- **XLSX support** (the one real gap): add an xlsx parser alongside the CSV path in the import core/worker.
- Column-map templates (`importMappingTemplates.ts`), preview (`/import/preview`), dedup + conflict policy
  (`overwrite|skip|keep_both`), import receipt/history surfaced on the list.
- **Done when:** upload CSV **and** XLSX into a list; preview shows valid/rejected; dedup honored; members appear.

### Phase 3 — Work-the-list (bulk ops + match-first enrich)
**Goal:** act on a list's members at scale, safely and monetized.
- Wire the list members table to the **bulk-action backends** (`apps/api/.../contacts-bulk/routes.ts`):
  enrich/re-verify, reveal (single + bulk), assign-owner, tags, status, archive, role-gated export. Accept
  `{ listId }` or `{ contactIds }` selection.
- **Match-first → provider waterfall** on enrich (ADR-0037): try the master-graph/overlay match before paying
  a provider; **credit estimate-before-run**; **credit-back on hard bounce** (ADR-0013).
- Data-health column (email/phone status, staleness) + re-verification affordance.
- **Done when:** select members → run each bulk action → see affected count + cost estimate + post-spend balance.

### Phase 4 — Dynamic / saved-search lists
**Goal:** lists that keep themselves current.
- `list_kind='dynamic'` backed by a saved `ContactQuery` (reuse `saved_searches` shape); membership computed
  on open + on a scheduled refresh worker; optional **new-match alerts**.
- **Done when:** a dynamic list auto-includes new matching contacts; static lists unaffected.

### Phase 5 — Admin/staff governance & compliance
**Goal:** operate uploaded data safely (D1/D2).
- Implement the **privacy-first staff capability matrix** (`07`): staff see list **metadata + aggregate**
  only; record-level only via **break-glass impersonation**; extend `platform_audit_log` for list ops;
  **customer-visible access log**.
- **Abuse + DNC/suppression**: quarantine-a-list on abuse; suppression-list gating already feeds reveal — extend
  to list bulk ops.
- **DSAR/deletion on uploaded lists**: deletion cascades `list_members`; a person-level erasure tombstones the
  contact across copies (per ADR-0021 cascade) and a `global` suppression row prevents re-import.
- **Done when:** staff-no-access itest green; impersonation required + audited for content; DSAR cascade proven.

## 3. Dependency graph
```
Phase 0 ─► Phase 1 ─► Phase 2 ─► Phase 3 ─► Phase 4
                 └──────────────────────────► Phase 5 (governance can start after P1, must finish before GA)
```
Phase 5's isolation/DSAR tests reference schema from Phase 0; its staff-tooling references the surface from
Phase 1. Phases 2/3/4 are independent of 5 and of each other after Phase 1 (3 needs 2 only for "enrich on
import"; the in-list bulk enrich does not).

## 4. Implementation work-unit decomposition (for the build, later)
Roughly uniform, independently mergeable units (per-module slices):
1. `db` — lists/list_members schema + RLS + migration (Phase 0).
2. `db/test` — isolation + DSAR itests (Phase 0/5).
3. `core` — list metadata + `added_via`/source wiring + dynamic saved-query resolver (Phase 0/4).
4. `types` — list DTO/query schema extensions (Phase 0).
5. `api` — lists routes extension + import-into-list param + list audit events (Phase 0/2).
6. `web` — nav destination + `/lists` index (Phase 1).
7. `web` — list detail + members table reuse + per-row/bulk wiring (Phase 1/3).
8. `web` — fix `RecordDetail.addContactsToList` + add-to-(new)-list from Prospect (Phase 1).
9. `import` — XLSX parser + import-into-list target + receipt (Phase 2).
10. `enrichment` — match-first-then-waterfall on list enrich + estimate + credit-back (Phase 3).
11. `web` — dynamic-list builder + refresh worker (Phase 4).
12. `admin/api` — staff capability matrix + list audit + break-glass extension (Phase 5).
13. `admin/web` — customer-visible access log + DNC/quarantine UI (Phase 5).

## 5. End-to-end verification recipe
**Setup:** `bun run --filter @leadwolf/web dev` plus the api, workers, and pg/redis (per repo dev scripts).

**Customer flow (Chrome MCP, screenshot each step):**
1. Lists tab → create a list → empty state renders.
2. "Import into list" → upload a **CSV** then an **XLSX** → preview shows valid/rejected → map columns →
   **estimate** → run → poll → members appear; dedup respected (re-upload adds nothing new).
3. Prospect → search → **reveal** a contact (confirm cost + balance) → **add to list** (single) and bulk
   add-to-list (select-all-across-search) → members appear in the list.
4. List detail → select members → run **bulk enrich / re-verify / export** → confirm **masking**, the
   **credit estimate before spend**, affected counts, and **credit-back** on a simulated hard bounce.

**Governance flow (`apps/admin`):**
5. As staff, open the tenant → confirm you see **list metadata + aggregate usage only**, **not** member PII.
6. Attempt record-level view → blocked without an **impersonation** session; start one (reason + time-box) →
   access works and **`platform_audit_log`** records actor/action/target/reason; end session.
7. Customer-visible access log shows the staff access.

**Automated tests:**
- `packages/db/test`: two-workspace **isolation guarantee** (lists/members/import/bulk never cross workspace);
  **staff-no-access** (no impersonation ⇒ zero rows); **DSAR cascade** (erasure tombstones across copies +
  suppression row); **import dedup** (idempotent re-import).
- Unit: list metadata helpers, dynamic-query resolver, import XLSX parse, credit-estimate math.
- Gate: `npx turbo run typecheck`, `bun test`, `npx @biomejs/biome check`, `npm run lint:boundaries`,
  regenerate `docs/ARCHITECTURE_MAP.md`.

## 6. Risks & mitigations
- **Import at scale** (10k–100k rows): keep async + chunked (existing enrichment_job_chunks pattern); surface
  progress; relax nothing about RLS.
- **Surprise spend** on bulk enrich/reveal: estimate-before-run is mandatory (D5); cap per-request footprint.
- **Staff over-reach**: privacy-first matrix + break-glass is the only record-level path; enforced by RLS, not
  UI (D2/D4).
- **Dynamic-list cost**: schedule refresh, cache facet/membership; avoid N+1 on account/signal joins.
