# List Tab — Reveal-from-Prospect → Add-to-List (05)

> Cites the **Locked Decisions (D1–D5)** and **Shared Vocabulary** in `00-overview.md` — verbatim, not
> re-litigated. This doc owns the **second core job** in `00 §2`: search the universe → **reveal** the
> contacts worth paying for → **add them to a list** (single, bulk, or select-all-across-search). It is
> mostly **wiring + one bug fix**: every backend it needs already exists. Sibling docs:
> `02-data-model.md` (the `list_members` / `added_via` schema), `04-list-workspace-ui.md` (the Lists
> surface these members land in), `06-enrichment-verification.md` (the reveal money loop in detail).

---

## 1. What works today (the foundation we wire to)

This path is **not greenfield**. Three of its four moving parts already work end-to-end in `apps/web`
and `apps/api`; the fourth (the single-record "Add to list" in `RecordDetail`) is the one bug (§2).

### 1.1 Bulk add-to-list and add-to-NEW-list — WORKING

From `apps/web/src/features/prospect/components/BulkActionBar.tsx` (the sticky bar shown on selection):

- **Add to existing list** — the `ListPickerDialog` loads the workspace's lists via
  `bulkResourcesApi.fetchLists()` (`GET /lists`) and, on confirm, calls
  `bulkActionsApi.bulkAddToList(listId, contactIds)` → **`POST /lists/:id/members`** with an explicit
  `{ contactIds }` body. The server returns `{ listId, affected }`; the bar toasts the **server-returned**
  affected count.
- **Add to a NEW list** — the same dialog offers "or create a new list": it first calls
  `bulkResourcesApi.createList(name)` (`POST /lists`), then `bulkAddToList(newId, contactIds)`. Two calls,
  one UX. (Core also ships a single-tx `addContactsToNewList` in `packages/core/src/prospect/lists.ts`,
  but it is **not exposed as an API route yet** — the web path composes create-then-add instead. Wiring
  that one-call core function to a route is an optional later optimization, not required for this plan.)
- **Row-level "Add to list"** — `RowActions` can request the bar open the list picker with a single row
  pre-seeded (`RowBulkAction = "list"`), so a one-row add still flows through the **working** bulk path.

> **Note (selection contract).** `POST /lists/:id/members` takes an explicit `{ contactIds }` body and has
> **no `criteria` branch**. The picker therefore **disables** itself in select-all-across-search mode
> (`explicitIds === null` ⇒ a "clear 'all matching' and pick specific rows first" note). See §3.3 for how
> select-all-across-search reaches a list anyway (resolve to ids, then add).

### 1.2 Reveal — single + bulk, idempotent, credit-gated, suppression-gated — WORKING

The monetized path is `prospect/api.ts → revealContact(id, revealType)` → **`POST /contacts/:id/reveal`**
→ `packages/core/src/reveal/revealContact.ts`. Per `06-enrichment-verification.md §reveal` and the code:

- **Idempotency-Key per attempt** (`crypto.randomUUID()`) so a retried POST replays the same charge
  instead of double-spending (the replay sits in `idempotency` middleware).
- **First-wins per workspace copy** — `revealRepository.claimReveal` is idempotent per
  `(workspace, contact, reveal_type)`; a contact **already revealed in this workspace** returns the owned
  fields with **`creditsCharged: 0, alreadyOwned: true`** (free re-reveal forever in-workspace — D5).
- **Charge-by-verified-result (ADR-0013)** — verification runs **outside** the FOR-UPDATE window; a
  `valid` result charges, `invalid/catch_all/unknown` charge **0**, `risky` is config-gated. Pricing is
  config-injected (`REVEAL_COST_*`), never hardcoded.
- **Suppression/DNC gate is unbypassable** — `assertNotSuppressed` runs **inside** the charging tx; a hit
  throws `SuppressedError` (HTTP 403, `code:"suppressed"`), rolls the charge back, and audit-logs the
  blocked attempt in its own tx. `402 insufficient_credits` carries `balance`/`required` extensions so the
  UI can branch.
- **Bulk reveal** — `BulkActionBar` opens `BulkRevealDialog` over the **explicit** `revealableIds`
  (`hasEmail && !isRevealed`). Reveal is **disabled in select-all-across-search mode** (it operates on a
  concrete, costed set of rows, never an unbounded `criteria`).

### 1.3 Select-all-across-search via `{criteria}` — WORKING

`bulkActionsApi.searchCount(query)` (`POST /search/count`) returns the total workspace-visible matches so
the bar can offer **"Select all N matching"**. Every `/contacts/bulk/*` endpoint
(`apps/api/src/features/contacts-bulk/routes.ts`) accepts **exactly one of** `{ contactIds }` **or**
`{ criteria: ContactQuery }` (Zod-enforced); core resolves a `criteria` to workspace-visible ids and
**caps it** (`BULK_SELECTION_CAP`). This is what powers bulk tag/status/owner/enrich/export/archive over a
whole result set. **Add-to-list is the one bulk op that does *not* take `criteria`** (§1.1 note) — by
design, because membership writes are an explicit, idempotent id-list operation.

---

## 2. The known bug — `RecordDetail.addContactsToList()` degrades on a working backend

**Symptom.** `apps/web/src/features/prospect/api.ts → addContactsToList()` treats a 404/501 as
"not built yet" (`notBuilt(status)` ⇒ returns `{ ok:false }`), and `RecordDetail.tsx → onAddToList()`
then shows a *"Lists isn't available yet"* toast. But the backend **is** built —
`POST /lists/:id/members` is live (§1.1) and the **bulk** path already uses it successfully.

**Root cause is two-fold:**

1. **Stale "not-built" framing.** When this `api.ts` helper was written, lists were a later milestone, so
   it (correctly, then) returned `{ ok:false }` on 404. That backend has since shipped; the helper's
   degrade branch is now dead-but-misleading code — it never returns `ok:false` against the real API, yet
   the call site is *built around* the assumption that it might, so it shows a "not available" toast on any
   failure path and **discards the `affected` count**.
2. **A placeholder list id.** `RecordDetail.onAddToList()` calls `addContactsToList("__default__", …)` —
   a **hardcoded sentinel that is not a real list id**. The server re-scopes/looks it up, finds no such
   list in the workspace, and returns **`404 NotFound` ("List not found.")** — which the stale `notBuilt`
   branch then swallows as "not wired". So even though the endpoint works, this call **can never succeed**:
   it never asks the user *which* list, and it sends a fake id.

**The fix (Phase 1 work-unit 8 in `09 §4`):** point `RecordDetail`'s single-record add at the **same
working path the bar uses**, and ask the user which list. Concretely:

- **Unify on `bulkActionsApi.bulkAddToList`** (which returns `{ listId, affected }`), and **reuse the
  existing `ListPickerDialog`** (existing-list-or-new) from `BulkActionBar` rather than the placeholder id.
  Mechanically the cleanest option: have `RecordDetail`'s "Add to list" button raise the **row-level
  `RowBulkAction = "list"`** request that already seeds the bar's picker with a single-row selection — so
  there is **one** add-to-list code path, picker, and toast for both single and bulk.
- **Retire the stale `api.ts → addContactsToList` helper** (or repoint it at `bulkAddToList` and drop the
  `notBuilt` degrade) so no surface depends on the sentinel id or the dead 404-as-not-built branch.
- **Result:** RecordDetail's "Add to list" opens the picker, the user chooses a real (or new) list, the
  member lands, and the toast shows the real **server-returned** affected count — identical semantics to
  the bar.

> `enrollContacts` in the same `api.ts` is a **genuinely** unbuilt path (the outreach engine is a separate
> milestone — `00 §2 out-of-scope`), so its `notBuilt` degrade stays. **Only the lists branch is the bug.**

---

## 3. The end-to-end path (Prospect search → reveal → add-to-list)

Reveal and add-to-list are **independent**: you may add a **masked** contact to a list and reveal it later,
or reveal first and then add. Neither is a precondition for the other.

### 3.1 Search → (optional) reveal
1. The user searches the masked universe (`fetchContacts` / the search grid); rows are masked (no PII —
   `emailDomain` is the only email facet until reveal, per `02-data-model.md`).
2. **Reveal (single)** from `RecordDetail` → `RevealDialog`, or **(bulk)** from `BulkActionBar` →
   `BulkRevealDialog`. Per **D5**, the dialog shows **cost + current balance before spend** — balance comes
   from `getCreditBalance()` (`GET /credits/balance`) via `useCreditBalance`, re-read on the
   `credits:changed` event after a reveal. The charge, gate, and idempotency all run **server-side** (§1.2).

### 3.2 Add to list (single, from RecordDetail) — post-fix
3. After the fix (§2), "Add to list" in `RecordDetail` opens the shared `ListPickerDialog` for the one
   record → choose existing or new list → `POST /lists/:id/members { contactIds:[id] }` → member row lands.

### 3.3 Add to list (bulk + select-all-across-search, from BulkActionBar)
4. **Explicit selection:** select rows → "Add to list" → picker → `bulkAddToList(listId, ids)`.
5. **Select-all-across-search:** because `/lists/:id/members` has no `criteria` branch (§1.1 note), the bar
   **resolves the criteria to ids first** (the same `searchCount` + visible-id resolution the other bulk
   ops use), then adds that explicit, capped id-list to the list. This keeps membership writes an explicit,
   idempotent, bounded operation while still honoring "add everything I searched for."

### 3.4 Where members land — `added_via='search'`
6. Every member row written through this path is stamped **`added_via='search'`** on `list_members`. This
   provenance column is a **Phase 0 schema add** (`09 §2`, owned by `02-data-model.md`): today
   `list_members` carries only `added_by_user_id` + `added_at` — Phase 0 adds
   `added_via ∈ {search,import,manual,api}` (+ `source_import_id` for the import path). Until that column
   lands, the add still works; the stamp is the provenance refinement Phase 0 introduces.
   - `import` ⇒ rows from `03-upload-and-import.md`; `manual` ⇒ added by hand in the list surface
     (`04-list-workspace-ui.md`); `api` ⇒ programmatic; **`search` ⇒ this doc's path**.

---

## 4. Money + compliance (inherited from D5, not reinvented)

- **Revealing costs; adding to a list is FREE.** The two are decoupled. `POST /lists/:id/members` touches
  **no credit counter** — it only writes join rows. **Never charge for adding to a list, ever** — adding a
  masked or revealed contact to a list is a pure membership write. The only spend on this whole path is the
  **reveal** in §3.1, and only when the user explicitly triggers it.
- **Reveal stays first-wins per workspace** (§1.2): re-revealing a contact already owned in this workspace
  is **free** (`creditsCharged:0, alreadyOwned:true`). Adding the same already-revealed contact to a second
  list is also free (it's just another membership row).
- **Suppression/DNC gating applies to reveal** (the `assertNotSuppressed` gate, §1.2) — a suppressed
  contact **cannot be revealed** regardless of list membership. Adding a **masked** suppressed contact to a
  list is itself harmless (no PII moves), but any later **reveal** or **bulk reveal** from inside the list
  re-hits the same unbypassable gate. (Extending suppression gating to the in-list bulk *outreach/enroll*
  op is `09 Phase 5`, not this doc.)
- **Cost-before-spend is mandatory** on the reveal dialogs (D5): estimate + balance shown before the user
  commits. No silent charge ever originates from this path.

---

## 5. Affected-count, confirmations, and the picker UX

- **Affected count is always server-truth.** Every membership write returns `{ listId, affected }`, where
  `affected` is the count of **NEW** members (idempotent insert ⇒ re-adding existing members counts 0). The
  toast reports that exact number ("Added to list — N contacts"). The UI **never computes** the count
  locally — re-adds, cross-workspace-filtered ids (§6), and dedup all make the client's guess wrong.
- **The picker** (`ListPickerDialog`, reused for single + bulk) offers **"Existing list"** (a `TpSelect`
  populated by `bulkResourcesApi.fetchLists`) **or "create a new list"** (a name input → `createList`,
  then add). Picking one clears the other; "Add" is disabled until exactly one is chosen and an explicit
  selection exists. Loading/empty/error states follow the design-system State Kit.
- **Confirmation surface.** The picker dialog **is** the confirmation — it states "Add the N selected
  contact(s) to a list." For select-all-across-search, surface the **resolved count** (post visible-id
  filtering and cap) so the user confirms against the number that will actually be written, not the raw
  search total. (Detailed dialog spec lives in `04-list-workspace-ui.md`; this doc fixes the *path*, that
  doc owns the *surface*.)

---

## 6. Isolation (D1 / D4) — the list id and contact ids from the client are never trusted

The boundary is **Postgres RLS** (`D4`), unchanged; "my lists" is a **filter, not an access wall**. On top
of that, the server **re-derives every scope from the verified token** — `apps/api`'s lists routes take
`tenantId`/`workspaceId` from `c.get(...)` (the tenancy middleware over the verified JWT), **never** from
the request body (`apps/api/src/features/lists/routes.ts` header comment makes this explicit).

Two concrete guarantees from `packages/core/src/prospect/lists.ts → addContactsToList`:

1. **The list id is re-scoped to the workspace.** `listRepository.findById(tx, listId)` runs **inside
   `withTenantTx`**, so RLS scopes the lookup to the caller's workspace. A list id belonging to another
   workspace (or a sentinel like `"__default__"`) is **not found** ⇒ `404 NotFound` ("List not found.") —
   **no existence leak, no cross-workspace write.**
2. **Cross-workspace contact ids are filtered out.** Before any link is written,
   `listRepository.visibleContactIds(tx, contactIds)` reduces the client-supplied ids to the subset the
   caller can **actually see under RLS**; only that `visible` subset is inserted. A member can therefore
   **never** point a list at a foreign contact, even if they paste a known-good id from another workspace.
   This is exactly why `affected` can be **less** than `contactIds.length` — and why the client must read
   the server's count (§5) rather than assume all ids landed.

**Per D1 (uploaded/owned data is strictly isolated):** these member rows are workspace-private. This path
**match-against**s nothing global and **contributes nothing** to the shared graph — it only links a
workspace's own visible contacts to a workspace's own list. Staff visibility into list **contents** remains
break-glass-only (`D2`; `07-admin-staff-governance.md`).

> The isolation guarantee for lists/members is covered by the **two-workspace isolation itest** in
> `09 Phase 0 / §5` (model on `packages/db/test/savedSearches.itest.ts`): list read/write/member-ops must
> never cross `app.current_workspace_id`.

---

## 7. Build checklist (the slice this doc owns)

Maps to `09 §4` work-unit **8** ("fix `RecordDetail.addContactsToList` + add-to-(new)-list from Prospect",
Phase 1) and depends on Phase 0 schema (`added_via`):

- [ ] **Fix `RecordDetail` "Add to list"** — route it through `bulkActionsApi.bulkAddToList` + the shared
      `ListPickerDialog` (prefer raising the `RowBulkAction = "list"` request so single and bulk share one
      path). Drop the `"__default__"` sentinel.
- [ ] **Retire / repoint** `prospect/api.ts → addContactsToList` and its `notBuilt` degrade (lists branch
      only — leave `enrollContacts`/activities/custom-fields degrades intact; those backends are genuinely
      unbuilt).
- [ ] **Stamp `added_via='search'`** on member rows from this path (needs the Phase-0 `list_members`
      column from `02-data-model.md`; pass it through `addContactsToList`/`addMembers`).
- [ ] **Select-all-across-search → list:** resolve `criteria` to capped visible ids, then add (keep the
      explicit-`{contactIds}` contract on `/lists/:id/members`).
- [ ] **Confirm cost+balance** on reveal dialogs (already present — verify it survives the refactor).
- [ ] **Verify** against `09 §5` customer-flow step 3: search → reveal (cost+balance) → add-to-list
      (single + bulk + select-all) → members appear with the right provenance; isolation itest green.
