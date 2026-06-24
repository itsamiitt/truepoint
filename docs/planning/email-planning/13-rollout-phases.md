# Email Subsystem — Rollout Phases, Work Units & Verification (13)

> **Status:** Plan (not yet built). **Owner:** Platform + Data + Security + Architecture. **Last updated:** 2026-06-24.
> This is Doc #14 (the **capstone**) of the `docs/planning/email-planning/` set. It cites the **Locked
> Decisions (D1–D10)**, **Shared Vocabulary**, **Canonical Entities**, and — uniquely — **owns and renders the
> Phase Map (P0–P6)** named in `00-overview.md`. Every other doc in this set references *this* doc for the
> phase a piece of work lands in; this doc references *them* for the detail of what that work is. It mirrors the
> shipped `docs/planning/list-plan/09-rollout-phases.md` in shape and tone: the ordered phases, what each
> delivers, how phases depend on each other, the independently-mergeable work-unit decomposition, the feature
> flags, and the end-to-end verification recipe. **No code** — plain English, entity/queue/endpoint/flag names
> only.
>
> **This document is the execution contract.** Where it says a control lands in a phase, that control is part
> of that phase's "Done when" and is **not** deferrable to "later". The security-precedence rule applies
> throughout: on any access, tenant-isolation, secret, PII, or compliance point, security wins over
> convenience or sequencing.

---

## 1. Sequencing principles

These five principles decide the order of everything below.

1. **Highest-risk-first, not backend-light-first.** The List tab could afford to be "backend-light first"
   (`list-plan/09 §1`) because its backend already existed and its blast radius was internal. Email is the
   opposite: **there is no email subsystem today** (`00 §1`), and a bug is visible to people *outside* the
   tenant — a double-send, a wrong-merge variable, or a missed suppression is an email in a stranger's inbox,
   not an internal data error. So we front-load the two **unforgiving** risks (§4): **deliverability
   infrastructure** (`02`, `03`) and **per-tenant sending-reputation isolation** (`07`). Both live in **P0/P1**,
   before a single production recipient is touched.
2. **Isolation and money rules are never deferred.** The MANDATORY cross-tenant isolation itest (`security`
   constraint) ships in the same phase that introduces each new table or endpoint — starting in **P0** and
   re-run in every subsequent phase. **D4** (suppression gates *every* send) and the per-tenant FinOps
   quota/cap/per-user limit (`operations`) are enforced in the phase that introduces the relevant write path,
   never bolted on.
3. **Every phase ships behind an `email.*` feature flag, gated per-tenant** (§3). A phase merges to main dark,
   is enabled for internal/seed tenants first, then rolled out per-tenant. The flag is the rollback lever;
   nothing in email is enabled globally on merge.
4. **Each phase is independently mergeable and leaves the product shippable.** Work units mirror the List tab's
   per-module slices (`db` / `db/test` / `types` / `core` / `api` / `web` / `admin` / `workers`), each small
   enough to review and revert in isolation, exactly as Phases 0–5 of the List tab shipped.
5. **The data path is opened in the right order.** Per the read-first rule, no email data path starts without
   `truepoint-platform` (tenancy/RLS), `truepoint-data` (model/ownership), and `truepoint-security` (access)
   satisfied. A multi-tenant write without an RLS-enforced, ownership-checked path is a bug, not a style choice.

---

## 2. The phase table (the contract at a glance)

This table is the contract; §5 expands each row. "Risk" is the inherent blast radius of getting the phase
wrong, not the effort.

| Phase | Goal | Work units (independently mergeable) | Depends on | Done when | Risk |
|---|---|---|---|---|---|
| **P0 — Foundations** | The schema, isolation proof, secret storage, and DNS-authenticated sending identity every later phase needs. | `db` email schema (`09`) + `rls/email.sql`; `db/test` cross-tenant isolation itest; `types` DTOs; `core/email` secret-storage (envelope-encryption, D7) + DNS-auth verifier; `api` mailbox-connect (OAuth) + sending-domain routes; `web` Mailboxes connect stub. | — (root) | Migrations apply; RLS ENABLE+FORCE proven by the two-tenant itest; a mailbox connects via OAuth with secrets stored server-side; a `sending_domain` reaches **DNS-verified** (SPF+DKIM+DMARC) before it is usable; suppression + consent tables exist. | **Highest** — secrets are live mailbox credentials (D7); DNS auth is a hard Gmail/Yahoo gate (`03`). |
| **P1 — Reputation isolation + send path** | A single 1:1 send leaves the building, on a per-tenant identity, idempotently, suppression-gated, with delivery/bounce ingested. | `db` reputation-pool/idempotency-key columns; `core/email` send-builder + suppression gate (D4) + idempotency (D5); `workers` `email_send` + delivery/bounce ingestion; `api` send + webhook routes (signed); `web` Mailboxes + Suppression surfaces (`10`). | P0 | A queued 1:1 send delivers from the tenant's own domain/pool (D2/D3); a duplicate Idempotency-Key sends **once** (D5); a suppressed/consent-blocked recipient is **never** sent to (D4); a signed delivery/bounce webhook updates `email_send`; cross-tenant itest + webhook-signature test green. | **Highest** — reputation isolation (D2) is unforgiving; one tenant must never damage another's deliverability. |
| **P2 — Templates** | Reusable, versioned, render-safe templates with ownership/sharing. | `db` `email_template`/`email_template_version`; `core/email` render engine (variables + fallbacks, no untrusted eval); `api` template CRUD; `web` Templates tab (`10`); `types` template DTOs. | P0 (P1 for "send a test") | Author → version → render a template with variables/fallbacks; render-safety proven (no template injection); owner-scoped + shareable (D8); cross-tenant itest green. | Medium — render-safety is an injection surface; ownership is D8. |
| **P3 — Tracking + Inbox** | Full event tracking, per-contact timeline, reply detection, unified inbox, real-time status. | `db` `email_tracking_event`; `workers` `email_tracking` ingestion; `core/email` reply-detection + open/click pixel/redirect (per-tenant tracking domain, D3); `api` event + inbox routes; `web` timeline + unified inbox + live status (`04`, `10`). | P1 (send path), P2 (templated sends to track) | Open/click/reply/bounce/complaint/unsubscribe events ingest idempotently via signed webhooks; per-contact timeline + unified inbox render; reply detected; opens labelled **informational, not KPI** (D6); cross-tenant itest + webhook-signature test green. | Medium-high — inputs are attacker-controlled (`04`); custom tracking domain must stay per-tenant (D3). |
| **P4 — Sequences + automation** | Multi-step cadences with scheduling, branching, auto-pause-on-reply, throttled enrollment. | `db` `email_sequence`/`email_sequence_step`/`email_enrollment`; `core/email` cadence engine + auto-pause; `workers` `email_sequence_tick` under a **leader lock**; `api` sequence/enroll routes; `web` Sequences tab (`05`, `10`). | P3 (reply detection drives auto-pause) | Enroll a List into a sequence; steps fire on schedule; a reply auto-pauses enrollment; enrollment is throttled per mailbox/pool; the scheduler runs under a leader lock (single fire); cross-tenant itest green. | High — automation multiplies send volume; a scheduler bug fans out duplicate sends across tenants. |
| **P5 — Deliverability + warmup + analytics** | Warmup automation, deliverability dashboard, seed/placement, blacklist monitoring, analytics + leaderboards. | `workers` `email_warmup`; `core/email` warmup ramp + placement/seed hooks + blacklist monitor; `api` deliverability + analytics routes; `web` Deliverability + Analytics tabs + leaderboards (`03`, `08`, `10`). | P1 (send path), P3 (events feed analytics) | Warmup ramps a new mailbox/domain on a schedule; deliverability dashboard shows auth/placement/blacklist status; analytics report **reply rate as primary KPI** (D6); leaderboards render; cross-tenant itest green. | Medium — warmup mis-pacing harms reputation; analytics must not leak cross-tenant aggregates. |
| **P6 — Admin + governance** | Internal `/admin` infra/limits/reputation control, global suppression, billing, compliance/audit, DSAR cascade. | `admin/api` mailbox/domain mgmt + per-tenant limits/reputation + global suppression + email-volume billing; `admin/web` governance surfaces (`11`); `db/test` per-endpoint cross-tenant HTTP isolation + DSAR-cascade itests; audit wiring (`06`, `12`). | P1 (infra to govern), P3/P4 (volume to bill/limit) | Staff manage domains/mailboxes/limits via `/admin`; global suppression blocks sends tenant-wide; email-volume billing meters per tenant; DSAR erasure cascades across all email entities; per-endpoint cross-tenant HTTP isolation itest green; compliance/audit (`06`) proven. | High — staff over-reach and DSAR misses are compliance failures (`06`, `12`). |

---

## 3. Feature flags (`email.*`, gated per-tenant)

Email reuses the platform feature-flag provider the List tab used (`apps/api/.../admin` provider, gated
per-tenant), under the `email.*` namespace. Every phase merges dark behind its flag; flags are enabled
seed-tenants-first, then rolled out per-tenant; the flag is the rollback lever.

| Flag | Gates | Introduced |
|---|---|---|
| `email.foundations` | Schema/admin scaffolding visibility (internal only). | P0 |
| `email.mailboxes` | Mailbox connect (OAuth) + Mailboxes surface. | P0/P1 |
| `email.domains` | Sending-domain DNS-auth setup + verification. | P0/P1 |
| `email.send` | The 1:1 send path (gated tenant-by-tenant only after DNS auth + reputation isolation are proven). | P1 |
| `email.suppression` | Suppression + consent surfaces and the D4 gate UI. | P1 |
| `email.templates` | Templates tab + CRUD/versioning. | P2 |
| `email.tracking` | Event tracking, timeline, real-time status. | P3 |
| `email.inbox` | Unified inbox + reply detection. | P3 |
| `email.sequences` | Sequences tab + automation + enrollment. | P4 |
| `email.warmup` | Warmup automation. | P5 |
| `email.deliverability` | Deliverability dashboard + blacklist/placement monitoring. | P5 |
| `email.analytics` | Analytics tab + leaderboards. | P5 |
| `email.admin` | `/admin` governance, per-tenant limits/reputation, global suppression, billing. | P6 |

**Flag discipline (mandate):** `email.send`, `email.sequences`, and `email.warmup` are **send-volume** flags
— they are never enabled for a tenant whose `sending_domain` is not DNS-verified (`03`) and whose reputation
pool is not isolated (`07`). Wiring the per-tenant quota/cap/per-user limit *into the metered send path* is a
precondition of enabling `email.send` (see the known-gaps track, §6).

---

## 4. Highest-risk-first callout — the two unforgiving items

Two items in this set are categorically different from the rest: getting them wrong is **not recoverable by a
patch**, because the damage lands outside TruePoint's control (in mailbox-provider reputation systems and in
strangers' inboxes) and is shared across tenants. Both are **front-loaded into P0/P1**, before any production
recipient is reached. Everything else in the plan is sequenced *around* protecting these two.

### 4.1 (a) Deliverability infrastructure — sending domains, DNS auth, warmup, provider integration (docs `02`, `03`)

**Why it is unforgiving.** Deliverability reputation is built slowly and destroyed instantly, and it is held
by *external* systems (Gmail, Yahoo, Outlook, blocklist operators) that TruePoint cannot reset. As of February
2024, Gmail and Yahoo make **SPF + DKIM + DMARC a hard requirement** for bulk senders, not an optimization —
and require the `From:` domain to **align** with the passing SPF or DKIM identifier (`03 §1`). A single
shared-infrastructure mistake — a shared tracking domain, an unauthenticated `sending_domain`, an unhandled
bounce, a cold IP sending at full volume without warmup — can blacklist a domain (or every tenant at once if
infrastructure is shared) for weeks. There is no rollback for a poisoned domain reputation; you start over on
a new domain.

**How it is front-loaded.** P0 establishes the authentication stack **per `sending_domain`** and makes a
domain unusable for any `email_send` until DNS auth is **verified** (`03 §1`); secret storage for live mailbox
credentials lands the same phase (D7). P1 puts the send path behind that verification and behind D1's hybrid
provider strategy (mailbox-world vs platform-world, **no shared-IP bulk cold pool**, `02 §1.1`). Warmup
automation (`03`, `07`) follows in P5 — but the *constraint* it protects (never send cold at full volume) is a
P1 send-path rule, not a P5 afterthought. The DNS-auth verification check (SPF/DKIM/DMARC) is part of the
mandatory verification recipe in P0 and P1 (§7).

### 4.2 (b) Per-tenant sending-reputation isolation (doc `07`)

**Why it is unforgiving.** In a multi-tenant email platform, **one tenant's behaviour can silently destroy
another's deliverability** if they share IPs, domains, or tracking infrastructure. This is the documented
failure mode of shared-pool tools (the Instantly/Smartlead shared-IP bulk pattern, `02 §1.1 / §4.2`): a noisy
neighbour's complaints depress everyone's inbox placement, and the victim tenant has no recourse and no
visibility into the cause. **D2** (reputation isolation per-tenant) and **D3** (custom tracking domain per
tenant) exist precisely to prevent this — and they are only protective if enforced *before* the first send,
because reputation, once pooled, cannot be un-pooled.

**How it is front-loaded.** P1 is named "**Reputation isolation + send path**" — the isolation is not a layer
on top of sending; it *is* the send path's foundation. Every send in P1 resolves a **per-tenant** sending
domain and Reputation Pool (D2) and a **per-tenant** custom tracking domain (D3); there is no code path that
routes a tenant's cold sequence through a shared TruePoint-owned pool. The cross-tenant isolation itest (§7)
proves at the database layer that tenant A cannot read or write tenant B's `mailbox_integration`,
`sending_domain`, reputation-pool, `email_send`, or `email_suppression` rows — the structural guarantee behind
D2/D3.

> **Contract:** P1 does not ship — `email.send` is not enabled for any tenant — until both 4.1 and 4.2 are
> proven by the P0/P1 verification recipe (§7). These are the gating items for the entire subsystem.

---

## 5. The phases in depth (P0 → P6)

### P0 — Foundations

**Goal.** Lay the schema, the proof of tenant isolation, the secret-storage primitive, and the
DNS-authenticated sending identity that *every* later phase depends on. Nothing user-visible sends yet.

**Work units (independently mergeable):**
- `db` — `packages/db/src/schema/email.ts`: the canonical entities owned by `09` that P0 needs —
  `mailbox_integration`, `sending_domain`, `email_suppression`, `email_consent`, `email_idempotency_key`, and
  the skeletons of `email_send` / tracking that later phases extend. `tenant_id` always; `workspace_id` where
  workspace-scoped; `owner_user_id` where user-owned (D8). `tenant_id`-leading indexes.
- `db` — `packages/db/src/rls/email.sql`: RLS **ENABLE + FORCE**, fail-closed `NULLIF` tenant predicate on
  every email table, mirroring the contacts/lists RLS shape.
- `db` — `packages/db/src/repositories/emailRepository.ts`: the tenant-scoped repository every API/core/worker
  call goes through (no raw cross-tenant queries), established at P0 and extended per phase.
- `db/test` — `packages/db/src/test/email.isolation.itest.ts`: the **MANDATORY cross-tenant isolation itest**
  (modelled on `savedSearches.itest.ts` / `list-plan/09`): seed **two tenants**, assert tenant A cannot
  read/write/modify tenant B's email rows across every P0 entity.
- `types` — `@leadwolf/types`: Zod DTOs for mailbox connect, sending-domain, suppression, consent.
- `core` — `packages/core/src/email/`: the secret-storage primitive (server-side, **envelope-encryption
  target — KMS**, app-AES-GCM today per the known-gaps track §6) and the DNS-auth verifier (resolves and
  checks SPF/DKIM/DMARC for a `sending_domain`).
- `api` — `apps/api/src/features/email/{routes.ts,index.ts}`: mailbox-connect (Google/Microsoft **OAuth**)
  and sending-domain create/verify endpoints under `/api/v1`; Zod-validated; RFC 9457 errors; IDOR → 404.
- `web` — `apps/web/src/features/email/`: a minimal Mailboxes-connect entry (behind `email.foundations`),
  feature folder scaffolded (`api.ts`, `types.ts`, `components/`, `hooks/`, `index.ts`) per the architecture
  structure.

**Dependencies.** None — P0 is the root.

**Feature flags.** `email.foundations` (internal only), `email.mailboxes`, `email.domains`.

**Done when.**
- Migrations apply cleanly; RLS is ENABLE+FORCE on every email table and proven by the two-tenant itest.
- A mailbox connects via OAuth and its credential is stored **server-side only** (D7) — never on the client,
  never in logs.
- A `sending_domain` can be created and only reaches **DNS-verified** when SPF + DKIM + DMARC actually pass
  (`03`); an unverified domain is unusable for any send.
- `email_suppression` and `email_consent` tables exist with the D4/D9 shape (`06`, `09`).

**Verification recipe.**
- **Cross-tenant isolation itest** (MANDATORY): two tenants seeded; every P0 entity proven non-crossable.
- **DNS-auth checks**: a domain with valid SPF/DKIM/DMARC verifies; one missing any record stays unverified.
- **Secret-storage test**: stored credential round-trips via the encryption primitive; plaintext never
  appears in logs or API responses.
- Gate: `npx turbo run typecheck`, `bun test`, `npx @biomejs/biome check`, `npm run lint:boundaries`,
  regenerate `docs/ARCHITECTURE_MAP.md`.

---

### P1 — Reputation isolation + send path

**Goal.** Send one real 1:1 email, on a **per-tenant** sending identity, **idempotently**, **suppression- and
consent-gated**, with delivery/bounce ingested over a **signed** webhook. This phase ships the two unforgiving
risks (§4) and is the gate for the whole subsystem.

**Work units:**
- `db` — Reputation Pool + per-tenant tracking-domain columns/links; finalize `email_send` and
  `email_idempotency_key` (D5).
- `core` — `packages/core/src/email/`: the send-builder (resolves per-tenant `sending_domain` + Reputation
  Pool (D2) + custom tracking domain (D3) + the right credential/provider per D1's hybrid table); the
  **suppression + consent gate (D4)** that runs on *every* send before bytes leave; idempotency (D5).
- `workers` — `apps/workers/src/queues/emailSend.ts` (the D10 `email_send` fan-out queue) and the
  delivery/bounce **ingestion** queue; idempotent, at-least-once, backoff + DLQ; workers **set tenant context
  per job**.
- `api` — send endpoint (Idempotency-Key required, D5) and the **signed** delivery/bounce **webhook**
  endpoint; webhook signatures verified; no PII in logs.
- `web` — the **Mailboxes** and **Suppression** customer surfaces (`10`), four states, `@leadwolf/ui`,
  `var(--tp-*)`, WCAG 2.2 AA.

**Dependencies.** P0 (schema, RLS, secret storage, DNS-verified domain).

**Feature flags.** `email.send`, `email.suppression` (plus P0's `email.mailboxes` / `email.domains`).
`email.send` is enabled per-tenant **only** after that tenant's domain is DNS-verified and its reputation pool
is isolated (§4 contract).

**Done when.**
- A queued 1:1 send delivers **from the tenant's own DNS-verified domain and isolated Reputation Pool**
  (D2/D3); never through a shared cold pool (D1).
- A repeated **Idempotency-Key** results in exactly **one** send (D5).
- A recipient on `email_suppression` or without consent (`email_consent`) is **never** sent to (D4) — the gate
  is server-side and fail-closed.
- A **signed** delivery/bounce webhook updates the matching `email_send`; an unsigned/forged webhook is
  rejected.
- Cross-tenant isolation itest (extended to `email_send` + reputation/idempotency rows) and the
  webhook-signature test are green.

**Verification recipe.**
- **Cross-tenant isolation itest** (MANDATORY, extended): tenant A cannot see/modify tenant B's
  `email_send`, reputation pool, mailbox, or suppression rows — and cannot send *as* tenant B.
- **DNS-auth check**: send is refused if the resolved `sending_domain` is not SPF/DKIM/DMARC-verified.
- **Send-path e2e (MANDATORY)**: connect a (test) mailbox → verify a domain → queue a 1:1 send → confirm a
  single delivered `email_send` row, on the tenant's own identity; re-fire the same Idempotency-Key → no
  second send; add the recipient to suppression → next send is blocked (D4).
- **Webhook-signature test (MANDATORY)**: a correctly-signed delivery/bounce webhook is accepted and updates
  state; a tampered/unsigned payload is rejected and logged (IDs/actions only).
- Gate: as P0.

---

### P2 — Templates

**Goal.** Reusable, **versioned**, **render-safe** subject+body templates with variables/fallbacks,
owner-scoped and shareable.

**Work units:**
- `db` — `email_template` + `email_template_version` (`09`), owner-scoped (D8), `tenant_id`-leading indexes.
- `core` — the render engine: variable substitution + fallbacks, **no untrusted template eval** (render-safety
  is an injection boundary — `01`).
- `api` — template CRUD + versioning + share endpoints; Zod-validated; ownership-checked (IDOR → 404).
- `web` — the **Templates** tab (`10`), editor with variable insertion + fallback UI, four states.
- `types` — template DTOs/version schema.

**Dependencies.** P0 (schema/RLS). P1 only if "send a test of this template" is offered.

**Feature flags.** `email.templates`.

**Done when.** Author → save → version a template; render with variables + fallbacks; render-safety proven (a
malicious variable cannot inject or execute); templates are owner-scoped and shareable per D8; cross-tenant
itest green.

**Verification recipe.**
- **Cross-tenant isolation itest** (MANDATORY): tenant A cannot read/edit tenant B's templates or versions.
- **Render-safety test**: hostile variable input (script/template-injection payloads) renders inert.
- **Ownership/sharing test**: non-owner without a share cannot read/edit (D8); IDOR → 404.
- Gate: as P0.

---

### P3 — Tracking + Inbox

**Goal.** Full event tracking, a per-contact timeline, reply detection, a unified inbox, and real-time send
status — with opens treated as **informational, not the KPI** (D6).

**Work units:**
- `db` — `email_tracking_event` (`09`).
- `workers` — `apps/workers/src/queues/emailTracking.ts` (the D10 `email_tracking` ingestion queue);
  idempotent at-least-once.
- `core` — reply detection; open-pixel + click-redirect served from the **per-tenant custom tracking domain**
  (D3); event normalization (`04`).
- `api` — event-ingest **signed webhook** + timeline + inbox endpoints; verify signatures; never trust
  client-supplied identifiers; never log PII/bodies (`04`).
- `web` — per-contact **timeline**, **unified inbox**, **real-time status** (`04`, `10`); opens labelled
  informational everywhere (D6); virtualized lists for scale.

**Dependencies.** P1 (a send to track), P2 (templated sends to track).

**Feature flags.** `email.tracking`, `email.inbox`.

**Done when.** Open/click/reply/bounce/complaint/unsubscribe events ingest **idempotently** via **signed**
webhooks; the per-contact timeline and unified inbox render; a reply is detected and threaded; opens are shown
as soft signal, reply rate is the headline (D6); cross-tenant itest + webhook-signature test green.

**Verification recipe.**
- **Cross-tenant isolation itest** (MANDATORY): tenant A cannot read tenant B's tracking events / inbox /
  timeline; a tracking pixel/redirect on tenant A's domain cannot attribute to tenant B.
- **Webhook-signature test** (MANDATORY): forged/replayed event rejected; duplicate event ingested once
  (idempotent).
- **Tracking-domain check**: pixel/redirect resolves on the tenant's own custom domain (D3), not a shared one.
- Gate: as P0.

---

### P4 — Sequences + automation

**Goal.** Multi-step cadences (`email_sequence` → `email_sequence_step`) with scheduling, branching,
**auto-pause-on-reply**, and **throttled enrollment** of People from Lists.

**Work units:**
- `db` — `email_sequence`, `email_sequence_step`, `email_enrollment` (`09`).
- `core` — the cadence engine: step ordering/branching, schedule resolution, auto-pause-on-reply (consumes P3
  reply detection), per-mailbox/pool throttle.
- `workers` — `apps/workers/src/queues/emailSequenceTick.ts` (the D10 `email_sequence_tick` queue) running
  under a **leader lock** (scheduled jobs need a leader lock — `platform`/`operations`); idempotent; backoff +
  DLQ; backpressure.
- `api` — sequence CRUD + enroll/pause/resume endpoints; throttled, idempotent enrollment.
- `web` — the **Sequences** tab (`05`, `10`): cadence builder, step editor, enrollment from a List, four
  states.

**Dependencies.** P3 (reply detection drives auto-pause); P2 (steps reference templates); P1 (the send path
each step uses).

**Feature flags.** `email.sequences`.

**Done when.** Enroll a List into a sequence; steps fire on schedule via the leader-locked tick; a reply
**auto-pauses** the enrollment; enrollment/sends are **throttled** per mailbox/pool; the scheduler fires each
step **once** (leader lock proven); cross-tenant itest green.

**Verification recipe.**
- **Cross-tenant isolation itest** (MANDATORY): tenant A cannot read/enroll into tenant B's sequences;
  enrollment cannot cross tenants/workspaces.
- **Leader-lock test**: two scheduler instances → each step fires exactly once (no duplicate sends).
- **Auto-pause test**: a detected reply (P3) pauses the enrollment before the next step sends.
- **Send-path e2e** (re-run through a sequence step): suppression/idempotency still hold under automation.
- Gate: as P0.

---

### P5 — Deliverability + warmup + analytics

**Goal.** Automate warmup, surface a deliverability dashboard with seed/placement and blacklist monitoring,
and report analytics + leaderboards — **reply rate as the primary KPI** (D6).

**Work units:**
- `workers` — `apps/workers/src/queues/emailWarmup.ts` (the D10 `email_warmup` queue): scheduled warmup ramp
  per mailbox/domain.
- `core` — warmup ramp logic; seed/placement-check hooks; blacklist monitor (`03`); analytics roll-ups (`08`).
- `api` — deliverability + analytics endpoints (cursor-paginated; owner-scoped aggregates only, D8).
- `web` — the **Deliverability** dashboard (auth/placement/blacklist status) and **Analytics** tab +
  leaderboards (`03`, `08`, `10`); virtualized; light theme only.

**Dependencies.** P1 (send path produces the volume to warm/measure); P3 (events feed analytics).

**Feature flags.** `email.warmup`, `email.deliverability`, `email.analytics`.

**Done when.** Warmup **ramps** a new mailbox/domain on a schedule (leader-locked tick); the deliverability
dashboard shows SPF/DKIM/DMARC + placement + blacklist status; analytics report **reply rate as the headline**
with opens as soft signal (D6); leaderboards render; cross-tenant itest green.

**Verification recipe.**
- **Cross-tenant isolation itest** (MANDATORY): tenant A's analytics/leaderboards/deliverability never include
  tenant B's data; aggregates are tenant-scoped at the DB layer.
- **DNS-auth check**: the dashboard accurately reflects a domain's real SPF/DKIM/DMARC + blacklist state.
- **Warmup-ramp test**: volume ramps per schedule; never jumps a cold mailbox to full volume (§4.1).
- Gate: as P0.

---

### P6 — Admin + governance

**Goal.** Give internal staff (`/admin`) the controls to operate the subsystem safely: mailbox/domain
management, infra config, **per-tenant limits/reputation**, **global suppression**, **email-volume billing**,
compliance/audit, and the **DSAR cascade**.

**Work units:**
- `admin/api` — staff mailbox/domain management; per-tenant limits/reputation controls; **global suppression**
  (tenant-wide block); **email-volume billing** meter; all staff actions audited (IDs + actions only).
- `admin/web` — the `/admin` email governance surfaces (`11`, `12`): infra config, per-tenant limits, global
  suppression, billing/volume views.
- `db/test` — the **per-endpoint cross-tenant HTTP isolation itest** (known-gaps track §6) and the
  **DSAR-cascade** itest (erasure tombstones across every email entity + a `global` suppression row prevents
  re-send/re-import).
- audit/compliance wiring (`06`, `12`): customer-visible access log for staff access; break-glass for any
  record-level content access.

**Dependencies.** P1 (infra to govern), P3/P4 (volume to meter/limit), all prior phases for the entities the
DSAR cascade must reach.

**Feature flags.** `email.admin`.

**Done when.** Staff manage domains/mailboxes/limits via `/admin` with every action audited; **global
suppression** blocks sends tenant-wide; **email-volume billing** meters per tenant; a **DSAR erasure cascades**
across all email entities and writes a `global` suppression row; the **per-endpoint cross-tenant HTTP
isolation itest** is green; compliance/audit (`06`) and the roles/permissions matrix (`12`) hold.

**Verification recipe.**
- **Per-endpoint cross-tenant HTTP isolation itest** (MANDATORY — the new control this phase adds): every
  email API/admin endpoint, called with tenant A's session against tenant B's resource IDs, returns 404 / no
  cross-tenant data.
- **DSAR-cascade test** (MANDATORY): a person-level erasure tombstones the contact across all email entities
  (`email_send`, `email_tracking_event`, `email_enrollment`, suppression/consent) and a `global` suppression
  row prevents re-send.
- **Staff-no-access test**: staff see tenant metadata/aggregate only; record-level content requires audited
  break-glass impersonation (`12`).
- Gate: as P0.

---

## 6. Known-gaps remediation track (each assigned to a phase as a mandate)

These are the five carried-forward gaps from the TruePoint constraints digest. Each is a **mandate** in a
named phase, not a wish-list item — the phase's "Done when" is not met until it is addressed.

| # | Known gap | Mandate (phase) | Why there |
|---|---|---|---|
| 1 | **KMS / envelope encryption** not done (app-AES-GCM today). | **P0** — secret storage for mailbox/ESP credentials is built envelope-encryption-ready (KMS target, D7); app-AES-GCM is the interim, with the KMS cutover tracked from P0. | Secrets are live mailbox credentials; a leak is account takeover (`00 §1`, D7) — this is the first secret stored, so the primitive must be right at P0. |
| 2 | **No per-endpoint cross-tenant HTTP isolation test.** | **P6** — the per-endpoint cross-tenant HTTP isolation itest is a P6 "Done when" gate (§5/P6); the DB-layer cross-tenant itest already runs every phase from P0. | P6 is when the full endpoint surface (customer + admin) exists to test exhaustively; the HTTP-layer test complements the per-phase DB-layer test. |
| 3 | **Per-tenant quota gates UNWIRED into metered paths.** | **P1** (wired into the send path before `email.send` is enabled) and **P6** (per-tenant limits/billing UI). | A metered send path without a quota/cap/per-user limit is surprise spend and an abuse vector (`operations`); it must be wired before any tenant sends. |
| 4 | **Residency siloing absent.** | **P0** (schema/storage built residency-aware) and **P6** (staff residency controls); flagged for security/legal review before any production launch with real recipients. | Residency is a storage/tenancy property; retrofitting it after rows exist is expensive — the model must accommodate it from P0. |
| 5 | **Confirm leader-locked scheduler for sequences.** | **P4** — the `email_sequence_tick` worker runs under a leader lock (proven by the P4 leader-lock test); **P5** warmup's scheduled tick inherits the same lock requirement. | Scheduled jobs that fan out sends must fire once; a double-fire is a duplicate send to a real recipient (§5/P4, `platform`/`operations`). |

---

## 7. The mandatory cross-cutting verification controls

Four verification controls are **mandatory and recur across phases** (not one-time). They are restated here so
the contract is unambiguous:

1. **Cross-tenant isolation itest (every phase, P0 onward).** Seed **two tenants**; assert tenant A cannot
   **see or modify** tenant B's email rows or reach them through any endpoint. New entities/endpoints added in
   a phase extend the itest in that phase. This is the structural proof behind D2/D8 and the security mandate;
   it is non-negotiable.
2. **DNS-auth checks — SPF / DKIM / DMARC (P0, P1, P5).** A `sending_domain` is unusable until SPF + DKIM +
   DMARC verify and align (`03`); the send path refuses an unverified domain; the deliverability dashboard
   reflects real state.
3. **Send-path e2e (P1, re-run under P4 automation).** Connect → verify domain → queue send → one delivered
   `email_send` on the tenant's own identity → Idempotency-Key replay sends once (D5) → suppressed recipient
   blocked (D4).
4. **Webhook-signature test (P1 delivery/bounce, P3 events).** A correctly-signed webhook is accepted; a
   forged/unsigned/replayed payload is rejected; events ingest idempotently; no PII/bodies logged.

**Standard gate (every phase, mirroring `list-plan/09 §5`):** `npx turbo run typecheck`, `bun test`,
`npx @biomejs/biome check`, `npm run lint:boundaries`, and regenerate `docs/ARCHITECTURE_MAP.md`. itests
(`packages/db/src/test/*.itest.ts`) run in CI (Docker/Postgres/Redis).

---

## 8. Dependency graph

```
P0 Foundations ──► P1 Reputation isolation + send path ──► P3 Tracking + Inbox ──► P4 Sequences + automation
       │                       │                                  │                         │
       │                       │                                  └─────────────► P5 Deliverability + warmup + analytics
       │                       │                                                            ▲
       │                       └────────────────────────────────────────────────────────-─┘
       │
       └──► P2 Templates ──► (feeds P3 templated sends, P4 sequence steps)
                                  │
P1 / P3 / P4 ─────────────────────────────────────────────► P6 Admin + governance
                                                              (must finish before GA)
```

**Reading the graph (prose):**
- **P0 is the root** — schema, RLS, secret storage, DNS-verified identity. Nothing sends without it.
- **P1 depends only on P0** and is the gate for the whole subsystem (the two unforgiving risks, §4). No later
  phase enables a send for a tenant whose P1 isolation/DNS controls are not proven.
- **P2 (Templates) depends on P0** (schema/RLS) and only on P1 for an optional "send a test"; it can otherwise
  proceed in parallel with P1.
- **P3 (Tracking + Inbox) depends on P1** (a send to track) and **P2** (templated sends to track).
- **P4 (Sequences) depends on P3** (reply detection → auto-pause), **P2** (steps reference templates), and
  **P1** (the underlying send path).
- **P5 (Deliverability + analytics) depends on P1** (volume to warm) and **P3** (events to report).
- **P6 (Admin + governance) depends on P1/P3/P4** for the infra and volume to govern and on **all prior
  phases** for the entities its DSAR cascade must reach. Governance work may *start* after P1 but **must finish
  before GA** — exactly as the List tab's Phase 5 governance gated GA (`list-plan/09 §3`).

---

## 9. Risks & mitigations (beyond the two unforgiving items in §4)

- **Duplicate sends under automation** (P4): the `email_sequence_tick` and `email_warmup` schedulers run under
  a **leader lock**; sends are idempotent (D5); a double-fire never produces a second email to a real
  recipient.
- **Webhook spoofing / replay** (P1/P3): every ingest endpoint **verifies signatures** and ingests
  idempotently; forged payloads are rejected and logged (IDs/actions only) — inputs are attacker-controlled
  (`04`).
- **Surprise send-volume cost / abuse** (P1/P6): per-tenant quota/cap/per-user limits are wired **into** the
  metered send path before `email.send` is enabled (§6 gap #3); global suppression and per-tenant reputation
  limits land in P6.
- **Staff over-reach** (P6): privacy-first staff matrix (`12`) + audited break-glass is the only record-level
  content path; enforced by RLS, not UI (D8, security precedence).
- **Open metric over-trust** (P3/P5): opens are labelled **informational, not KPI** everywhere they appear;
  reply rate is the primary KPI (D6) — Apple MPP broke opens structurally (`04`).
- **Reputation/render regressions across tenants** (all phases): the recurring cross-tenant isolation itest
  (§7) is the structural backstop; no phase merges with it red.

---

> **Closing — this is the execution contract.** The order is P0 → P1 → (P2 ∥ P3 → P4 → P5) → P6, with the two
> unforgiving risks (§4) front-loaded into P0/P1 and proven before any production recipient. Each phase ships
> behind its `email.*` flag, is independently mergeable, carries the mandatory cross-tenant isolation itest,
> and meets the standard gate. For the *what* and *why* of any piece of work, follow the cited sibling doc:
> overview/decisions `00`, templating `01`, sending infrastructure `02`, deliverability `03`,
> status/event tracking `04`, sequences/automation `05`, compliance `06`,
> multitenancy/reputation isolation `07`, reporting/analytics `08`, data model `09`, web surface `10`,
> admin surface `11`, roles/permissions `12`. This doc (`13`) owns the order they ship in.
