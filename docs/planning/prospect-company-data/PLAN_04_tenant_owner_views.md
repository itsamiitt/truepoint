# Phase 4 — Multi-Tenant & Per-Owner Projection: PLAN

> **Gate: PLAN.** Phase 4 of the prospect↔company data initiative — the **projection boundary**: how the
> system-owned Layer-0 master graph (ADR-0021) becomes a per-workspace, per-owner thing **without ever being
> directly readable**, and concretely *where the revealed golden value lives* once a reveal crosses the wall.
> This gate freezes: the scoped **`revealed_channels`** value store (the D-shape the brainstorm chose), the
> reveal-into-overlay transaction and its least-privilege role, the overlay `master_*_id` back-refs as opaque
> pointers, the owner/team/visibility + list-sharing app-layer filter on the overlay (and the rule that the
> **shared company is ownerless**), masked-search + paid-reveal as the *only* two Layer-0 read paths, the RLS
> posture for **both** layers, the scale-gate (copy-storage vs hydrate-cost), failure modes, and open questions.
> **Converts:** `BRAINSTORM_04_projection_options.md §6` — the DECISION *"Scoped copy-on-reveal, read never
> crosses the seam: adopt the copy-on-reveal posture (A/D family), reject continuous projection (B) and
> view-time hydration (C), and materialize into a provenance-carrying, RLS-scoped channel store (Option D's
> shape) rather than smeared onto flat `contacts` columns"* — and `RESEARCH_04_tenancy_projection.md §7/§9` —
> the RECOMMENDATION *"the access-path projection boundary: Layer 0 stays system-owned with no `workspace_id`,
> no RLS, no `leadwolf_app` grant, isolated by exactly two masked/metered customer paths (masked search + paid
> reveal) plus audited privileged roles, while every per-owner view is an app-layer filter layered on the
> FORCE-RLS overlay and re-checked at read."* It answers the six `BRAINSTORM_04 §6` open questions, beginning
> with the one micro-decision the brainstorm left inside the chosen posture (A's widened columns vs D's table).
> **Depends on / cites:** `PLAN_00_constraints_and_scope.md` (C1–C10 + the §8 required-section checklist),
> `RESEARCH_04` (§2.1/§2.3/§3.1/§3.2/§3.4/§4.1/§4.2/§5/§7), `BRAINSTORM_04` (§1–§6), the planned DDL
> (`03-database-design.md:380-560,690-700`), ADR-0021/0007/0022/0035/0029/0013, `contacts.ts:98-205`,
> `rls/contacts.sql:17-48`, `client.ts:30-35,48-68,95-111`. **No code, schema, SQL, or settings are modified by
> this gate — only this file is written; the DDL below is the freeze, not an applied migration.**

---

## 0. Lineage — what this PLAN converts, and the one decision it crystallizes

`RESEARCH_04` fixed the **wall** (where the universe is isolated): Layer 0 has no `workspace_id`/RLS/
`leadwolf_app` grant; the universe is reached by exactly two customer paths — masked search + paid reveal —
backed by grant-off least-privilege roles and audited privileged escape hatches (`RESEARCH_04 §7`, rules 1–6;
`03-database-design.md:698`). `BRAINSTORM_04` took that as settled and decided the **materialization** — the
shape of the *thing the workspace keeps* once a reveal copies a value across that wall. It rejected **B**
(continuous CDC projection — a second source of truth vs ADR-0035, free scraping-by-projection, worst storage
fan-out) and **C** (view-time hydration — the only option that needs a `leadwolf_app` grant on `master_*`, the
headline wall-break, and breaks point-in-time billing + survivorship), and chose the **copy-on-reveal posture**
in its **provenance-carrying** form: a FORCE-RLS, workspace-scoped `revealed_channels` store, *not* the flat
`contacts.email_enc` smear of naive A (`BRAINSTORM_04 §4`, §6).

This PLAN **paves that road**. It does three things:

1. **Freezes the materialization** (Target schema) — `revealed_channels` *sits beside* (does not replace) the
   `contact_reveals` event log: `contact_reveals` stays the append-only billing/credit event (ADR-0007),
   `revealed_channels` is the value store carrying the re-encrypted channel value + per-field
   `{source, confidence, status, as_of}` provenance (the Phase-3 seam, pre-answered) — resolving
   `BRAINSTORM_04 §6` OQ1 in favour of D's table.
2. **Freezes the access path** (RLS policy implications) — the overlay's `master_*_id` are opaque pointers on
   already-RLS-scoped rows; masked search returns candidate ids + non-PII facets only; the reveal tx is the
   *one* place a PII channel decrypts, under a least-privilege `leadwolf_reveal` role that has the master-graph
   grant `leadwolf_app` is forbidden; owner/team/visibility + list-sharing are app-layer filters on the overlay,
   re-checked at read; the shared `master_companies`/`master_employment` are **ownerless**.
3. **Freezes the boundaries** — scale-gate (copy bounded by paid reveals, not `|universe|×|workspaces|`),
   failure modes, the extended two-tenant isolation itest + the DSAR cascade, and the residual open questions
   (re-charge on job change, survivorship arbitration) handed to Phase 3/6 with their owners named.

> **Trace, explicit.** Every schema and policy choice below names the brainstorm DECISION clause
> (`BRAINSTORM_04 §6`, the H1–H5 adjudications `§3`, the §4 challenge-to-A) or the research recommendation point
> (`RESEARCH_04 §7` rules 1–6, §9 decisions 1–3) it crystallizes, and cites the locked constraints
> (`PLAN_00` C1/C3/C7/C8/C10) it obeys. Phase 4 **builds** C7 in code (the projection boundary) without relaxing
> C8 (the FORCE-RLS overlay + the isolation itest); **security has final say** (CLAUDE.md precedence).

---

## Target schema

The projection boundary divides every field of the prospect↔company universe into **shared** (Layer 0, masked,
ownerless, reachable only by access path) vs **per-tenant** (Layer 1 overlay, FORCE-RLS, owned, curated). The
table below is the freeze of that split; `revealed_channels` (§ below) is the new home of the materialized copy.

### 0.1 The projection split — what is shared vs per-tenant

| Datum | Lives in (home) | Workspace reaches it by | Owner-scoped? |
|---|---|---|---|
| Golden person identity, name, seniority, dept, location, `has_email`/`has_phone` facets | Layer 0 `master_persons` (`03:409-426`) | **masked search** (candidate id + facets) | No — ownerless (C7) |
| **The employment edge** (person↔company, title, dates, `is_current`) | Layer 0 `master_employment` (`03:428-436`) | masked search (masked edge facets) | **No — ownerless** (H2; `BRAINSTORM_04 §3`) |
| Golden company + firmographics (`primary_domain`, industry, employee_band, technographics) | Layer 0 `master_companies` (`03:390-407`) | masked search (firmographic facets) | **No — ownerless** (H2) |
| Verified email / phone **value** (PII) | Layer 0 `master_emails`/`master_phones` (`03:438-459`), encrypted | **paid reveal only** → copy into `revealed_channels` | Per-workspace copy, owner-scoped via parent contact |
| Per-field provenance of a revealed channel (`source`/`confidence`/`status`/`as_of`) | **`revealed_channels`** (Layer 1, NEW — this PLAN) | written in the reveal tx | Yes (RLS + app-layer) |
| Overlay curation: notes, lists, scores, `outreach_status`, pipeline stage, custom fields | Layer 1 `contacts`/`accounts` (`contacts.ts:92-207`) | direct RLS read | Yes |
| Ownership/assignment/visibility | Layer 1 `contacts.owner_user_id`/`assigned_team_id`/`visibility` (`03:540-543`) | app-layer filter atop RLS (C10) | Yes |
| Reveal credit ownership / billing event | Layer 1 `contact_reveals` (`03:559-560`) + `tenants.reveal_credit_balance` (`03:686`) | reveal tx; first-reveal-wins (ADR-0007) | `revealed_by_user_id` (immutable, distinct from `owner_user_id`) |

The pointer that bridges the two layers is `contacts.master_person_id` / `accounts.master_company_id`
(`03:518,495`; `PLAN_00 §5.3`) — **nullable** (in-flight staging only, C8), partial-indexed, and **opaque**: a
workspace reading the value gets a uuid, never a Layer-0 row (`PLAN_00 §6.1`).

### 0.2 `revealed_channels` (NEW) — the scoped, provenance-carrying value store (DDL freeze)

The brainstorm's Option D, one step elevated from the `contact_reveals` event log into the value store
(`BRAINSTORM_04 §2 Option D`, §6 DECISION). FORCE-RLS on `workspace_id` — the *same* posture as `contacts`
(`rls/contacts.sql:28-33`). One row per *materialized channel value* a workspace paid to reveal; a job-change
re-reveal **appends a new row** (point-in-time history), never overwrites (the Cognism model, `RESEARCH_04 §2.3`).

```sql
CREATE TABLE revealed_channels (                          -- Layer 1; FORCE-RLS; the reveal materialization target
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id)     ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspaces(id)  ON DELETE CASCADE,   -- the RLS key (C8)
  contact_id          uuid NOT NULL REFERENCES contacts(id)    ON DELETE CASCADE,   -- overlay anchor (owner/visibility live here)
  master_person_id    uuid,                                -- SOFT ref into Layer-0 (NO FK, system-owned §9) — the DSAR fan-out key
  reveal_id           uuid REFERENCES contact_reveals(id),  -- the billing/credit event that minted this value (sits-beside, §0.3)
  channel             varchar(10) NOT NULL CHECK (channel IN ('email','phone')),
  value_enc           bytea NOT NULL,                      -- AES-GCM ciphertext; decrypted-from-master then re-encrypted in-tx
  value_blind_index   bytea,                               -- HMAC(normalized value) — optional corroboration/DSAR cross-check
  -- ── per-field provenance baked into the row (the Phase-3 seam, pre-answered — BRAINSTORM_04 §4.1) ──
  status              varchar(20) NOT NULL DEFAULT 'unverified',
  line_type           varchar(20),                         -- phone only (direct|mobile|hq|unknown); NULL for email
  source              varchar(50),                         -- asserting source at reveal (apollo|zoominfo|coop|internal)
  confidence          numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  as_of               timestamptz NOT NULL DEFAULT now(),  -- point-in-time snapshot moment (the Cognism contract, RESEARCH_04 §2.3)
  last_verified_at    timestamptz,
  -- ── re-projection chain + survivorship (BRAINSTORM_04 §4.2, OQ4) ──
  superseded_by_id    uuid REFERENCES revealed_channels(id),-- a job-change re-reveal points the old row here (history kept)
  revealed_by_user_id uuid REFERENCES users(id),           -- credit owner at reveal (immutable, mirrors contacts.ts:129)
  created_at          timestamptz NOT NULL DEFAULT now(),   -- range-partition by month (§ scale; like contact_reveals, 03:735)
  -- channel-conditional status vocabulary (reuse the shipped enums; never a new one — C5/03 §2)
  CHECK (
    (channel = 'email' AND line_type IS NULL
       AND status IN ('unverified','valid','risky','invalid','catch_all','unknown'))   -- email_status (contacts.ts:165-167)
    OR
    (channel = 'phone'
       AND status IN ('unverified','valid','invalid','unknown')                        -- phone_status (03:532)
       AND (line_type IS NULL OR line_type IN ('direct','mobile','hq','unknown')))
  )
);

-- ONE live (non-superseded) value per (workspace, contact, channel) — the per-workspace first-reveal idempotency
-- at the VALUE layer; a re-reveal sets the old row's superseded_by_id and inserts a new live row (so the unique
-- never blocks the append-on-job-change). Mirrors the contacts dedup partial-unique idiom (contacts.ts:156-164).
CREATE UNIQUE INDEX uniq_revealed_channels_live
  ON revealed_channels (workspace_id, contact_id, channel) WHERE superseded_by_id IS NULL;

-- Hot read: a contact's current channels (the detail/expand hydrate). Partial = the live rows only → tiny.
CREATE INDEX idx_revealed_channels_contact
  ON revealed_channels (workspace_id, contact_id) WHERE superseded_by_id IS NULL;

-- DSAR fan-out: delete every workspace's copies of a subject by the Layer-0 identity (privileged, RLS-bypassing).
CREATE INDEX idx_revealed_channels_master ON revealed_channels (master_person_id);
```

### 0.3 `contact_reveals` and the overlay flat columns — what `revealed_channels` *relates to* (OQ1 resolved)

- **`revealed_channels` SITS BESIDE `contact_reveals`, replacing neither.** `contact_reveals`
  (`03:559-560`: unique `(workspace_id, contact_id, reveal_type)`, `credits_consumed`, `revealed_fields`, the
  `AFTER INSERT` first-reveal-wins trigger `03:705`) stays the **billing/credit event log** — ADR-0007 is
  byte-for-byte unchanged. One `contact_reveals` event (`reveal_type ∈ email|phone|full_profile`) mints one (or
  for `full_profile`, two) `revealed_channels` value rows, linked by `reveal_id`. The brainstorm's "does it
  replace, extend, or sit beside" (OQ1) is answered: **sit beside** — event log + value store, cleanly split.
- **The flat `contacts.email_enc`/`phone_enc`/`email_status` (`contacts.ts:106-118`) are retained as the home of
  the overlay's *own* values** — workspace-imported (CSV), manually typed, or user-corrected — i.e. the channel
  the workspace *supplied*, not the channel it *revealed from Layer 0*. This keeps survivorship expressible (a
  `user_overridden` overlay value outranks any provider/golden value — ADR-0015; `BRAINSTORM_04 §4.2`) and means
  reveals do **not** smear onto the flat columns (the §4 challenge to naive A). The **read resolver** applies a
  fixed precedence (OQ4 skeleton): `user_overridden` overlay value → newest live `revealed_channels` row → masked
  / empty. Phase 3 owns the full per-field survivorship engine; Phase 4 establishes the channel store as the
  reveal target and the precedence skeleton — coordinated at the boundary, not duplicated.
- **List rendering reads non-PII facets off `contacts`** (`email_domain`, `email_status` badge,
  `is_revealed`) — the actual decrypted value is hydrated from `revealed_channels` (or the own-value column)
  **only when a row is opened/expanded** (the read-seam rule, OQ6). So list/table reads never JOIN the channel
  store or touch PII; detail reads do a bounded, RLS-local JOIN (never a Layer-0 hydrate — the rejected C).

### 0.4 The reveal transaction (one atomic tx, `leadwolf_reveal` role) — OQ2 resolved

The credit-gated transition from masked candidate to durable workspace copy (`RESEARCH_04 §4.2`;
`BRAINSTORM_04 §2 Option A/D flow`). All steps in **one** transaction; the wall is crossed exactly **once**, here,
and never again on the hot read path (the A/D "read never crosses the seam" guarantee, `BRAINSTORM_04 §3 H1`):

```
  BEGIN  (reveal-service role: SET LOCAL ROLE leadwolf_reveal; set_config app.current_{tenant,workspace}_id)
   1. IDEMPOTENCY  INSERT contact_reveals(ws,contact,reveal_type,...) — unique (ws,contact,reveal_type) +
                   client Idempotency-Key; ON CONFLICT → return the existing reveal (no double-charge, ADR-0007:40)
   2. CREDIT       SELECT reveal_credit_balance FROM tenants WHERE id=:tenant FOR UPDATE;  CHECK (... >= 0)
                   + optional team budget (team_credit_budgets, ADR-0022:46-50); decrement by credits_consumed
   3. SUPPRESSION  gate at BOTH layers: master_persons.is_suppressed=false (03:421) AND no suppression_list row
                   (scope global|tenant|workspace, 03:687) — a suppressed subject is unrevealable even if a stale
                   masked candidate leaked through (RESEARCH_04 §4.2)
   4. DECRYPT      SELECT email_enc/phone_enc FROM master_emails/master_phones WHERE master_person_id=:mpid
                   — leadwolf_reveal has SELECT here; leadwolf_app does NOT (the wall, § RLS); decrypt in-tx
   5. COPY         INSERT revealed_channels(ws,contact,master_person_id,reveal_id,channel,value_enc=re-encrypt(.),
                   status,source,confidence,as_of=now(),...) — the materialized, provenanced, point-in-time copy
   6. OWNERSHIP    the AFTER INSERT ON contact_reveals trigger sets contacts.is_revealed/revealed_by_user_id/
                   revealed_at WHERE is_revealed=FALSE (idempotent, first-reveal-wins, 03:705)
  COMMIT   (charge-for-verified-data: status∈invalid/catch_all/unknown ⇒ credits_consumed=0, ADR-0013/03:686)
```

`leadwolf_reveal` is a **dedicated least-privilege role** (OQ2; `RESEARCH_04 §3.2/§7`): `SELECT` on
`master_emails`/`master_phones`/`master_persons` (for `is_suppressed`) **and nothing else on Layer 0**; `INSERT`
on `contact_reveals`/`revealed_channels`; `UPDATE` on `tenants` (credit) and (via the trigger) `contacts`. It is
**not** BYPASSRLS — `revealed_channels`/`contacts` are FORCE-RLS, so even the reveal role can only write rows for
the calling workspace (the `WITH CHECK` predicate), and it is bound by the two `set_config` GUCs exactly like
`leadwolf_app` (`client.ts:48-68`). The role bridges the two regimes in one tx: a direct (non-RLS) grant on
`master_*`, an RLS-bound write on the overlay. The customer-facing `leadwolf_app` role holds **no** master grant
(C7; `PLAN_00 §6.2`).

### 0.5 Overlay back-refs, ownership, and the ownerless-company rule (C10; H2)

- `accounts.master_company_id` / `contacts.master_person_id` (`03:495,518`) — nullable, opaque pointers; a
  partial `idx_*_master … WHERE … IS NOT NULL` (`03:511,556`). They introduce **no new RLS surface** (just two
  columns on already-RLS-scoped tables, `PLAN_00 §6.1`).
- **Owner/team/visibility live on the overlay row, never on the shared golden entity** (`BRAINSTORM_04 §3 H2`).
  `contacts`/`accounts` carry `owner_user_id`, `assigned_team_id`, `visibility ∈ workspace|team|owner`
  (`03:503-506,540-543`; ADR-0022:40-45). The golden `master_companies`/`master_employment` are **ownerless by
  design** — every workspace is equally entitled to *find* (masked) and *reveal* (for a credit) any non-suppressed
  entity, so there is no per-workspace ownership to express. Two workspaces revealing the same `master_company`
  each mint their **own** `accounts` row with their **own** owner/visibility; the shared company carries none.
  The same holds for the edge: "Alice works at Acme" is a shared fact; *who in a workspace owns the relationship*
  is the overlay `contacts.account_id` + `owner_user_id`, never `master_employment`.
- **`revealed_channels` has no own `visibility` column** (OQ5 resolved): it inherits visibility from its parent
  `contacts` row — the read always JOINs through `contacts` and applies that contact's owner/team/list filter, so
  there is a single source of visibility truth and no drift. The FORCE-RLS `workspace_id` predicate is the wall;
  the app-layer owner/team/list filter is the within-workspace narrowing (C10).
- **List-based sharing** projects a bounded set of `contact_id`s to a team/workspace audience
  (`lists`/`list_members`, `list-plan/02-data-model.md §1`); because channels are reached *through* contacts,
  sharing a contact onto a list implicitly shares its revealed channels to that audience, subject to the same
  read-time re-check. Removing a member revokes the projection and is audited (`audit_log`, `member.remove`).

### 0.6 ER + projection-boundary sketch

```
  SYSTEM-OWNED LAYER 0  (no workspace_id · no RLS · no leadwolf_app grant — C7)
  master_persons ─ master_employment ─ master_companies        (golden, ownerless; firmographics)
  master_emails(email_enc) / master_phones(phone_enc)          (PII, encrypted)
        │ touched ONLY by: ER pipeline · search-sync · leadwolf_reveal   (least-privilege roles, 03:698)
        │
   ┌────┴───────────────┐                         ┌──────────────────────────┐
   ▼ (A) MASKED SEARCH  │                         ▼ (B) PAID REVEAL (leadwolf_reveal, one tx, §0.4)
   OpenSearch facets,   │                         decrypt 1 channel → re-encrypt → revealed_channels row
   NO PII, capped,      │                         + contact_reveals event + first-reveal-wins trigger
   small-cell-suppressed│  candidate master_person_id
   ════════════════════════════════════════════════════════════════════════════════════════════════
  PER-WORKSPACE LAYER 1  (ENABLE + FORCE RLS on workspace_id · fail-closed GUC — C8)
   contacts ──master_person_id(opaque ptr)──▶ Layer 0      accounts ──master_company_id(opaque ptr)──▶ Layer 0
     owner_user_id · assigned_team_id · visibility           owner_user_id · assigned_team_id · visibility
     email_enc(OWN value) · email_status(facet)              (the workspace company; the golden one is ownerless)
        │ 1:N (live: 1/channel)                              lists/list_members  (explicit positive sharing)
        ▼
   revealed_channels  (FORCE-RLS; value_enc + source/confidence/status/as_of; superseded_by_id chain)
        └─ read = contacts ⋈ revealed_channels, RLS-local, app-layer owner/team/list re-check — NEVER Layer 0
```

---

## RLS policy implications

Two isolation regimes that must **not** bleed into each other (C7/C8; `PLAN_00 §6`). Phase 4 *builds* the
Layer-0 side in code; the Layer-1 side is the shipped overlay posture, **extended, never relaxed**.

### 1. Layer 1 (overlay + `revealed_channels`) — ENABLE + FORCE, fail-closed

- `revealed_channels` gets the identical policy to `contacts`/`accounts`/`lists`
  (`rls/contacts.sql:17-44`): `ENABLE` + `FORCE ROW LEVEL SECURITY`, one `*_workspace_isolation` policy with
  **`USING` and `WITH CHECK`** both keyed on
  `workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid` — `NULLIF(...,'')` makes an
  unset/`''`-reset GUC read as `NULL`, so an unscoped query reads **nothing** (fail-closed). **FORCE** removes the
  table-owner exemption so the policy binds *every* role the app runs as — including `leadwolf_reveal`, which can
  therefore only ever write a channel row into the *calling* workspace.
- `tenant_id`/`workspace_id` are **denormalized onto `revealed_channels`** (not reached only through the parent
  contact) so RLS and monthly-partition pruning share the one leading key — the same rule the bulk ledger follows
  (`03:694`, H9). `GRANT SELECT, INSERT, UPDATE, DELETE ON revealed_channels` goes to **both** `leadwolf_app`
  (read its own workspace's channels) and `leadwolf_reveal` (write them); neither gets a Layer-0 grant.
- The `master_person_id` soft-ref is **just a pointer** on an RLS-scoped row — reading it is fine because it is a
  uuid, not the master row (`PLAN_00 §6.1`). No Layer-0 read is reachable from a `leadwolf_app` tx.
- **Within-workspace** narrowing (owner/team/visibility, list shares) is the **app-layer** filter atop RLS (C10;
  ADR-0022:40-45; `03:696`) — re-checked at read against Postgres truth (`RESEARCH_04 §5`, the two-stage
  authorize-at-read). The masked index filter is a candidate accelerator, **never** the authorization boundary
  (Azure caution, `RESEARCH_04 §3.3`): a Stage-1 over-broad candidate is a UX bug; only a Stage-2 miss is an
  incident.

### 2. Layer 0 (master graph) — NOT a workspace RLS predicate; isolation by access path

- **No `workspace_id` on any `master_*`/`source_records`/`match_links`** — a workspace does not *own* a golden
  row; adding one re-fragments the universe ADR-0021 unifies and shards a single human across N workspaces
  (the headline rejection, `RESEARCH_04 §7` Reject #1; C7). Isolation is **structural**, not a row predicate.
- **No RLS policy and no `GRANT … TO leadwolf_app`** on Layer 0. A workspace tx runs as the non-BYPASSRLS
  `leadwolf_app` role (`client.ts:48-68`), which has **no table privilege** on `master_emails` — a tenant query
  cannot even address it (privilege-denied, not merely row-filtered). **RLS-off is necessary; grant-off is the
  actual wall** (`RESEARCH_04 §3.2`). The only Layer-0-reaching roles are `leadwolf_reveal` (the reveal tx, §0.4),
  the **ER pipeline** role, the **search-sync** role (each least-privilege, `03:698`), and the audited privileged
  paths `withPrivilegedTx`/`withPlatformTx` (`client.ts:30-35,95-111`).
- **Masked search + paid reveal are the ONLY two customer read paths** (rule 2, `RESEARCH_04 §7`). Masked search
  returns candidate `master_person_id`s + non-PII facets (`has_email`/`has_phone`, never `email_enc`); the index
  is masked *by construction* (`03:383-384`), capped per-user/-workspace (the ZoomInfo view-cap, `RESEARCH_04
  §2.1`), and small-cell-suppressed against facet/hit-count membership inference (`RESEARCH_04 §3.4`). Suppressed
  identities (`is_suppressed`) are excluded from the projection entirely. Paid reveal is the *only* way a PII
  channel materializes (§0.4).

### 3. The mandatory two-tenant isolation itest (extended; blocks merge)

Model on `lists.itest.ts` / `emailIsolation.itest.ts` (`list-plan/02-data-model.md §3.3`; `PLAN_00 §8`/C8).
Seed two tenants × one workspace each (`tenantA/wsA/ownerA`, `tenantB/wsB/ownerB` + a `coworkerA` in `wsA`); run
isolation assertions through `withTenantTx` (real `leadwolf_app` role + the scope's GUCs); verify ground truth
on the BYPASSRLS admin connection. Phase-4-specific assertions:

1. **Channel read isolation.** Reveal a channel in `wsA`; `wsB`'s `revealed_channels` read returns **zero** of
   A's rows; an unscoped `withTenantTx` (no `workspaceId`) reads **zero** (fail-closed, `rls/contacts.sql:5`).
2. **Per-workspace first-reveal (shared identity, separate copy — C3).** Reveal the **same** `master_person_id`
   in both workspaces ⇒ **two** `revealed_channels` rows, one per workspace, each charged once; B's read never
   sees A's copy. Single canonical identity, per-workspace billing.
3. **Write isolation / cross-workspace anchor guard.** In scope B, an attempt to write a `revealed_channels` row
   for a `contact_id` that belongs to **A** is dropped/blocked (the `contact_id` is invisible under B's RLS;
   `WITH CHECK` rejects a foreign `workspace_id`) — mirrors `listRepository.visibleContactIds`.
4. **Negative Layer-0 access (the wall).** A `withTenantTx` under `leadwolf_app` selecting `master_emails`
   **errors (privilege denied)** — proving grant-off, not row-filtering, is the wall (C7; `PLAN_02 §RLS`).
5. **DSAR cascade (its own itest).** Reveal the same subject in both workspaces; run the erasure keyed on the one
   `master_emails.email_blind_index` (`03:442`) under `withPrivilegedTx` (`client.ts:30-35`): **delete
   `revealed_channels` by `master_person_id`** across both workspaces (one keyed fan-out — cleaner than A's
   per-column null, `BRAINSTORM_04 §5`), tombstone both `contacts` (`deleted_at` + null PII, `contacts.ts:147`),
   cascade `list_members`, insert a **global**-scope `suppression_list` row (blocks re-reveal/re-import,
   `list-plan/02-data-model.md §5.2`). The **golden identity is the unit of deletion** (ADR-0021:129).

---

## Scale-gate analysis

Scale target: millions of users, **billions** of golden rows; reveals (hence copies) in the **billions** across
all workspaces over time (CLAUDE.md; C9). N+1 and unbounded fan-out are failures. The crux this gate decides is
**copy-storage cost vs hydrate cost** — and the brainstorm's H4/H5 adjudications invert the naive intuition
(`BRAINSTORM_04 §3`). *What breaks first at 10×, and the fix:*

| Rank | What breaks first at 10× | Why | Fix (this PLAN) |
|---|---|---|---|
| **1** | **`revealed_channels` row growth** | a per-workspace copy of every revealed PII value | **Bounded by paid reveals, not `\|universe\|×\|workspaces\|`** (H4): reveals are credit-gated, so total copies = total paid reveals (ZoomInfo export-is-metered, `RESEARCH_04 §2.1`). A 50k-reveal customer stores 50k rows, not a slice of billions. **Range-partition by `created_at`/month** (like `contact_reveals`, `03:735`); the live set is one row/(contact,channel) via `uniq_revealed_channels_live`. *This is precisely the fan-out that **kills B** (free, un-metered, universe-bounded) but is bounded for D.* |
| **2** | **Detail read JOIN** (`contacts ⋈ revealed_channels`) | hydrating a contact's channels on open | RLS-local, bounded: a contact has ≤2 *live* channels; `idx_revealed_channels_contact … WHERE superseded_by_id IS NULL` is ≈1–2 rows; covering. **List/table reads do NOT join** (non-PII facets off `contacts`, §0.3); only detail/expand hydrates. **Never a Layer-0 hydrate** (the rejected C's N+1-across-the-Citus-shard-boundary, `BRAINSTORM_04 §2 Option C`). |
| **3** | **The reveal write path** (credit `FOR UPDATE` hot row) | a popular tenant's `tenants` balance row serializes every reveal | **Lease-based decrement** for hot tenants (ADR-0029, the committed M12 path) + the append-only `credit_ledger` as system-of-record; the counter becomes a cache. Decrypt is per-reveal, O(1). |
| **4** | **Masked-search facet membership inference** | narrow facet combos yield small cells that confirm an individual without a reveal (`RESEARCH_04 §3.4`) | **Small-cell suppression / minimum-bucket thresholds** on facet + hit counts; per-user/-workspace **view caps + rate limits** (`RESEARCH_04 §2.1`); suppressed rows excluded. Owned by ADR-0035 search design + a privacy-threshold decision (OQ below). |
| **5** | **Staleness of the copy** | the golden value evolves under a kept copy | **This is product-correct, not a bug** (H5): ADR-0007 sells a point-in-time reveal; Cognism keeps the copy for the contract and **re-charges on job change** (`RESEARCH_04 §2.3`); survivorship *requires* a held value (ADR-0015). The `as_of` column makes the contract a first-class field; a Layer-0 change is a **signal + optional billable re-reveal** (new row), never a silent rewrite. "Always fresh" (C) would be the **liability**. |

**Verdict.** Copy-storage is the cost the brainstorm chose **knowingly**, because it buys exactly the semantics
the product bills against, and it is bounded by credit spend; hydrate-cost (C) was rejected because it breaks the
wall + billing + survivorship to "save" storage the meter already bounds. The seam is crossed **once** (reveal),
never on the hot read path — the opposite of C's RLS-less hot path (`BRAINSTORM_04 §3 H1`).

---

## Failure modes

| # | Failure | Cause | Mitigation |
|---|---|---|---|
| F1 | **A Layer-0 read leaks past the projection** | `leadwolf_app` granted any direct `master_*` read "for convenience" | Grant-off is the wall (C7): no `leadwolf_app` grant; reads only via masked search + `leadwolf_reveal`; the **negative access itest** (§RLS-3.4) asserts privilege-denied. |
| F2 | **Double-charge on retry/double-click** | bare counter decrement has no idempotency (ADR-0007:36 known risk) | `contact_reveals` unique `(ws,contact,reveal_type)` + client `Idempotency-Key`; credit `FOR UPDATE` + `CHECK (>=0)`; one tx (§0.4). |
| F3 | **Revealing a suppressed/DSAR'd subject** | a stale masked candidate leaked through | In-tx suppression gate at **both** layers (`master_persons.is_suppressed` + `suppression_list`, §0.4 step 3); the gate is on the *take*, not only the browse. |
| F4 | **Owner/team leak *within* a workspace** | trusting the index pre-trim as the boundary | App-layer owner/team/list re-check at read against Postgres truth (C10; `RESEARCH_04 §5`); RLS still walls *across* workspaces under it (defense-in-depth: a Stage-1 bug is bounded UX, a Stage-2 bug is the incident). |
| F5 | **Owner-scoping mistakenly applied to the shared company/edge** | treating `master_companies`/`master_employment` as owned | They are **ownerless by design** (H2); ownership lives only on the overlay `accounts`/`contacts` (§0.5). A read that surfaces a golden field labels it shared, never owned. |
| F6 | **Job change silently overwrites a kept copy** | treating the edge change as overlay truth | The copy is owned/frozen at `as_of`; a change is a **signal + optional re-reveal** (new `revealed_channels` row, `superseded_by_id` chain) — never a rewrite (survivorship, ADR-0015; the Cognism model). |
| F7 | **`revealed_channels` mis-scoped (the same leak surface as any RLS table)** | wrong/absent FORCE-RLS policy | Identical `ENABLE`+`FORCE`+fail-closed policy as `contacts` (§RLS-1); the two-tenant itest **blocks merge** (C8). D is "no better, no worse than `contacts`" — and `contacts` is the proven posture (`BRAINSTORM_04 §2 Option D killer`). |
| F8 | **Re-charge on job change is impossible** under the existing reveal unique | `contact_reveals (ws,contact,reveal_type)` admits one row | Flagged — see OQ3; the value row appends freely (live partial-unique), the *billing* re-charge needs a `reveal_epoch`/event-versioning decision coordinated with Phase 6 + ADR-0013/0029 (do **not** silently relax the idempotency unique). |
| F9 | **Survivorship arbitration ambiguous** (user edit vs revealed vs re-revealed) | three candidate values at read | Fixed read precedence skeleton: `user_overridden` overlay → newest live `revealed_channels` (by `as_of`) → masked (§0.3); the full engine is Phase 3/U4 (OQ4). |
| F10 | **DSAR misses a copy** | erasure enumerates lists, not identities | Delete `revealed_channels` by `master_person_id` (one keyed fan-out) + tombstone overlay + global suppression; the **golden identity** is the unit of deletion (ADR-0021:129; §RLS-3.5). |
| F11 | **Free scraping-by-materialization** | an un-metered path that copies un-revealed values | There is none: the *only* copy path is the credit-gated reveal (the meter); B's free-projection scrape is **rejected** (H4; `BRAINSTORM_04 §6`). Browse is additionally view-capped + small-cell-suppressed (F4-of-search). |

---

## Pre-build thinking pass (the applicable items — `truepoint-architecture`; `PLAN_00 §8`)

- **1 Source of truth.** Layer-0 golden is truth; `revealed_channels` is a *point-in-time copy* (deliberately
  decoupled — H5); `contacts.email_enc` is the overlay's own value; the masked index is a derived candidate
  surface re-checked at read (C1; ADR-0035). No second authoritative store of golden fields inside RLS (**B
  rejected**, ADR-0035).
- **2 Failure modes / idempotency.** Reveal idempotent on `contact_reveals (ws,contact,reveal_type)` + client
  `Idempotency-Key`; the value row idempotent on `uniq_revealed_channels_live`; suppression + credit in the same
  tx. Full list above.
- **3 Duplicate prevention.** One live channel/(workspace,contact,channel) via the partial unique; re-reveal
  appends (chain), never duplicates the live row; per-workspace first-reveal-wins (ADR-0007).
- **4 Audit / change history (same-tx).** `contact_reveals` is the reveal event lineage; `revealed_channels.as_of`
  + `superseded_by_id` chain is the per-channel point-in-time history; list shares audit through `audit_log`;
  privileged DSAR writes `platform_audit_log` in the same tx (`client.ts:95-111`).
- **5 Security (IDOR / isolation / field exposure / secrets).** Grant-off Layer 0 (C7); FORCE-RLS overlay +
  `revealed_channels` (C8); owner/team/list re-check at read (C10); `master_emails`/`phones` never indexed (C4);
  the client names no `master_*_id` it can read — the pointer is server-resolved and opaque; decrypt only in the
  reveal tx (no plaintext channel off the server).
- **6 Scalability.** Copy bounded by paid reveals (not universe×workspaces); partition by month; list reads off
  non-PII facets, detail reads a bounded RLS-local JOIN, **never** a Layer-0 hydrate; lease-decrement for hot
  tenants. Scale-gate table above.
- **7 Observability.** Emit `reveal.requested/charged/zero-charged`, `revealed_channel.materialized`,
  `revealed_channel.superseded` (re-projection), masked-search view-cap-hit + small-cell-suppression counters,
  reveal-tx latency, credit-lease contention; runbook hooks for the DSAR fan-out + the search privacy thresholds.
- **8 Rollback.** Additive migration (new `revealed_channels` table + the new `leadwolf_reveal` role; overlay
  unchanged) → reversible. The reveal-into-channel write is flag-gated, so a bad reveal path can be turned off
  without touching the masked index or the overlay; the channel store can be rebuilt from `contact_reveals` +
  Layer-0 if needed (the event log is truth for *what was revealed*).
- **9 Edge cases.** Same human in two workspaces (two copies, two charges); `full_profile` reveal (two channel
  rows, one event); job change (append + chain, signal); suppressed subject (gate blocks); user-corrected value
  (precedence outranks); unknown/invalid status (`credits_consumed=0`, ADR-0013); unscoped tx (zero rows).
- **10 Assumptions (load-bearing).** (a) reveals are and stay credit-gated (the copy bound); (b) a contact has
  *few* current channels (the live partial index stays ≈1–2 rows); (c) `revealed_channels` inherits visibility
  from its contact with no drift (single visibility source); (d) Phase 3 owns the full survivorship engine — Phase
  4 only reserves the seam + the precedence skeleton.
- **11 Misuse.** No free copy path exists (only the metered reveal — F11); browse is view-capped +
  small-cell-suppressed against membership probing (`RESEARCH_04 §2.1/§3.4`); a workspace cannot infer Layer-0
  membership beyond masked facets (C7).
- **12 Load behaviour (10×).** First bottleneck = `revealed_channels` growth (bounded + partitioned) and the
  credit hot row (lease), not the overlay read path — Scale-gate ranks.
- **13 Worst case.** A megacorp reveal storm + a mass re-enrichment job-change wave: bounded — copies are
  per-reveal O(1), reads are contact→≤2 live channels, "everyone at company X" is a ClickHouse facet off the
  masked index (never an OLTP join), and re-projection is an append + async signal, never a synchronous fan-out.

---

## Open questions

The six `BRAINSTORM_04 §6` questions — each **resolved** by this PLAN or handed forward with an owner — plus the
residual research questions (`RESEARCH_04 §8`) this gate touches:

1. **A's columns vs D's table (the micro-decision inside the posture).** **Resolved:** a dedicated
   `revealed_channels` store (D's shape), **sitting beside** `contact_reveals` (event log) — value + per-field
   provenance native on the channel row, FORCE-RLS on `workspace_id`, range-partitioned by `created_at`/month.
   **Residual (hard dependency on Phase 3):** the exact provenance column set vs a single `field_provenance`
   JSONB (`PLAN_00 §11.3 OQ) — coordinate the boundary so Phase 3 is additive, not a backfill (C6).
2. **Reveal-service role + tx shape.** **Resolved:** a least-privilege `leadwolf_reveal` role (master-channel
   `SELECT` + overlay `INSERT`/credit `UPDATE`; non-BYPASSRLS, GUC-bound); credit `FOR UPDATE` + both-layer
   suppression + idempotency unique + copy-write compose in one tx (§0.4). **Residual:** owned jointly with
   `truepoint-security` for the exact grant DDL + the encryption/KMS key boundary at re-encrypt.
3. **Re-projection & re-charge on job change.** **Partially resolved:** the *value* is a new `revealed_channels`
   row (`superseded_by_id` chain, `as_of`); the *billing* re-charge cannot reuse the `contact_reveals
   (ws,contact,reveal_type)` unique as-is (F8). **Residual (decide with Phase 6 + ADR-0013/0029):** is the
   re-reveal a fresh charged event (needs a `reveal_epoch`/event-versioning key) or a free in-window refresh, and
   what is the window? Do **not** silently relax the idempotency unique.
4. **Survivorship arbitration at read.** **Skeleton resolved:** `user_overridden` overlay value → newest live
   `revealed_channels` (by `as_of`) → masked/empty. **Residual:** the full per-field survivorship/precedence
   engine + the `user_overridden` flag semantics are Phase 3/U4.
5. **Owner/visibility re-check on the channel store.** **Resolved:** `revealed_channels` carries **no own
   visibility** — it inherits the parent contact's owner/team/list filter (single visibility source), under the
   FORCE-RLS workspace wall (§0.5). Confirmed: a channel row is as sensitive as its contact and is gated the same.
6. **Masked-browse vs the channel copy (the read seam).** **Resolved:** list/table reads render from non-PII
   `contacts` facets; the PII value hydrates from `revealed_channels` only on detail/expand; **no browse path
   hydrates an un-revealed value** (§0.3). **Residual (ADR-0035 + privacy):** the masked index field set and the
   small-cell suppression threshold / view-cap shape (`RESEARCH_04 §8.1-8.2`) — owned by the search design.

> **Implementation status.** None of this is built. **Shipped:** the FORCE-RLS overlay + fail-closed GUC
> (`rls/contacts.sql:17-48`, `client.ts:48-68`), `contacts` with `owner_user_id`/`email_enc`/`is_revealed`
> (`contacts.ts:103,106,128`), the audited privileged paths (`client.ts:30-35,95-111`). **Planned (target DDL,
> not as-built):** Layer 0 (`master_*`/`source_records`/`match_links`), the overlay `master_*_id` back-refs
> (`03:495,518`), `contact_reveals` as the event log (`03:559-560`), and `visibility`/`assigned_team_id`/`teams`
> (`03:540-543`; ADR-0022 — only `owner_user_id` exists today). **NEW in this PLAN:** `revealed_channels`, the
> `leadwolf_reveal` role, the masked-search caps + small-cell suppression. Everything above is **work-to-do** — a
> *target* boundary, and the gap is the PLAN's obligation, **never** license to weaken the FORCE-RLS overlay, the
> two-tenant isolation itest gate, or the no-`leadwolf_app`-grant-on-`master_*` rule to make the copy easier
> (security has final say — CLAUDE.md precedence; `PLAN_00` C7/C8/F7).
