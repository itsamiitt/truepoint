# List Tab — Data Model, RLS, Isolation Guarantee & DSAR Cascade (02)

> Cites the **Locked Decisions (D1–D5)** and **Shared Vocabulary** in `00-overview.md`, and the Phase-0
> contract in `09-rollout-phases.md §2`. Where this doc proposes schema, it does **not** contradict the
> spine — `list_kind`, the metadata fields, `source` provenance, the dynamic saved-query link, retention
> fields, and `added_via`/`source_import_id` on members are exactly the Phase-0 items `09 §2` names.
> **Scope:** this is the `db`/`types` slice (work-units 1–4 in `09 §4`). Surface, import, enrichment, and
> governance are owned by `03`–`08`.

---

## 1. What exists today (the backend is already built)

The Lists backend is real and shipping — schema, RLS, repository, types — it just has **no surface** (the
gap `00 §1` describes). This section is the precise current state; everything in §2 is *additive* to it.

### 1.1 `lists` — named manual collections (`packages/db/src/schema/lists.ts:25–44`)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `default uuid_generate_v7()` (time-ordered v7 — `lists.ts:12`) |
| `tenant_id` | `uuid NOT NULL` | FK → `tenants.id` `ON DELETE CASCADE` |
| `workspace_id` | `uuid NOT NULL` | FK → `workspaces.id` `ON DELETE CASCADE` — the RLS key |
| `owner_user_id` | `uuid NOT NULL` | FK → `users.id`, **no cascade** (a removed user must not drop a shared list — `lists.ts:31`) |
| `name` | `varchar(120) NOT NULL` | |
| `description` | `varchar(500)` (nullable) | the **only** metadata field today |
| `created_at` / `updated_at` | `timestamptz NOT NULL DEFAULT now()` | `updated_at` maintained by trigger (see §3) |

**Unique constraint:** `uniq_lists_ws_name` on `(workspace_id, name)` — one list name per workspace,
case-sensitive at MVP (`lists.ts:42`, mirrors `outreach_sequences`).

### 1.2 `list_members` — the contact↔list join (`lists.ts:47–66`)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `uuid_generate_v7()` |
| `tenant_id` | `uuid NOT NULL` | FK → `tenants.id` cascade |
| `workspace_id` | `uuid NOT NULL` | FK → `workspaces.id` cascade — the RLS key |
| `list_id` | `uuid NOT NULL` | FK → `lists.id` **`ON DELETE CASCADE`** (delete-a-list cascades members — §5) |
| `contact_id` | `uuid NOT NULL` | FK → `contacts.id` **`ON DELETE CASCADE`** (delete-a-contact removes its memberships — §5) |
| `added_by_user_id` | `uuid` (nullable) | FK → `users.id` `ON DELETE SET NULL` |
| `added_at` | `timestamptz NOT NULL DEFAULT now()` | |

**Unique constraint:** `uniq_list_members_list_contact` on `(list_id, contact_id)` — membership
idempotency; re-adding the same contact is a no-op via `ON CONFLICT DO NOTHING` (`lists.ts:64`,
`listRepository.addMembers` `listRepository.ts:150`).

### 1.3 RLS posture today (`packages/db/src/rls/lists.sql`)

Both tables are `ENABLE` **and** `FORCE ROW LEVEL SECURITY`. A single `*_workspace_isolation` policy per
table keys **`USING` and `WITH CHECK`** off the transaction-local GUC:

```sql
workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
```

`NULLIF(..., '')` makes an **unset or `''`-reset** GUC read as `NULL`, so an unscoped query matches nothing
— **fail-closed** (`lists.sql:1–8`). `lists` also gets the shared `set_updated_at()` BEFORE-UPDATE trigger
(reused from `rls/contacts.sql`, applied first by `applyMigrations`’s sorted-file pass). `list_members` has
**no** `updated_at` trigger (it has no `updated_at` column — append-style). Final line grants
`SELECT, INSERT, UPDATE, DELETE` on both tables to `leadwolf_app` (`lists.sql:29`).

This is **byte-for-byte the contacts/saved_searches posture** (`rls/contacts.sql:16–48`,
`rls/savedSearches.sql:10–20`) — workspace A can never read B's rows; owner-vs-workspace visibility is an
app-layer concern, not an RLS one (D4).

### 1.4 Repository operations today (`packages/db/src/repositories/listRepository.ts`)

Every method is **tx-aware** (composed inside one `withTenantTx` by the core layer), so RLS scopes the rows:

- `insert(tx, ListInsert)` — new empty list (`:55`).
- `listByWorkspace(scope)` — all lists alphabetical, each with a live `count(list_members)` (`:61`).
- `findById(tx, id)` — `{id, ownerUserId}` within the workspace, RLS-scoped (`:82`).
- `updateOwned(tx, id, ownerUserId, patch)` — owner-gated rename/description; `null` if no owned row
  matched (wrong id / other workspace / not owner) (`:93`).
- `deleteOwned(tx, id, ownerUserId)` — owner-gated delete; members cascade via FK (`:116`).
- `visibleContactIds(tx, ids)` — **the cross-workspace guard**: the subset of `ids` that are *live*
  (`deleted_at IS NULL`) contacts visible under RLS; only these may be linked (`:126`).
- `addMembers(tx, AddMembersInput)` — idempotent insert (`ON CONFLICT DO NOTHING`), returns the actual
  inserted count (the affected count the UI confirms) (`:137`).
- `removeMembers(tx, listId, contactIds)` — RLS-scoped delete, returns removed count (`:156`).

**Type contract today** (`packages/types/src/lists.ts`): `createListSchema` (name + optional description),
`updateListSchema` (name and/or nullable description), `listMembersSchema` (`contactIds`, 1–10 000), and the
`list` API DTO (`id, name, description, ownerUserId, isOwner, memberCount, createdAt, updatedAt`).

---

## 2. Proposed extensions (Phase 0)

All additions are **nullable or defaulted** so the migration is non-destructive against existing rows. They
follow the file's established idioms (the local `id()/createdAt()/updatedAt()/tenantId()/workspaceId()`
column factories; `check()` for closed enums mirrored in `@leadwolf/types`; partial unique indexes).

### 2.1 `lists` — kind, metadata, provenance, dynamic link, retention

```ts
// lists.ts — additions to the lists pgTable column block
// ── kind (Phase 4 reads it; default static so every existing row is a static list) ──
listKind: varchar("list_kind", { length: 20 }).notNull().default("static"),

// ── metadata (description already exists; these are the new display/organization fields) ──
color: varchar("color", { length: 7 }),            // hex token e.g. '#2563EB' (validate against --tp-* palette at the edge)
icon: varchar("icon", { length: 40 }),             // a lucide icon slug
tags: jsonb("tags").notNull().default([]),         // string[] of free-text labels (GIN-indexed)
notes: varchar("notes", { length: 2000 }),         // long-form free text (distinct from the 500-char description)

// ── provenance (where this list came from; mirrors source_imports.source_name vocabulary) ──
source: varchar("source", { length: 20 }).notNull().default("manual"),

// ── dynamic / saved-search link (Phase 4) — the saved ContactQuery backing a dynamic list ──
savedSearchId: uuid("saved_search_id").references(() => savedSearches.id, { onDelete: "set null" }),

// ── retention (08 §4; soft-delete + archive so DSAR/restore are non-destructive) ──
archivedAt: timestamp("archived_at", { withTimezone: true }),  // hidden from the default index, still queryable
deletedAt: timestamp("deleted_at", { withTimezone: true }),    // soft-delete tombstone (mirrors contacts.deleted_at)
```

New table-level constraints/indexes (in the `(t) => ({ ... })` block):

```ts
listKindEnum: check("lists_kind_enum", sql`${t.listKind} IN ('static','dynamic')`),
sourceEnum: check(
  "lists_source_enum",
  sql`${t.source} IN ('manual','search','import','api')`,
),
// A dynamic list MUST carry a saved query; a static list MUST NOT (coherence, mirrors suppression_scope_coherence).
kindQueryCoherence: check(
  "lists_kind_query_coherence",
  sql`(${t.listKind} = 'dynamic' AND ${t.savedSearchId} IS NOT NULL)
   OR (${t.listKind} = 'static'  AND ${t.savedSearchId} IS NULL)`,
),
tagsGin: index("idx_lists_tags_gin").using("gin", t.tags),
// Re-scope the name-uniqueness to LIVE rows so a soft-deleted list frees its name for reuse.
uniqWsName: uniqueIndex("uniq_lists_ws_name").on(t.workspaceId, t.name).where(sql`${t.deletedAt} IS NULL`),
```

> **Note on `uniq_lists_ws_name`.** Today it is unconditional (`lists.ts:42`). Adding `deleted_at` means a
> soft-deleted list would otherwise still block its name. The migration **replaces** it with a partial unique
> index on the live rows (`WHERE deleted_at IS NULL`) — the same partial-unique idiom contacts already uses
> for its dedup keys (`contacts.ts:151`).

Import for the new FK (top of `lists.ts`): `import { savedSearches } from "./savedSearches.ts";`. The
`savedSearchId` link is defined now (Phase 0) but **only Phase 4 reads it** — Phase 0/1/2/3 only ever create
`list_kind='static'` lists, so the coherence check is trivially satisfied. This matches `09 §2`
("optional `saved_query` link for dynamic lists (Phase 4 reads it)").

### 2.2 `list_members` — how a member arrived

```ts
// list_members.ts — additions to the listMembers pgTable column block
addedVia: varchar("added_via", { length: 20 }).notNull().default("manual"),
sourceImportId: uuid("source_import_id").references(() => sourceImports.id, { onDelete: "set null" }),
```

```ts
// table-level
addedViaEnum: check("list_members_added_via_enum", sql`${t.addedVia} IN ('search','import','manual','api')`),
```

- `added_via` records the entry path for the member: `search` (reveal-from-Prospect → add-to-list, Phase 1
  / `05`), `import` (upload-into-list, Phase 2 / `03`), `manual` (typed/added by hand), `api` (programmatic).
  Default `manual` keeps existing rows valid.
- `source_import_id` is set **only** on `added_via='import'` rows, FK → `source_imports.id`
  (`contacts.ts:207`) with `ON DELETE SET NULL` (a purged import receipt must not orphan-delete the
  membership). This gives the list-side "which upload landed this member" provenance and powers the
  import-receipt view on the list (`03`). Import for the FK: `import { sourceImports } from "./contacts.ts";`.

`AddMembersInput` (`listRepository.ts:33`) gains optional `addedVia?` and `sourceImportId?`; `addMembers`
threads them into the inserted values. `listMembersSchema` (`types/src/lists.ts:30`) is unchanged for the
generic add path; the import path passes the two new fields server-side (never trusted from the client).

### 2.3 Migration approach

The repo uses **Drizzle-generated SQL migrations + idempotent hand-written RLS files**, applied by
`applyMigrations` in four phases: bootstrap → `migrations/*.sql` → every `rls/*.sql` (sorted) → grants
(`applyMigrations.ts:127–146`).

1. Edit `schema/lists.ts` (and the `list_members` block) as above.
2. `bun run db:generate` (root → `drizzle-kit generate`) emits the next numbered migration
   (`migrations/00NN_*.sql` — the live tip is `0011_cultured_wendell_rand.sql`) plus its `meta` snapshot.
   **Do not hand-edit** generated SQL; the snapshot must stay in lockstep.
3. `bun run db:migrate` (root → `bun run --filter @leadwolf/db migrate` → `src/migrate.ts` → `applyMigrations`)
   applies it. The new columns are nullable/defaulted, so the table migration is a pure `ALTER TABLE ADD
   COLUMN` — safe online.
4. The `lists.sql` RLS file needs **no policy change** (the new columns are inside the same workspace-keyed
   rows). It is idempotent (`DROP POLICY IF EXISTS` / `CREATE OR REPLACE`), re-run safely on every migrate.
   If we want soft-deleted lists hidden by default at the data layer, that is an app-layer `WHERE
   deleted_at IS NULL` predicate (like `contactRepository`), **not** an RLS change — RLS owns the *workspace*
   boundary only (D4), never visibility filters.

---

## 3. RLS & isolation (D1 / D4) — the strict-isolation guarantee

### 3.1 How `rls/lists.sql` enforces workspace isolation (mirrors contacts)

The hard boundary is **Postgres RLS**, unchanged (D4). `withTenantTx` (`client.ts:47`) opens every scoped
transaction by (a) `SET LOCAL ROLE leadwolf_app` — dropping to the **non-`BYPASSRLS`** app role for the tx,
so RLS is enforced even when the base connection is the privileged dev/superuser owner — and (b) setting
`app.current_tenant_id` + `app.current_workspace_id` as **transaction-local** GUCs (RDS-Proxy/PgBouncer-safe,
reset per checkout). The `lists`/`list_members` policies then constrain every row to the active workspace.

**Why FORCE (not just ENABLE).** `ENABLE` applies RLS to ordinary roles but the **table owner is exempt**.
The migration/seed/admin paths connect as the DB owner; without `FORCE`, an owner-context query (or a future
owner-run job) would silently bypass the policy and see every workspace. `FORCE ROW LEVEL SECURITY`
(`lists.sql:12,23`) removes the owner exemption so the policy binds *everyone* the app ever runs as — the
same reasoning as `contacts.sql:18,29`. The one sanctioned cross-workspace path is the explicitly-audited
`withPlatformTx`/`withPrivilegedTx` (`client.ts:29,94`), reached only behind a verified platform-admin claim
— never the tenant request flow.

### 3.2 The strict-isolation guarantee (D1)

**Uploaded list data is the customer's alone and never feeds the shared/global master graph.** Concretely:

- A list and its members live entirely in `lists` / `list_members` / `contacts` — all four
  **`workspace_id`-keyed, RLS-FORCED** tables. There is **no write path** from these tables into the
  Layer-0 master graph (`master_persons`/`master_companies`/`source_records`, ADR-0021). Import and
  enrichment **MATCH-AGAINST** the master graph for *that customer's own* dedup/enrichment (always allowed),
  but **CONTRIBUTE-TO is OFF** — no co-op, no opt-in to contribute in this plan (D1, ADR-0021 "Consequences";
  `06 §1`). Matching reads the universe; nothing the customer uploads is promoted into another workspace's
  golden record.
- Because membership writes go through `listRepository.visibleContactIds` (`:126`) before `addMembers`, a
  member row can **only ever** point at a contact the caller can see under RLS — even though FK existence
  checks themselves run with the table owner's privilege. So a crafted cross-workspace `contact_id` is
  **silently dropped**, never linked (`listRepository.ts:4–6`, `types/src/lists.ts:26–29`).
- Staff/platform isolation (D2) is layered on top of this at Phase 5 (`07`): staff see list **metadata +
  aggregate** only; record-level content requires an audited, time-boxed **break-glass** impersonation —
  enforced by RLS, not UI.

### 3.3 The two-workspace isolation itest (model on `savedSearches.itest.ts`)

Add `packages/db/test/lists.itest.ts`, modelled directly on `packages/db/test/savedSearches.itest.ts`. It
runs against a real Postgres 16 (Testcontainers by default, or `ITEST_DATABASE_URL`) in its **own process**
(the db client is a module singleton). Setup mirrors the saved-search test verbatim:

- `applyMigrations(adminUrl)`, then seed via the **BYPASSRLS admin connection**: two tenants × one workspace
  each — `tenantA/wsA/ownerA` and `tenantB/wsB/ownerB` — plus a second member `coworkerA` of `wsA`
  (`savedSearches.itest.ts:42–86`).
- All assertions about cross-tenant *invisibility* run through `withTenantTx` (core/repo calls), so the
  proof is "under the real `leadwolf_app` role + B's GUCs"; the *ground-truth* checks ("A's rows are
  untouched") use the BYPASSRLS `admin` connection (`savedSearches.itest.ts:250–253`).

Assertions specific to lists:

1. **Read isolation:** create a list + members in A; B's `listByWorkspace` returns **none** of A's lists,
   and a direct member read in scope B sees **zero** of A's members.
2. **Write isolation / cross-workspace contact guard:** in scope B, attempt `addMembers` to A's list id and
   to B's own list using a `contact_id` that belongs to **A** → the A-list write 404s (RLS hides the list),
   and the B-list write **drops** the A-owned contact id (`visibleContactIds` returns `[]`, `addMembers`
   inserts 0). Verify with the admin connection that A's list and its membership count are unchanged.
3. **Mutation isolation:** B's `updateOwned`/`deleteOwned`/`removeMembers` against A's ids all no-op/404
   (RLS hides the rows — no existence leak), mirroring `savedSearches.itest.ts:212–254`.
4. **Owner-gating within a workspace** (the app-layer half, like the saved-search test's visibility case):
   `coworkerA` cannot rename/delete `ownerA`'s list (owner-gated → `not_found`), but **can** read it and add
   members (lists are workspace-shared; mutation is owner-gated — `listRepository.ts:4–6`).
5. **Unscoped = nothing (fail-closed):** a `withTenantTx` with no `workspaceId` reads zero lists (the
   `NULLIF(...,'')` GUC semantics, `lists.sql:5`).

DoD (per `09 §2`): migrations apply, RLS proven, the itest is green.

---

## 4. List audit events in the customer-visible `audit_log`

List mutations write to the **customer-visible, append-only `audit_log`** (`schema/billing.ts:169`), the
same log that powers the Home activity feed and the Compliance viewer — distinct from the staff-only
`platform_audit_log` (`07`/`08`) and from the per-contact `activities` timeline (`schema/activity.ts`).

- The action vocabulary **already includes** the list verbs: `audit_log`'s `audit_log_action_enum` allows
  `'list.create'`, `'list.update'`, `'list.delete'`, and the membership verbs `'member.add'`,
  `'member.update'`, `'member.remove'` (`billing.ts:189–207`), mirrored by `auditAction` in
  `packages/types/src/billing.ts:49–135`. **No enum migration is needed** for the core list/member events.
- Writes go through `auditRepository.insert(tx, AuditEntryInput)` (`auditRepository.ts:68`), called **inside
  the same `withTenantTx` transaction as the mutation** (14 §2 / the established pattern) so the audit row
  and the data change commit atomically — no audit drift on rollback. Shape:
  `{ tenantId, workspaceId, actorUserId, action, entityType: 'list', entityId: <listId>, metadata }`.
- Suggested events and metadata:
  - **created** → `list.create`, `entityType:'list'`, `entityId:listId`, `metadata:{ name, listKind, source }`.
  - **renamed / re-described / archived** → `list.update`, `metadata:{ changed:['name'|'description'|'archivedAt'] }`.
  - **deleted** → `list.delete`, `metadata:{ name, memberCount }`.
  - **member added** → `member.add`, `entityType:'list'` (the list is the entity acted on),
    `metadata:{ addedVia, sourceImportId?, count }` — one summary row per bulk add, never one per contact
    (the log must not become a PII fan-out; member metadata names counts and provenance, not contact PII).
  - **member removed** → `member.remove`, `metadata:{ count }`.
  - **bulk-action** (Phase 3 work-the-list) → reuse the existing per-action audit verbs (`reveal`,
    `export`, `enroll`, …) the bulk backends already write (`06`), tagged with the originating `listId` in
    `metadata` so the list's activity view can stitch them in. We do **not** mint a new `'list.bulk'` action.

The minimized Home-feed projection (`auditRepository.listByWorkspace`, `:119`) already strips
`metadata/ip/userAgent`, so list events appear in the feed without leaking the metadata above.

---

## 5. DSAR / deletion cascade

Two distinct operations, both already half-wired by the existing FKs:

### 5.1 List deletion (tenant-initiated, in-workspace)

Deleting a list (`deleteOwned`, `listRepository.ts:116`) relies on `list_members.list_id`'s
**`ON DELETE CASCADE`** (`lists.ts:55`) — every membership row vanishes with the list. The underlying
`contacts` rows are **untouched** (a list is a collection, not the records). With soft-delete (§2.1), the
default path becomes `deleted_at = now()` (reversible, retained for the configured window) with a periodic
**hard-delete sweep** that lets the FK cascade run. Either way, members never outlive their list.

### 5.2 Person-level erasure (DSAR / DROP) — cascade across overlay copies

Per **ADR-0021** (`docs/planning/decisions/ADR-0021-global-master-graph-and-overlay.md`) and
`08-security-compliance.md`, a data subject spans **every** tenant, so erasure is the audited **platform**
fan-out, run under `withPrivilegedTx`/`withPlatformTx` (`client.ts:29,94`) keyed off the
`subject_email_blind_index` (`schema/compliance.ts:52`) — the find-everywhere key. For each matched overlay
`contacts` row in any workspace:

1. **Tombstone the contact** — set `contacts.deleted_at` and **null the PII** (`email_enc`, `phone_enc`,
   `email_blind_index`, name fields), the documented DSAR tombstone (`contacts.ts:142` "set + PII nulled",
   `08 §4.2`). The row stays as a referential anchor; its PII is gone.
2. **Memberships follow automatically.** A subsequent hard delete of a tombstoned contact cascades
   `list_members` via `list_members.contact_id ON DELETE CASCADE` (`lists.ts:57`); until then, a tombstoned
   (PII-nulled) contact in a list simply renders masked/empty. So erasure provably reaches **every list copy
   across every workspace** without enumerating lists — one identity, fan out to overlays (ADR-0021's
   "deletion provable via the golden identity").
3. **Block re-import** — insert a **`global`-scope suppression row** (`suppression_list`, `billing.ts:111`;
   `suppressionRepository.insert`, `:77`) keyed on the subject's `email_blind_index` (or domain). Because the
   suppression check runs **in-tx on every reveal AND import/send** and the RLS read policy exposes global
   rows to every scope (`suppressionRepository.ts:1–6`), a re-upload of the erased person is gated before it
   can re-materialize — the global suppression is the durable "do not re-create" memory.
4. **Audit** — the erasure writes `dsar.delete` to `audit_log` (the verb exists, `billing.ts:194`) and the
   platform fan-out writes its `platform_audit_log` row in the same tx (`withPlatformTx`, `client.ts:94`).

The **isolation guarantee (§3.2) and the erasure cascade are complementary**: uploaded list data never
*leaves* the workspace (D1), and a person-level erasure still reaches *into* every workspace's copy via the
blind-index fan-out + global suppression — because the master-graph identity, not the uploaded copy, is the
unit of deletion.

The DSAR-cascade itest (Phase 5, `09 §4` unit 2) seeds the same person in two workspaces' lists, runs the
erasure, and asserts: PII nulled + `deleted_at` set on both overlay copies, both membership rows resolved
(cascade or masked), and a re-import of the erased person is blocked by the global suppression row.

---

## 6. Entity-relationship sketch

```
                         ┌──────────────┐
                         │   tenants    │
                         └──────┬───────┘
                                │ 1:N (tenant_id, cascade)
                         ┌──────▼───────┐
                         │  workspaces  │  ◄── the RLS boundary (app.current_workspace_id)
                         └──────┬───────┘
        ┌───────────────┬───────┴────────┬────────────────────────┐
        │ 1:N           │ 1:N            │ 1:N                     │ 1:N
  ┌─────▼─────┐   ┌─────▼──────┐   ┌─────▼─────────┐        ┌──────▼────────┐
  │   lists   │   │  contacts  │   │ source_imports│        │ saved_searches│
  │ kind,     │   │ (overlay;  │   │ (per-import   │        │ (ContactQuery │
  │ source,   │   │  PII enc,  │   │  provenance)  │        │  blob)        │
  │ saved_    │   │  deleted_at│   └─────┬─────────┘        └──────┬────────┘
  │ search_id ├───┐│  tombstone)│         │                        │
  │ archived/ │   ││            │         │ source_import_id       │ saved_search_id
  │ deleted_at│   ││            │         │ (SET NULL)             │ (dynamic lists, Phase 4)
  └─────┬─────┘   ││  account_id│         │                        │ ──────────────┐
        │ 1:N     ││  (SET NULL)│         │                        │               │
        │ (list_id││            │         │                        ▼               │
        │ CASCADE)││      ┌─────▼──────┐  │                  (lists.saved_search_id)│
  ┌─────▼────────▼┴┐     │  accounts  │   │                                         │
  │  list_members  │     │ (companies;│   │                                         │
  │  contact_id ───┼─────┤  firmo-    │   │                                         │
  │  (CASCADE)     │     │  graphics) │   │                                         │
  │  added_via     │     └────────────┘   │                                         │
  │  source_import_id ───────────────────┘                                          │
  │  (SET NULL)    │                                                                │
  └────────────────┘   lists.saved_search_id ◄──────────────────────────────────────┘
```

- `lists 1—N list_members` (FK `list_id`, **CASCADE** — delete-list drops members).
- `list_members N—1 contacts` (FK `contact_id`, **CASCADE** — delete/erase-contact drops memberships).
- `list_members N—1 source_imports` (FK `source_import_id`, **SET NULL** — proposed; import provenance).
- `contacts N—1 accounts` (FK `account_id`, **SET NULL** — existing firmographic link).
- `lists N—1 saved_searches` (FK `saved_search_id`, **SET NULL** — proposed; backs dynamic lists, Phase 4).
- All five entities are `workspace_id`-keyed and **RLS-FORCED** — the isolation boundary is `workspaces`.

---

## 7. Summary of changes (the `db`/`types` Phase-0 work)

| File | Change |
|---|---|
| `packages/db/src/schema/lists.ts` | `lists`: `list_kind`, `color`, `icon`, `tags`, `notes`, `source`, `saved_search_id` (FK), `archived_at`, `deleted_at` + kind/source/coherence checks + tags GIN + partial-live name unique. `list_members`: `added_via`, `source_import_id` (FK) + added_via check. New imports: `savedSearches`, `sourceImports`. |
| `packages/db/src/rls/lists.sql` | **No policy change** (same workspace-keyed rows; idempotent). |
| `packages/db/src/repositories/listRepository.ts` | `ListInsert`/`AddMembersInput` accept the new optional fields; `addMembers` threads `addedVia`/`sourceImportId`; reads expose `listKind`/metadata/retention as needed by the surface. |
| `packages/types/src/lists.ts` | DTO/query extensions: `listKind`, metadata, `source`, retention on the `list` schema; create/update accept the new metadata (validated at the edge). |
| `packages/db/migrations/00NN_*.sql` | Generated by `bun run db:generate` (pure `ALTER TABLE ADD COLUMN` + index swap). |
| `packages/db/test/lists.itest.ts` | Two-workspace isolation itest (§3.3); DSAR-cascade itest lands in Phase 5 (§5.2). |
| `packages/db/src/schema/billing.ts` (`audit_log`) | **No enum change** — `list.*` / `member.*` verbs already present. |
```
