---
title: "Platform Admin Audit — Content & Comms Tab"
tab: content
status: fully-wired
last_audited: 2026-06-29
owner: platform-admin
---

# Platform Admin — Content & Comms Audit

## 1. Executive Summary

The **Content & Comms** tab (route `/content`, 13a Area 10 / 13 §3.10) is a **fully-wired,
audited CRUD surface** for staff-authored in-app announcements. Staff publish banners that
customers see in the `apps/web` AppShell; targeting is either **all tenants** or **one tenant**
(by raw UUID). The slice is small and clean — five frontend files (~366 LOC), a 118-LOC Hono
router, a Drizzle-backed `announcementRepository`, and a single audited action
(`announcement.publish`) gated on the `content:manage` capability.

The implementation is **architecturally correct and secure**: every mutation runs inside
`withPlatformTx`, the table is RLS deny-all to `leadwolf_app`, and the customer read derives
`tenantId` from verified session claims (never the request body), so no cross-tenant banner can
leak. The Zod `announcementUpsertSchema` enforces audience↔target coherence on the server.

The gaps are **product depth, not safety**. This is a single-channel, single-format broadcast
tool. Against Beamer, Pendo, Intercom, and Beamer-class changelog products it lacks: a tenant
**picker** (today it's a raw UUID paste), **segmentation** beyond all-or-one-tenant, **scheduling
queue / publish-later**, **read/engagement analytics**, **rich-text/markdown** bodies,
**localization**, **A/B variants**, a **changelog/release-notes** surface, an **email/template**
channel, and **legal-document versioning** (terms/privacy). The audited action vocabulary also
under-records: `update` and `toggle` both write `announcement.publish` (no distinct
`announcement.update` / `announcement.retire`), so the audit trail cannot distinguish a content
edit from a take-down.

**Priority posture:** Phase 1 closes correctness/UX quick wins (tenant picker, level/audience
enum dropdowns from shared Zod, capability render-gate, Idempotency-Key on create, split audit
actions). Phase 2 adds product depth (markdown, scheduling, read receipts, segmentation). Phase 3
is the flag-heavy comms platform (email channel, changelog, legal versioning, localization) and
needs security sign-off on any new outbound channel.

---

## 2. Current Implementation Audit

### Frontend — `apps/admin/src/features/content/`

| File | LOC | Role |
|---|---|---|
| `components/ContentPage.tsx` | ~335 | DataTable + create/edit `Dialog`, show/retire toggle, four-state via `StateSwitch` |
| `api.ts` | ~67 | `fetchAnnouncements`, `createAnnouncement`, `updateAnnouncement`, `setAnnouncementActive` via `fetchWithAuth` |
| `hooks/useContent.ts` | ~31 | `{ announcements, loading, error, reload }` (vanilla React, **not** TanStack Query) |
| `types.ts` | ~17 | Presentation `Announcement` interface mirroring `AnnouncementView` |
| `index.ts` | ~2 | Re-exports `ContentPage` |

The page renders a `DataTable` with columns Announcement (title + audience subtitle), Level
(`StatusBadge` info/warning/critical), Window (`startsAt → endsAt`), Status (Shown/Retired), and
row actions Edit / Retire-Show. The create/edit `Dialog` (max-width 560) carries: Title (`TpInput`),
Body (`TpTextarea`, 3 rows), Level (`TpSelect`), Audience (`TpSelect` all|tenant), Tenant UUID
(`TpInput`, shown only when audience=tenant), Start/End (`type="date"`). Client validation: title
& body non-empty; tenant target must match `UUID_RE` when audience=tenant. Dates are coerced to
`T00:00:00.000Z` / `T23:59:59.999Z`.

### Backend — `apps/api/src/features/admin/announcements.ts` (118 LOC)

Mounted under `/api/v1/admin/announcements`; the parent router has already applied `authn` +
`platformAdmin`. The router applies `requireCapability("content:manage")` to `*`. Endpoints:

| Method | Path | Action string | Audited |
|---|---|---|---|
| GET | `/` | `admin.list_announcements` | read (non-enum) |
| POST | `/` | `announcement.publish` | yes (`targetType:"announcement"`, metadata `{audience,level}`) |
| PUT | `/:id` | `announcement.publish` | yes (`targetId:id`); 404 if `update` touches 0 rows |
| POST | `/:id/active` | `announcement.publish` | yes (`metadata:{active}`); 404 if 0 rows |

All four wrap `withPlatformTx`. Body validation: `announcementUpsertSchema.safeParse` (POST/PUT),
`announcementSetActiveSchema` (toggle). The `:id` param is checked against `UUID_RE` before the
tx.

### Data — `packages/db`

- **Table** `announcements` (`schema/platformOps.ts`): `id`, `title`, `body`, `level` (default
  `info`), `audience` (default `all`), `tenant_target uuid`, `starts_at`, `ends_at`, `active`
  (default true), `created_by_user_id`, `created_at`, `updated_at`. Index
  `announcements_active_idx` on `(active, id)`.
- **RLS** (`rls/platformOps.sql`): defensive `CREATE TABLE IF NOT EXISTS` + `ENABLE ROW LEVEL
  SECURITY` (deny-all, no policy for `leadwolf_app`), reinforced by `REVOKE ALL` in
  `applyMigrations.ts`.
- **Repository** `announcementRepository`: `list(tx)` (newest-first, `limit(200)`), `create`,
  `update`→rows touched, `setActive`→rows touched, and the customer read
  `listActiveForTenant(tenantId)` (owner connection, `active` + display-window + audience filter,
  `limit(20)`).

### Customer surface — `apps/web`

`GET /api/v1/announcements` (`features/announcements/routes.ts`: `authn` + `tenancy`) →
`listActiveForTenant(c.get("tenantId"))`. The `AnnouncementBanner.tsx` in AppShell renders a
severity-tinted banner per item with per-id dismiss persisted to `localStorage`
(`tp-dismissed-announcements`); a read failure is non-fatal (no banner). The projection
(`ActiveAnnouncement`: id/title/body/level) carries no authoring metadata.

### Shared contract — `packages/types`

`announcementAdmin.ts` exports `announcementLevel`, `announcementAudience`,
`announcementUpsertSchema` (with the `audience`↔`tenantTarget` `.refine`), `announcementSetActiveSchema`,
`announcementViewSchema`/`AnnouncementView`, and `activeAnnouncementSchema`/`ActiveAnnouncement`.
`content:manage` is in `staffCapability` and granted to `super_admin` + `support`.
`announcement.publish` is in the `platformAuditAction` enum and attested WRITTEN in
`platformAuditCoverage.test.ts`.

---

## 3. Enterprise Benchmark Research

The Content tab is functionally an **in-app announcement / product-comms console**. The mature
comparators are product-adoption and changelog platforms, not CRMs:

- **Beamer** — segments announcements by **user role, features used, profile, and demographics**,
  and supports **publish-later scheduling** (create a post and schedule it for a specific day/time)
  plus per-post **view / unique-user / click analytics**. TruePoint has none of these — audience is
  all-or-one-tenant, "scheduling" is only a passive display window, and there is zero read
  tracking. ([Beamer features](https://www.getbeamer.com/features), [in-app notification
  center](https://www.getbeamer.com/in-app-notification-center))
- **Pendo Guides** — supports **A/B "guide experiments"** with two variants and a **controlled
  rollout percentage** (show a variant to a random % of the target segment, adjustable after
  launch), and **localization** via XLIFF export/import plus AI-powered translation into multiple
  languages. TruePoint has a single variant, no rollout control, and no localization.
  ([Pendo A/B testing](https://support.pendo.io/hc/en-us/articles/37754430083611-A-B-test-with-guide-experiments-beta),
  [Pendo localization](https://support.pendo.io/hc/en-us/articles/360031866452-Localization))
- **Intercom** *(well-known product behaviour — not freshly searched)* — separates **banners,
  posts, and product tours** as distinct in-app message types, each with audience rules, goal
  tracking, and reply collection. TruePoint has exactly one message type (a banner).
- **Beamer / changelog category** — a **public changelog page** plus **email digests** of new
  posts. TruePoint has no changelog surface and no email channel at all.

The takeaway: TruePoint's announcement engine is correct and safe but sits roughly at the
"v1 banner" tier of these products. The differentiators that matter for an enterprise admin —
**segmentation, scheduling/publish-later, engagement analytics, and localization** — are all
absent.

---

## 4. Gap Analysis

| # | Gap | Severity | Evidence |
|---|---|---|---|
| G1 | Tenant target is a **raw UUID paste** (no picker, no name resolution) | High | `ContentPage.tsx` Tenant UUID `TpInput`; `UUID_RE` only |
| G2 | Audit vocabulary collapses **update + toggle into `announcement.publish`** — can't distinguish edit from take-down | High | `announcements.ts` PUT/toggle both pass `"announcement.publish"` |
| G3 | No **Idempotency-Key** on create → double-click / retry can double-publish a banner | High | `createAnnouncement` POST has no idempotency header |
| G4 | **Segmentation** is all-or-one-tenant only — no plan/segment/cohort targeting | Medium | `audience` enum `["all","tenant"]` |
| G5 | No **publish-later scheduling queue** — `starts_at` is a passive display filter, not a job | Medium | `listActiveForTenant` filters `starts_at <= now()` |
| G6 | No **read / engagement analytics** (views, dismisses, click-through) | Medium | dismiss is client-only `localStorage`, never reported |
| G7 | **Plain-text body only** — no markdown/rich-text, no CTA link | Medium | `body text`, rendered as raw string in banner |
| G8 | No **customer-facing preview** before publish | Medium | Dialog has no preview pane |
| G9 | No **changelog / release-notes** surface | Low | not built |
| G10 | No **terms/privacy legal-document versioning** | Low | not built |
| G11 | No **email / template channel** | Low | not built |
| G12 | No **localization / i18n** of announcement copy | Low | single `body` column |
| G13 | Level/audience **enum values are hardcoded** in the page (`LEVELS`, audience options) rather than derived from the shared Zod enums → drift risk | Low | `const LEVELS = [...]` in `ContentPage.tsx` |
| G14 | UI has **no `content:manage` render-gate** — non-capable staff see buttons that 403 server-side | Low | no `canMaybe("content:manage")` guard in `ContentPage` |

---

## 5. Functional Improvements

### 5.1 Tenant picker for targeted announcements
- **Current state:** A targeted announcement requires pasting a raw tenant UUID into a `TpInput`; the only check is `UUID_RE`.
- **Problem:** Operators don't know UUIDs by heart; a typo silently targets the wrong org (or none). No confirmation of which org the banner will hit.
- **Enterprise best practice:** Beamer/Pendo target by selecting a named segment/account from a typeahead, never by raw ID.
- **Recommended implementation:** Add a debounced tenant typeahead reading the existing platform tenant-search endpoint (the Tenants tab's list, `PLATFORM_READ_LIMIT`-bounded keyset search) — display "Acme Corp · `a1b2…`", store the UUID, render the resolved name in the table subtitle instead of the truncated UUID.
- **Expected impact:** Eliminates mis-targeting; makes targeted announcements actually usable.
- **Dependencies:** Reuse Tenants-tab search API/hook; `@leadwolf/ui` Combobox/typeahead.
- **Priority:** High

### 5.2 Customer-facing preview before publish
- **Current state:** No preview; staff guess at the rendered banner from the form fields.
- **Problem:** A `critical` banner with a wall of text or a broken sentence reaches every tenant with no dry run.
- **Enterprise best practice:** WYSIWYG preview is table stakes for any broadcast tool.
- **Recommended implementation:** Render a live `AnnouncementBanner`-style preview inside the dialog from current draft state (reuse the `toneStyle`/severity logic from `apps/web`), no server round-trip.
- **Expected impact:** Fewer mistaken broadcasts; faster authoring confidence.
- **Dependencies:** Extract the banner presentation into a shared `@leadwolf/ui` primitive consumed by both apps.
- **Priority:** Medium

### 5.3 Markdown / rich body with a single CTA link
- **Current state:** `body` is plain text rendered as a raw string in the banner.
- **Problem:** No emphasis, no link to a docs page / status page; announcements that need a "Learn more" can't have one.
- **Enterprise best practice:** Beamer/Intercom support rich text + CTA buttons with click tracking.
- **Recommended implementation:** Add `bodyFormat text NOT NULL DEFAULT 'plain'` (`plain|markdown`) + optional `cta_label`/`cta_href`; render markdown through a sanitizing renderer (allowlist tags, `rel="noopener"`, validated `https:` href only). **Security owns the sanitizer choice** — no raw HTML.
- **Expected impact:** Richer, actionable announcements without an XSS surface.
- **Dependencies:** §6.1 (schema), `@leadwolf/ui` markdown renderer, security sign-off on the allowlist.
- **Priority:** Medium

### 5.4 Segmentation beyond all-or-one-tenant
- **Current state:** `audience ∈ {all, tenant}`.
- **Problem:** Can't announce to "all Enterprise-plan tenants" or "tenants in trial" — common comms needs.
- **Enterprise best practice:** Beamer segments by role/plan/usage; Pendo targets named segments.
- **Recommended implementation:** Add `audience='segment'` with a `segment_rule jsonb` (plan, lifecycle, region) evaluated server-side inside `listActiveForTenant`; keep `all`/`tenant` fast paths. Start with a small, closed set of rule keys (no free-form SQL).
- **Expected impact:** Targeted comms (billing changes for a plan tier, regional notices) without per-tenant spam.
- **Dependencies:** §6.1, §7.1; tenant plan/lifecycle columns must exist; security review of the rule evaluator.
- **Priority:** Medium

---

## 6. Backend Improvements

### 6.1 Split the audit vocabulary: `announcement.update` and `announcement.retire`
- **Current state:** POST (create), PUT (edit), and toggle all write `"announcement.publish"`.
- **Problem:** The audit trail can't distinguish "edited a live banner's body" from "took a banner down" — both look like a publish. For a customer-visible broadcast, take-down vs edit is a meaningful, separately-reviewable action.
- **Enterprise best practice:** AWS CloudTrail-style audit records one event type per distinct operation; never overload one verb across create/update/delete.
- **Recommended implementation:** Add `announcement.update` and `announcement.retire` (or `announcement.set_active` with `{active}` metadata as today) to the `platformAuditAction` enum in `packages/types/src/platformAudit.ts`; flip their PENDING→WRITTEN attestation in `platformAuditCoverage.test.ts`; pass the right action string in each `withPlatformTx` call in `announcements.ts`.
- **Expected impact:** Audit log faithfully reconstructs what happened to a banner; compliance can answer "who took this down".
- **Dependencies:** `platformAuditCoverage.test.ts` drift guard (the recipe enforces this).
- **Priority:** High

### 6.2 Validate the display window (`startsAt < endsAt`) server-side
- **Current state:** `announcementUpsertSchema` validates each timestamp independently; nothing enforces `startsAt < endsAt`.
- **Problem:** A banner with `endsAt < startsAt` silently never shows — a confusing no-op the operator can't see (no preview, no analytics).
- **Enterprise best practice:** Reject incoherent scheduling at the contract boundary.
- **Recommended implementation:** Add a `.refine` to `announcementUpsertSchema`: when both present, `startsAt < endsAt`. Mirror in the dialog (disable Save) for a fast UX signal.
- **Expected impact:** No silently-dead announcements.
- **Dependencies:** Shared schema is consumed by both apps — change once.
- **Priority:** Medium

### 6.3 Cap the authoring list and add keyset pagination
- **Current state:** `list(tx)` returns `limit(200)` newest-first with no cursor.
- **Problem:** Once the table grows past 200 the UI silently truncates and there's no way to page older banners; inconsistent with the platform's `PLATFORM_READ_LIMIT=500` keyset convention.
- **Enterprise best practice:** Bounded keyset pagination everywhere a cross-tenant list can grow.
- **Recommended implementation:** Convert `list` to a keyset reader (base64url cursor, limit+1 probe) consistent with the other platform list repos; thread a `cursor`/`nextCursor` through the route and `useContent`.
- **Expected impact:** Correct, scalable authoring list.
- **Dependencies:** Existing keyset cursor helper in `packages/db`.
- **Priority:** Low

---

## 7. Database Improvements

### 7.1 Columns for richer announcements
- **Current state:** `announcements` has only `audience` + `tenant_target`; body is plain text; no scheduling state.
- **Problem:** §5.3/§5.4/§6.4 all need new columns; ad-hoc additions risk RLS/REVOKE drift.
- **Enterprise best practice:** Extend the platform table through the established recipe so deny-all RLS and the REVOKE stay intact.
- **Recommended implementation:** In `schema/platformOps.ts` add `body_format`, `cta_label`, `cta_href`, `segment_rule jsonb`, and a `status text DEFAULT 'draft'` (`draft|scheduled|live|retired`); `bun generate`; the defensive `CREATE`/`ENABLE RLS` in `rls/platformOps.sql` and the `REVOKE ALL` in `applyMigrations.ts` already cover the table — verify the new columns are deny-all by inheritance (table-level RLS, no column grants).
- **Expected impact:** One coherent schema migration backing the §5/§6 features.
- **Dependencies:** Drizzle generate; the platform-table recipe.
- **Priority:** Medium

### 7.2 `announcement_reads` engagement table
- **Current state:** Dismiss is client-only `localStorage`; nothing is recorded server-side.
- **Problem:** No way to answer "how many tenants saw / dismissed this critical notice" — required for any comms accountability.
- **Enterprise best practice:** Beamer tracks views/unique-users/clicks per post.
- **Recommended implementation:** New platform table `announcement_reads(announcement_id, tenant_id, user_id, seen_at, dismissed_at, clicked_at)` via the full recipe (`schema/platformOps.ts` + `bun generate` + `rls/platformOps.sql` deny-all + `REVOKE` in `applyMigrations.ts`). Writes come from a lightweight authenticated customer endpoint (server-derived `tenantId`/`userId`). Read it as an aggregate on the authoring row.
- **Expected impact:** Engagement metrics; closes G6.
- **Dependencies:** §8.2 (read-event endpoint), new table recipe, design for the impression-write rate.
- **Priority:** Medium

---

## 8. API Improvements

### 8.1 Idempotency-Key on announcement create
- **Current state:** `POST /admin/announcements` has no idempotency guard.
- **Problem:** A double-click or network retry publishes the same banner twice; every tenant sees a duplicate, and there are now two audit rows and two rows to retire.
- **Enterprise best practice:** Stripe-style `Idempotency-Key` on every create.
- **Recommended implementation:** Accept an `Idempotency-Key` header on POST; persist `(key, actor, response)` and replay on repeat within the same `withPlatformTx`, consistent with the platform-wide idempotency convention. *(This is a DEFERRED platform primitive — implement the shared middleware first; mark the endpoint a consumer of it.)*
- **Expected impact:** No duplicate broadcasts on retry.
- **Dependencies:** Shared idempotency store/middleware (deferred platform work); **needs the platform idempotency primitive to land first.**
- **Priority:** High

### 8.2 Customer read-event endpoint
- **Current state:** No endpoint records that a customer saw/dismissed a banner.
- **Problem:** Engagement (§7.2) has nowhere to write.
- **Enterprise best practice:** A minimal beacon write, server-scoped to the verified tenant/user.
- **Recommended implementation:** `POST /api/v1/announcements/:id/seen` (and `/dismissed`) under `authn` + `tenancy`; derive `tenantId`/`userId` from claims; upsert into `announcement_reads`. Validate the `:id` is an active announcement applicable to the caller (reuse the `listActiveForTenant` filter) so a tenant can't write reads for a banner it can't see.
- **Expected impact:** Server-side engagement data; backs G6/§7.2.
- **Dependencies:** §7.2 table; rate-limit the beacon.
- **Priority:** Medium

### 8.3 `GET /admin/announcements/:id` detail + reads aggregate
- **Current state:** Only a list endpoint exists; the edit dialog hydrates from the list row.
- **Problem:** No single-record endpoint to show per-announcement engagement once §7.2 lands.
- **Enterprise best practice:** A detail endpoint per resource.
- **Recommended implementation:** Add `GET /:id` returning the `AnnouncementView` plus a `reads` aggregate (`seen/dismissed/clicked` counts); audited as `admin.list_announcements` (read string) or a dedicated `admin.get_announcement`.
- **Expected impact:** Per-announcement analytics panel.
- **Dependencies:** §7.2.
- **Priority:** Low

---

## 9. Dependency Mapping

- **DB tables:** `announcements` (read/write); proposed `announcement_reads`. Reads cross-reference
  `tenants` (for the picker name-resolution) and `users` (`created_by_user_id`). The
  `platform_audit_log` raw table receives every mutation.
- **Services / repositories:** `announcementRepository` (`list`, `create`, `update`, `setActive`,
  `listActiveForTenant`) in `packages/db`; `withPlatformTx` in `packages/db/src/client.ts`.
- **API endpoints:** Admin — `GET /api/v1/admin/announcements`, `POST /…`, `PUT /…/:id`,
  `POST /…/:id/active`. Customer — `GET /api/v1/announcements`. Proposed —
  `POST /…/:id/seen|dismissed`, `GET /admin/announcements/:id`.
- **Event flow:** Staff submits dialog → `createAnnouncement`/`updateAnnouncement`/`setAnnouncementActive`
  (`fetchWithAuth`) → admin router (`content:manage`) → `withPlatformTx` writes
  `announcement.publish` + repo mutation atomically → customer AppShell mounts → `GET /announcements`
  → `listActiveForTenant(verified tenantId)` → `AnnouncementBanner` renders → dismiss persists to
  `localStorage`.
- **Background workers:** **None today.** Proposed publish-later (§17 Phase 2) would add a scheduler
  worker flipping `status scheduled→live` at `starts_at`; today scheduling is a passive read filter.
- **Queue dependencies:** None today. A future email channel (§17 Phase 3) would enqueue onto the
  existing BullMQ/Redis outreach infra (reuse, do **not** duplicate, the email subsystem).
- **Permission / capability dependencies:** `content:manage` (in `staffCapability`), granted to
  `super_admin` + `support` via `ROLE_CAPABILITIES`; enforced by `requireCapability` after `authn`
  (JWT `pa` claim) → `platformAdmin`. UI render-gate via `useStaffMe().canMaybe("content:manage")`
  (proposed, G14). Customer read gated only by `authn` + `tenancy`.
- **Feature-flag dependencies:** None today. Phase 3 surfaces (email channel, changelog, legal
  versioning, localization) must each ship behind a flag (LaunchDarkly/Statsig-style) with a
  documented kill switch.
- **External integrations:** None today. A future email channel depends on the existing
  `EmailSenderPort` + suppression/consent path (email M12); a changelog page would depend on
  `apps/web` public routing.
- **Cross-module dependencies:** Shared contract in `@leadwolf/types` (`announcementAdmin.ts`)
  consumed by `apps/api`, `apps/admin`, `apps/web`; the `AnnouncementBanner` presentation is
  duplicated across admin-preview and web — candidate for a shared `@leadwolf/ui` primitive. The
  proposed tenant picker depends on the **Tenants** tab's search endpoint.

---

## 10. Security Review

**Strong points (verified):**
- **Tenant isolation on the customer read is correct.** `listActiveForTenant` runs on the owner
  connection but the `tenantId` comes from `c.get("tenantId")` (verified `tenancy` middleware),
  never the request body — no cross-tenant banner can leak. The table is RLS deny-all to
  `leadwolf_app` + `REVOKE ALL`, so the app role can never read it directly.
- **Every mutation is audited and atomic** via `withPlatformTx`; a thrown `NotFoundError` inside the
  tx rolls back both the mutation and the audit row.
- **Capability gate is server-enforced** (`requireCapability("content:manage")`), re-checked per
  request, so a revoked role can't ride a stale JWT.
- **Audience↔target coherence** is enforced server-side by the Zod `.refine`, not just the dialog.

**Risks / required fixes:**
1. **XSS on rich body (future).** If §5.3 markdown lands without a strict sanitizer, the body is
   rendered into every tenant's app shell. **Security owns the allowlist**; render plain text until
   a sanitizing renderer + `https:`-only CTA hrefs are signed off. **Priority: High (gating §5.3).**
2. **No Idempotency-Key (§8.1).** A retried create double-broadcasts; for a customer-visible message
   this is an integrity/abuse concern, not just UX. **Priority: High.**
3. **Audit overload (§6.1).** A single `announcement.publish` for create/update/retire weakens the
   forensic value of the log for a customer-facing surface. **Priority: High.**
4. **Read-event endpoint authz (§8.2).** When added, the beacon must reject reads for announcements
   the caller can't see (reuse the `listActiveForTenant` filter) and be rate-limited, or it becomes
   a write-amplification/enumeration vector. **Priority: Medium.**
5. **No UI render-gate (G14).** Cosmetic only — the server is the boundary — but non-capable staff
   seeing 403-ing buttons is poor UX and a small information leak about what exists. **Priority: Low.**

No deferred IAM items (staff SSO/MFA/IP-allowlist, peer-approval, KMS) are specific to this tab —
they apply platform-wide and are tracked centrally.

---

## 11. Performance Review

The tab is **light** and not a performance concern at current scale:
- Authoring list is `limit(200)`, indexed by `(active, id)`; single round-trip, no N+1.
- Customer read is `limit(20)` with the same index covering the `active` predicate; called once per
  AppShell mount.
- **Watch items:** (a) the customer banner read fires on every AppShell mount — if it becomes hot,
  cache the active set per-tenant (short TTL) since announcements change rarely; (b) the proposed
  `announcement_reads` write is the only high-cardinality path — batch/debounce the impression beacon
  client-side and rate-limit server-side to avoid write amplification; (c) the planned tenant picker
  must use the bounded keyset search, never an unbounded tenant scan.

---

## 12. UX/UI Improvements

### 12.1 Capability render-gate on authoring controls
- **Current state:** "New announcement", Edit, and Retire/Show always render; the server 403s a non-capable actor.
- **Problem:** A `read_only` or `billing_ops` staffer sees buttons that fail — confusing, and leaks what the tab can do.
- **Enterprise best practice:** Hide/disable controls the actor lacks the capability for (UI hint; server stays the boundary).
- **Recommended implementation:** Wrap the action buttons in `useStaffMe().canMaybe("content:manage")`; render a read-only table for non-capable staff.
- **Expected impact:** Cleaner, honest UI; fewer dead-end 403s.
- **Dependencies:** `lib/staffMe` `useStaffMe`.
- **Priority:** Medium

### 12.2 Drive level/audience selects from the shared Zod enums
- **Current state:** `const LEVELS = ["info","warning","critical"]` and the audience `<option>`s are hardcoded in `ContentPage.tsx`.
- **Problem:** The dialog can drift from `announcementLevel`/`announcementAudience` in `@leadwolf/types` when a value is added.
- **Enterprise best practice:** Single source of truth for enums across contract and UI.
- **Recommended implementation:** Export `announcementLevel.options` / `announcementAudience.options` from the shared schema and map them in the `TpSelect`s.
- **Expected impact:** No enum drift between server contract and form.
- **Dependencies:** `@leadwolf/types` re-export.
- **Priority:** Low

### 12.3 Resolve and show the targeted tenant name in the table
- **Current state:** The table subtitle shows `tenant {first 8 chars of UUID}`.
- **Problem:** Operators can't tell which org a targeted banner hits from the list.
- **Enterprise best practice:** Show the human name, ID secondary.
- **Recommended implementation:** With the §5.1 picker storing the resolved name (or a join against tenants), render "Acme Corp" with the UUID as a tooltip.
- **Expected impact:** Readable authoring list.
- **Dependencies:** §5.1.
- **Priority:** Medium

---

## 13. Automation Opportunities

- **Publish-later scheduler:** A worker that flips `status scheduled→live` at `starts_at` (vs the
  current passive read filter) enables true scheduled campaigns and a "Scheduled" state in the UI.
- **Auto-retire:** A sweep that sets `active=false` once `ends_at < now()` so retired banners stop
  scanning in the customer read and show "Expired" in the console.
- **Engagement digest:** Once `announcement_reads` exists, a daily summary (seen/dismissed/clicked
  per live banner) to the authoring staff — Beamer-style post analytics.
- **Drift guard (already automated, keep):** `platformAuditCoverage.test.ts` blocks any new audited
  action that isn't attested WRITTEN — every §6.1 action must pass through it.

---

## 14. Monitoring & Logging

- **Audit (present):** `announcement.publish` rows in `platform_audit_log` capture actor, target,
  IP, and `{audience,level}`/`{active}` metadata. **Gap:** create/update/retire are
  indistinguishable (§6.1) — fix to make the log forensically useful.
- **Reads (present):** `admin.list_announcements` recorded as a read action string.
- **Add:** structured logs / metrics on the customer banner read (latency, empty-result rate);
  count of active announcements per tenant (catch runaway broadcasts); error rate on the
  customer read (it's swallowed to non-fatal today — log it server-side so a broken read is
  visible even though the banner silently hides).
- **Alerting:** alert if an announcement is published to `audience=all` at `critical` level
  (high-blast-radius action) so on-call is aware of a platform-wide critical banner.

---

## 15. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Double-publish on retry (no Idempotency-Key) | Medium | Med (duplicate banner to all tenants) | §8.1 Idempotency-Key |
| XSS via future rich body | Low (not built) | High | §5.3 sanitizer; security sign-off gates the feature |
| Mis-targeted banner via UUID typo | Medium | Med (wrong org sees a notice) | §5.1 tenant picker |
| Silently-dead banner (`endsAt<startsAt`) | Medium | Low | §6.2 cross-field validation |
| Audit can't distinguish edit vs take-down | High (today) | Med (compliance/forensics) | §6.1 split actions |
| Customer read becomes hot at scale | Low | Low | §11 per-tenant cache |
| `announcement_reads` write amplification | Low (not built) | Med | §8.2 batching + rate-limit |

---

## 16. Technical Debt

- **Audit-action overloading (G2/§6.1)** — the most pressing debt; one verb for three operations.
- **Hardcoded enums in the page (G13/§12.2)** — duplicates the shared Zod source.
- **Duplicated banner presentation** — `apps/web/AnnouncementBanner` and the (proposed) admin
  preview render the same thing twice; extract a `@leadwolf/ui` primitive.
- **No pagination on `list` (§6.3)** — silent truncation at 200; off-pattern vs the platform keyset
  convention.
- **Client-only dismiss** — engagement state lives in `localStorage` with no server record (G6).
- **Inline styles in `ContentPage`/`AnnouncementBanner`** — heavy inline `style={{…}}` usage; should
  migrate to tokenized classes per the design system.

---

## 17. Multi-Phase Implementation Plan

### Phase 1 — Correctness & UX quick wins (Priority: High → Critical)
- **Objectives:** Make the existing tab safe to operate at scale and honest in its audit trail.
- **Scope:** Tenant picker, level/audience enum dropdowns from shared Zod, `content:manage`
  render-gate, Idempotency-Key on create, split audit actions, cross-field date validation.
- **Deliverables:** §5.1, §6.1, §6.2, §8.1, §12.1, §12.2.
- **Technical tasks:** Add `announcement.update`/`announcement.retire` to `platformAudit.ts` + flip
  `platformAuditCoverage.test.ts` attestation; pass distinct action strings in `announcements.ts`;
  add `startsAt<endsAt` `.refine` to `announcementUpsertSchema`; wire `Idempotency-Key` (consumes the
  platform idempotency primitive); build the tenant typeahead reusing the Tenants search hook;
  `canMaybe("content:manage")` gate; export enum `.options`.
- **Risks:** Idempotency depends on the shared primitive landing first; audit-enum change must pass
  the drift guard or CI is red.
- **Dependencies:** Platform idempotency middleware (deferred); Tenants-tab search API; `staffMe`.
- **Testing requirements:** API tests for distinct audit actions (assert the `platform_audit_log`
  rows), the date-coherence rejection, and idempotent replay; admin isolation test that a
  non-`content:manage` actor 403s on each mutation; UI test for the render-gate.
- **Estimated complexity:** Low–Medium.
- **Success criteria:** Create/update/retire emit distinct, attested audit actions; retried create
  is idempotent; targeted announcements are authored via picker; non-capable staff see a read-only
  table.

### Phase 2 — Product depth (Priority: Medium → High)
- **Objectives:** Bring the announcement engine to Beamer-v1 parity — richer content, scheduling,
  engagement, segmentation.
- **Scope:** Markdown + CTA, customer preview, publish-later scheduler + auto-retire,
  `announcement_reads` + read endpoint, segment targeting.
- **Deliverables:** §5.2, §5.3, §5.4, §7.1, §7.2, §8.2, §8.3, §13 automation, §14 metrics.
- **Technical tasks:** Extend `announcements` (`body_format`, `cta_*`, `segment_rule`, `status`) via
  the platform-table recipe; new `announcement_reads` table via the full recipe (schema + generate +
  `rls/platformOps.sql` deny-all + `REVOKE`); sanitizing markdown renderer; scheduler + auto-retire
  workers; `POST /:id/seen|dismissed` + `GET /:id` aggregate; segment evaluator in
  `listActiveForTenant`.
- **Risks:** XSS via markdown (security-gated); read-beacon write amplification; segment rule scope
  creep (keep keys closed).
- **Dependencies:** Phase 1; existing keyset helpers; design for sanitizer + impression batching;
  worker infra.
- **Testing requirements:** Sanitizer fuzz/XSS tests; isolation test that a tenant can't write reads
  for an inapplicable announcement; segment-evaluator unit tests; scheduler/auto-retire worker tests.
- **Estimated complexity:** Medium–High.
- **Success criteria:** Markdown renders safely; scheduled banners go live/retire automatically; per-
  announcement seen/dismissed counts visible; segment-targeted announcement reaches only matching
  tenants.

### Phase 3 — Comms platform (flag-heavy, security sign-off) (Priority: Low → Medium)
- **Objectives:** Turn the tab into a multi-channel comms console: changelog, email, legal-doc
  versioning, localization, A/B.
- **Scope:** Public changelog/release-notes surface; email channel reusing the M12 email subsystem;
  terms/privacy versioning with acceptance tracking; announcement localization; A/B variants with
  controlled rollout.
- **Deliverables:** G9–G12 closed; Pendo-class A/B + localization; Beamer-class changelog + email
  digest.
- **Technical tasks:** Each surface behind its own feature flag with a kill switch; email channel
  enqueues on the existing BullMQ/Redis outreach infra via `EmailSenderPort` + suppression/consent
  (**reuse M12, never duplicate**); legal-doc versioning as a new platform table + acceptance ledger;
  localization columns/keys per announcement; A/B variant table + rollout-percentage evaluator.
- **Risks:** New outbound channel = deliverability, consent, and abuse surface (security + ops
  sign-off mandatory); legal-doc acceptance has compliance weight; localization fan-out cost.
- **Dependencies:** Email M12 subsystem; feature-flag platform; security/compliance review per
  channel; `apps/web` public routing for the changelog.
- **Testing requirements:** Email consent/suppression integration tests; flag on/off + kill-switch
  tests; legal-acceptance audit tests; localization fallback tests; A/B assignment determinism tests.
- **Estimated complexity:** High.
- **Success criteria:** Each channel ships behind a flag with a documented kill switch; email respects
  suppression/consent; legal-doc versions are tracked with per-tenant acceptance; announcements
  localize with fallback; A/B variants split deterministically by rollout %.

---

## 18. Final Recommendations

1. **Split the audit vocabulary (§6.1).** *Current state:* one `announcement.publish` for
   create/update/retire. *Problem:* the audit log can't distinguish a content edit from a customer-
   facing take-down. *Enterprise best practice:* one event type per operation (CloudTrail).
   *Recommended implementation:* add `announcement.update`/`announcement.retire` to the enum + attest
   WRITTEN + pass distinct strings. *Expected impact:* faithful forensic trail. *Dependencies:*
   drift guard. *Priority:* **High.**

2. **Ship the tenant picker (§5.1).** *Current state:* raw-UUID paste. *Problem:* silent
   mis-targeting. *Best practice:* named typeahead. *Implementation:* reuse Tenants search.
   *Impact:* targeted announcements become usable and safe. *Dependencies:* Tenants API.
   *Priority:* **High.**

3. **Add Idempotency-Key to create (§8.1).** *Current state:* none. *Problem:* retried create
   double-broadcasts. *Best practice:* Stripe-style key. *Implementation:* consume the (deferred)
   platform idempotency primitive. *Impact:* no duplicate banners. *Dependencies:* shared
   idempotency middleware **must land first**. *Priority:* **High (blocked on infra).**

4. **Gate rich body behind a sanitizer (§5.3, §10).** *Current state:* plain text. *Problem:* future
   markdown into every tenant's shell is an XSS surface. *Best practice:* allowlist sanitizer +
   `https:`-only CTA. *Implementation:* security owns the renderer choice. *Impact:* richer
   announcements with no injection. *Dependencies:* **security sign-off gates the feature.**
   *Priority:* **High (do not ship markdown without it).**

5. **Build engagement (§7.2 / §8.2).** *Current state:* client-only dismiss. *Problem:* no
   accountability for customer-visible notices. *Best practice:* Beamer per-post analytics.
   *Implementation:* `announcement_reads` table + rate-limited beacon endpoint. *Impact:*
   seen/dismissed/clicked metrics. *Dependencies:* new-table recipe; impression batching. *Priority:*
   **Medium.**

**Sequencing:** Phase 1 (audit split, picker, render-gate, enum source-of-truth, date validation) is
low-risk and high-value — do it first. Idempotency rides the platform primitive. Markdown,
scheduling, engagement, and segmentation (Phase 2) bring Beamer-v1 parity. The multi-channel comms
platform (Phase 3 — email, changelog, legal versioning, localization, A/B) is flag-heavy and needs
security/compliance sign-off per channel; treat it as a separate program, not a tab enhancement.

**Sources:** [Beamer features](https://www.getbeamer.com/features) ·
[Beamer in-app notification center](https://www.getbeamer.com/in-app-notification-center) ·
[Pendo guide experiments (A/B)](https://support.pendo.io/hc/en-us/articles/37754430083611-A-B-test-with-guide-experiments-beta) ·
[Pendo localization](https://support.pendo.io/hc/en-us/articles/360031866452-Localization)
