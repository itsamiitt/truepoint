# Email Subsystem — Rollout Phases, Work Units & Verification (13)

> **Status:** Plan (not yet built — but **extends a shipped engine**). **Owner:** Platform + Data + Security
> + Architecture. **Last updated:** 2026-06-24.
> This is Doc #13 (the **capstone**) of the `docs/planning/email-planning/` set. It cites the **Locked
> Decisions (D1–D11)**, **Shared Vocabulary**, **Canonical Entities**, and — uniquely — **owns and renders the
> Phase Map (P0–P6)** named in `00-overview.md`. Every other doc in this set references *this* doc for the
> phase a piece of work lands in; this doc references *them* for the detail of what that work is. It mirrors the
> shipped `docs/planning/list-plan/09-rollout-phases.md` in shape and tone: the ordered phases, what each
> delivers, how phases depend on each other, the independently-mergeable work-unit decomposition, the feature
> flags, and the end-to-end verification recipe. **No code** — plain English, entity/queue/endpoint/flag names
> only.
>
> **This is M12 — extend M9, not a greenfield build (D11).** Per the ground-truth doc `14`, TruePoint already
> ships a **suppression-gated outreach send engine** (milestone **M9**, ADR-0009/0013/0004/0007): the Sequence
> / Step / Enrollment model (`outreach_sequences` / `outreach_steps` / `outreach_log`), the CAN-SPAM-gated send
> transaction (`core/outreach/sendStep.ts`), bounce → suppression → credit-back (`core/outreach/handleBounce.ts`),
> the **D4** suppression gate (`suppression_list` + `assertNotSuppressed`), **D9** consent (`consent_records`),
> **D5** idempotency (`idempotency_keys`), the `audit_log`, the `activities` engagement timeline, the
> `/sequences` surface, and the **fully-built** `apps/admin` console. **Every phase below EXTENDS that engine
> through the seams M9 left** — it does **not** rebuild sequences, suppression, consent, idempotency, or the
> send transaction, and it introduces **no** parallel `email_sequence` / `email_sequence_step` /
> `email_enrollment` / `email_suppression` / `email_consent` / `email_idempotency_key` tables (D11, `14 §6`).
> The genuinely new build is small and named in §0.
>
> **This document is the execution contract.** Where it says a control lands in a phase, that control is part
> of that phase's "Done when" and is **not** deferrable to "later". The security-precedence rule applies
> throughout: on any access, tenant-isolation, secret, PII, or compliance point, security wins over
> convenience or sequencing. The scale gates and load-test SLOs in `15` (Part A) are **also** phase "Done when"
> conditions — they are restated against each phase here and cross-referenced to `15` for the design detail.

---

## 0. What already exists vs. what M12 builds (read `14` first)

The single most important framing of this plan: **the spine is already in `main`.** Read `14` (ground truth)
and `15` (scale/extensibility) before this doc — they are authoritative on the real names and seams this
contract uses **verbatim**.

**Already shipped (M9 — reuse, never rebuild):** `outreach_sequences` / `outreach_steps` / `outreach_log`
(Sequence / Step / Enrollment, with `UNIQUE(sequence_id, contact_id)` = enrollment idempotency);
`suppression_list` + `assertNotSuppressed` (the **D4** gate, run in-tx in `sendStep`); `consent_records`
(**D9**); `idempotency_keys` (**D5**); `audit_log` (`send` / `enroll` / `unsubscribe` / `suppression.*`
actions already in the enum); `activities` (engagement timeline with `email_sent`/`email_opened`/`email_clicked`/
`email_replied` already present); `core/outreach/{createSequence,enrollContact,sendStep,handleBounce,senderPort}.ts`;
`creditRepository` (the `SELECT … FOR UPDATE` no-overdraft lock — the **template** for the new send-quota);
`apps/api/src/features/outreach/routes.ts` (`/api/v1/outreach`); `apps/workers/src/queues/outreach.ts`
(`processOutreach` → `sendStep`); the `/sequences` web surface; the **fully-built** `apps/admin` console.

**Genuinely new M12 build (D11, `14 §2.1`) — the only net-new persistence/infrastructure:**

| New thing | What it is | Built on / seam |
|---|---|---|
| **`sending_domain`** | DKIM/SPF/DMARC verification state + per-tenant tracking-CNAME state (D2/D3). | net-new table (`03`, `07`). |
| **`mailbox_integration`** | **Encrypted** ESP/OAuth credentials + provider (D7). | bound behind the existing **`EmailSenderPort`** seam (`02`). |
| **`email_event`** | High-volume, **range-partitioned-by-day** raw tracking-event store that **feeds** `activities` — never replaces it (`04`, `15 §A.2`). | net-new table; projects into `activities` + `outreach_log`. |
| **Per-tenant send-quota counter** | The metered-spend / abuse cap. | copies the **`creditRepository` `SELECT … FOR UPDATE`** discipline — does **not** reinvent a lock (`15 §A.6`). |
| **Warmup + reputation pools** | Pacing/state on top of `sending_domain` + `mailbox_integration` (`03`, `07`). | net-new pacing state; warmup tick under the §A.4 leader lock. |

Everything else this plan names is a **rename of, or an extension to, a table/path that already ships** — read
it through `14 §2`. A reviewer who finds a **new** `email_sequence` / `email_sequence_step` / `email_enrollment`
/ `email_suppression` / `email_consent` / `email_idempotency_key` table in any work unit should treat it as a
**bug against D11**, not a design choice.

---

## 1. Sequencing principles

These five principles decide the order of everything below.

1. **Highest-risk-first, not backend-light-first.** The List tab could afford to be "backend-light first"
   (`list-plan/09 §1`) because its backend already existed and its blast radius was internal. Email is
   different on the *risk* axis even though, like the List tab, **its backend spine already exists** (the M9
   engine, `14 §1`): a bug here is visible to people *outside* the tenant — a double-send, a wrong-merge
   variable, or a missed suppression is an email in a stranger's inbox, not an internal data error. So we
   front-load the two **unforgiving** risks (§4): **deliverability infrastructure** (`02`, `03` — the new
   `sending_domain` + the ESP/mailbox adapter behind `EmailSenderPort`) and **per-tenant sending-reputation
   isolation** (`07`). Both live in **P0/P1**, before a single production recipient is touched by the real
   sender.
2. **Isolation and money rules are never deferred.** The MANDATORY cross-tenant isolation itest (`security`
   constraint) ships in the same phase that introduces each new table or endpoint — starting in **P0** for the
   new `sending_domain` / `mailbox_integration` / `email_event` rows, re-run and extended in every subsequent
   phase, and modelled on the shipped `packages/db/src/test/savedSearches.itest.ts`. **D4** (suppression gates
   *every* send — already enforced in-tx by `assertNotSuppressed` inside `sendStep.ts`) and the **new
   per-tenant send-quota** (`creditRepository` pattern, `15 §A.6`) are wired into the send path in **P1**,
   never bolted on.
3. **Every phase ships behind an `email.*` feature flag, gated per-tenant** (§3) — riding the **shipped**
   Feature flags console (`apps/admin` `/feature-flags`, global + per-tenant overrides, `14 §1.5`). A phase
   merges to main dark, is enabled for internal/seed tenants first, then rolled out per-tenant. The flag is the
   rollback lever; nothing in email is enabled globally on merge.
4. **Each phase is independently mergeable and leaves the product shippable.** Work units mirror the List tab's
   per-module slices (`db` / `db/test` / `types` / `core` / `api` / `web` / `admin` / `workers`), each small
   enough to review and revert in isolation, exactly as Phases 0–5 of the List tab shipped. Most slices
   **extend an existing file** (`outreach/routes.ts`, `queues/outreach.ts`, `features/sequences/`) rather than
   create a new one.
5. **The data path is opened in the right order.** Per the read-first rule, no email data path starts without
   `truepoint-platform` (tenancy/RLS), `truepoint-data` (model/ownership), and `truepoint-security` (access)
   satisfied. A multi-tenant write without an RLS-enforced, ownership-checked path is a bug, not a style choice.

---

## 2. The phase table (the contract at a glance)

This table is the contract; §5 expands each row. "Risk" is the inherent blast radius of getting the phase
wrong, not the effort. The **scale gate** column restates the `15 §A.9` gate that is also part of that phase's
"Done when".

| Phase | Goal (M12 = extend M9) | Work units (independently mergeable) | Depends on | Done when | Scale gate (`15`) | Risk |
|---|---|---|---|---|---|---|
| **P0 — Foundations** | The genuinely-new schema, the isolation proof, KMS-backed secret storage, the DNS-authenticated `sending_domain`, the per-tenant send-quota wiring, and the raw `email_event` store every later phase needs — **without** rebuilding sequences/suppression/consent (they ship, `14 §1`). | `db` `sending_domain` + `mailbox_integration` + partitioned `email_event` + the send-quota counter columns; `db` `rls/email.sql` ENABLE+FORCE on the new tables; `db/test` cross-tenant isolation itest over the new rows; `types` DTOs; `core/email` KMS envelope-encryption secret store + DNS-auth verifier + send-quota repo (creditRepository pattern); `api` extend `outreach/routes.ts` with mailbox-connect (OAuth) + sending-domain routes; `web` `/settings/mailboxes` connect stub + nav entry. | — (root) | New migrations apply; RLS ENABLE+FORCE on the **new** tables proven by the two-tenant itest; a mailbox connects via OAuth with the credential **KMS-envelope-encrypted** server-side; a `sending_domain` reaches **DNS-verified** (SPF+DKIM+DMARC) before it is usable; the send-quota counter exists with the `FOR UPDATE` no-overdraft `CHECK`; `email_event` is **range-partitioned by day**. (Suppression/consent already exist — `14 §1.1` — not rebuilt.) | `email_event` partitioned by day from the day it ships (`15 §A.2`); send-quota uses the `creditRepository` FOR-UPDATE pattern, not a hot row (`15 §A.6`). | **Highest** — secrets are live mailbox credentials and **KMS is the first secret store** (D7, known-gap #1); DNS auth is a hard Gmail/Yahoo gate (`03`). |
| **P1 — Reputation isolation + real send path** | **Swap `consoleSender` → the real ESP/mailbox adapter** behind `EmailSenderPort` (no change to `sendStep.ts`), on a per-tenant isolated reputation, with delivery/bounce webhooks **extending `handleBounce`** and the send-quota enforced. | `db` reputation-pool columns + send-quota finalize; `core/email` the `ProviderAdapter`/SES adapter behind `EmailSenderPort` + per-tenant `sending_domain`/pool/tracking-domain resolution + send-quota decrement (the D4/D5 gates are **reused**, not rebuilt); `workers` extend `queues/outreach.ts` + new delivery/bounce ingestion that feeds `handleBounce`; `api` signed delivery/bounce webhook + Idempotency-Key send; `web` `/settings/mailboxes` + reuse `/settings/compliance`. | P0 | `sendStep.ts` sends via the **real adapter** from the tenant's own DNS-verified domain/pool (D1/D2/D3); a duplicate Idempotency-Key sends **once** via the existing `idempotency_keys` (D5); a suppressed/consent-blocked recipient is **never** sent to via the unchanged in-tx `assertNotSuppressed` (D4); a signed delivery/bounce webhook drives `handleBounce` (bounce → `suppression_list` row → ADR-0013 credit-back); the new send-quota blocks an over-cap tenant; cross-tenant itest + webhook-signature test green. | Per-mailbox throttle is **Redis + queue-local** (`15 §A.1`), never a hot DB row; send-quota wired before `email.send` (known-gap #3, `15 §A.6`). | **Highest** — reputation isolation (D2) is unforgiving; one tenant must never damage another's deliverability; this is the real-sender cutover. |
| **P2 — Templates (externalize the inline body)** | Reusable, versioned, render-safe templates — **externalizing what is today inline in `outreach_steps.subject`/`body`** and **wiring the shipped Templates panel STUB**. | `db` `email_template` + `email_template_version` (slots into the step model, `14 §2`); `core/email` render engine (variables + fallbacks, no untrusted eval); `api` template CRUD on `/api/v1/templates` (the path the STUB already targets); `web` flip the `features/sequences` Templates panel from `MaybeList available:false` to live; `types` template DTOs. | P0 (P1 for "send a test") | A step's content can reference a versioned `email_template` instead of inline body; author → version → render with variables/fallbacks; render-safety proven (no template injection); owner-scoped + shareable (D8); the Templates panel STUB renders live; cross-tenant itest green. | n/a (template CRUD is low-volume). | Medium — render-safety is an injection surface; ownership is D8. |
| **P3 — Full tracking + Inbox + timeline** | Full event tracking — **`email_event` → `activities`** projection — wiring the **`/inbox`** mailbox-sync backend and the **per-contact timeline**, opens **informational, not KPI** (D6). | `db` finalize partitioned `email_event`; `workers` new tracking-ingestion queue projecting `email_event` → `activities` + `outreach_log` status; `core/email` reply-detection + open/click on the **per-tenant tracking domain** (D3); `api` signed event webhook + wire `/inbox` (`fetchThreads`/`sendReply`/`fetchTasks`) + timeline; `web` flip `/inbox` off 404/501 + per-contact timeline reads `activities`. | P1 (a real send to track), P2 (templated sends to track) | Open/click/reply/bounce/complaint/unsubscribe land in `email_event` (signed, idempotent) and **project into `activities`**; the per-contact timeline + `/inbox` render off real data; reply detected and threaded; opens labelled informational (D6); cross-tenant itest + webhook-signature test green. | `email_event` < **1M events/day**, edge fast `2xx` / `503`+`Retry-After` under load (`15 §A.2/§A.5`); suppression-check Redis cache (`15 §A.7`). | Medium-high — inputs are attacker-controlled (`04`); the tracking domain must stay per-tenant (D3); the firehose must not bloat `activities`. |
| **P4 — Sequence automation hardening + leader-locked scheduler** | Harden the **existing** cadence engine: auto-pause-on-reply, throttled enrollment, and the **leader-locked `email_sequence_tick` scheduler** (from `15 §A.4`) over `outreach_log`. | `core/email` auto-pause (consumes P3 reply detection) + per-mailbox/pool throttle on the **existing** `enrollContact`/`sendStep` paths; `workers` `email_sequence_tick` queue under a **leader lock** with `FOR UPDATE SKIP LOCKED` batch cap, extending `queues/outreach.ts`; `api` enroll/pause/resume on the **existing** `/api/v1/outreach` routes; `web` extend the built `SequenceBuilder`/`EnrollmentPanel`. | P3 (reply detection drives auto-pause) | Steps fire on schedule via the **leader-locked** tick over `outreach_log`; a reply auto-pauses the enrollment; enrollment/sends are throttled per mailbox/pool; the scheduler fires each due step **exactly once** (two-worker no-double-advance itest); the reused D4/D5 gates still hold under automation; cross-tenant itest green. | `email_sequence_tick` leader-locked + `FOR UPDATE SKIP LOCKED` batch cap + **two-worker no-double-advance itest** (`15 §A.4`, known-gap #5); email queues concurrency-capped + per-tenant-fair (`15 §A.8`). | High — automation multiplies send volume; a scheduler bug fans out duplicate sends across tenants. |
| **P5 — Deliverability + warmup + analytics** | Warmup automation, the deliverability dashboard, blacklist/placement monitoring, and analytics — **wiring the `/reports` "Sending & deliverability" placeholder** — reply rate the primary KPI (D6). | `workers` `email_warmup` queue (warmup ramp, leader-locked tick); `core/email` warmup ramp + seed/placement hooks + blacklist monitor + analytics rollups over partitioned `email_event`; `api` deliverability + analytics routes (owner-scoped aggregates, D8); `web` flip the `/reports` deliverability tab + analytics + leaderboards off the "Connect sending" `EmptyState`. | P1 (send path produces volume), P3 (`email_event` feeds analytics) | Warmup ramps a new mailbox/domain on a schedule (leader-locked); the deliverability dashboard shows SPF/DKIM/DMARC + placement + blacklist; analytics read **partitioned hour/day rollups** (never the firehose) with **reply rate the headline** (D6); the `/reports` placeholder is live; cross-tenant itest green. | Analytics read **partitioned rollups**, never `email_event` live (`15 §A.3`); retention is automated partition `DROP` (`15 §A.2`); the **P5 10M-events/day load-test SLO** passes (`15 §A.9`). | Medium — warmup mis-pacing harms reputation; analytics must not leak cross-tenant aggregates. |
| **P6 — Admin + governance + retention sweep** | Internal control mapped to the **real, fully-built `apps/admin`**: per-tenant limits/reputation on `/tenants`, the `ProviderAdapter` registry on `/provider-configs`, global suppression, email-volume billing, the DSAR cascade, and the retention/idempotency sweep. | `apps/admin` extend `/tenants` (per-tenant limits/reputation), `/provider-configs` (adapter registry), `/feature-flags` (`email.*`), `/system-health` (email queue/ingestion SLOs); `admin/api` global `suppression_list` row + email-volume billing meter; `workers` retention sweep (partition `DROP` + `idempotency_keys` expiry sweep, leader-locked); `db/test` **per-endpoint cross-tenant HTTP isolation** + DSAR-cascade itests. | P1 (infra to govern), P3/P4 (volume to bill/limit), all prior phases for the DSAR cascade's entities | Staff manage domains/mailboxes/limits via the **existing** `apps/admin` consoles with every action audited; a `global`-scope `suppression_list` row blocks sends tenant-wide; email-volume billing meters per tenant; a **DSAR erasure cascades** across `outreach_log` / `email_event` / `activities` / suppression/consent and writes a `global` suppression row; retention sweep drops cold `email_event` partitions and expires `idempotency_keys`; **per-endpoint cross-tenant HTTP isolation itest** green; compliance/audit (`06`) and roles (`12`) hold. | Retention drop + `idempotency_keys` expiry sweep are leader-locked + batched (`15 §A.2/§A.8`); email queues never starve enrichment/imports/DSAR (`15 §A.8`). | High — staff over-reach and DSAR misses are compliance failures (`06`, `12`). |

---

## 3. Feature flags (`email.*`, gated per-tenant on the shipped console)

Email rides the **shipped** Feature flags console (`apps/admin` `/feature-flags` — global + per-tenant
overrides, `14 §1.5`), under the `email.*` namespace. Every phase merges dark behind its flag; flags are
enabled seed-tenants-first, then rolled out per-tenant; the flag is the rollback lever.

| Flag | Gates | Introduced |
|---|---|---|
| `email.foundations` | New-schema/admin scaffolding visibility (internal only). | P0 |
| `email.mailboxes` | `mailbox_integration` connect (OAuth) + `/settings/mailboxes` surface. | P0/P1 |
| `email.domains` | `sending_domain` DNS-auth setup + verification. | P0/P1 |
| `email.send` | The real send path (the `consoleSender` → ESP/mailbox-adapter swap; gated tenant-by-tenant **only** after DNS auth + reputation isolation + send-quota wiring are proven). | P1 |
| `email.suppression` | Suppression + consent surfaces (the **already-built** `/settings/compliance`) and the D4 gate UI. | P1 |
| `email.templates` | Templates tab (the STUB flip) + CRUD/versioning. | P2 |
| `email.tracking` | `email_event` tracking → `activities`, timeline, real-time status. | P3 |
| `email.inbox` | `/inbox` mailbox-sync (the 404/501 → live flip) + reply detection. | P3 |
| `email.sequences` | Sequence automation + leader-locked scheduler + enrollment hardening. | P4 |
| `email.warmup` | Warmup automation. | P5 |
| `email.deliverability` | Deliverability dashboard + blacklist/placement (the `/reports` placeholder flip). | P5 |
| `email.analytics` | Analytics tab + leaderboards. | P5 |
| `email.admin` | `apps/admin` governance: per-tenant limits/reputation, global suppression, billing. | P6 |

**Flag discipline (mandate):** `email.send`, `email.sequences`, and `email.warmup` are **send-volume** flags
— they are never enabled for a tenant whose `sending_domain` is not DNS-verified (`03`) and whose reputation
pool is not isolated (`07`). Wiring the per-tenant **send-quota** (the new `creditRepository`-pattern counter,
`15 §A.6`) *into* the metered send path is a precondition of enabling `email.send` (known-gaps track, §6,
gap #3).

---

## 4. Highest-risk-first callout — the two unforgiving items

Two items in this set are categorically different from the rest: getting them wrong is **not recoverable by a
patch**, because the damage lands outside TruePoint's control (in mailbox-provider reputation systems and in
strangers' inboxes) and is shared across tenants. Both are **front-loaded into P0/P1**, before the real sender
reaches any production recipient. Everything else in the plan is sequenced *around* protecting these two.

### 4.1 (a) Deliverability infrastructure — `sending_domain`, DNS auth, the ESP/mailbox adapter, warmup (docs `02`, `03`)

**Why it is unforgiving.** Deliverability reputation is built slowly and destroyed instantly, and it is held
by *external* systems (Gmail, Yahoo, Outlook, blocklist operators) that TruePoint cannot reset. As of February
2024, Gmail and Yahoo make **SPF + DKIM + DMARC a hard requirement** for bulk senders, not an optimization —
and require the `From:` domain to **align** with the passing SPF or DKIM identifier (`03 §1`). A single
shared-infrastructure mistake — a shared tracking domain, an unauthenticated `sending_domain`, an unhandled
bounce, a cold mailbox sending at full volume without warmup — can blacklist a domain (or every tenant at once
if infrastructure is shared) for weeks. There is no rollback for a poisoned domain reputation; you start over
on a new domain.

**How it is front-loaded.** P0 establishes the authentication stack **per `sending_domain`** (the new table,
`14 §2.1`) and makes a domain unusable for any send until DNS auth is **verified** (`03 §1`); the KMS-backed
secret store for live `mailbox_integration` credentials lands the same phase (D7, known-gap #1). P1 puts the
real send through that verification: it **swaps `consoleSender` → the ESP/mailbox `ProviderAdapter` behind
`EmailSenderPort`** without touching the `sendStep.ts` transaction (D11, `15 §B.2`), and behind D1's hybrid
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
tenant) exist precisely to prevent this — and they are only protective if enforced *before* the first real
send, because reputation, once pooled, cannot be un-pooled.

**How it is front-loaded.** P1 is named "**Reputation isolation + real send path**" — the isolation is not a
layer on top of sending; it *is* the send path's foundation. Every real send in P1 resolves a **per-tenant**
`sending_domain` and Reputation Pool (D2) and a **per-tenant** custom tracking domain (D3); there is no code
path that routes a tenant's cold sequence through a shared TruePoint-owned pool. The cross-tenant isolation
itest (§7) proves at the database layer that tenant A cannot read or write tenant B's `mailbox_integration`,
`sending_domain`, reputation-pool, `email_event`, or `suppression_list` rows — the structural guarantee behind
D2/D3.

> **Contract:** P1 does not ship — `email.send` is not enabled for any tenant — until both 4.1 and 4.2 are
> proven by the P0/P1 verification recipe (§7) **and** the send-quota is wired (§6 gap #3). These are the
> gating items for the entire subsystem.

---

## 5. The phases in depth (P0 → P6)

### P0 — Foundations

**Goal.** Lay the **genuinely-new** schema (D11, `14 §2.1`), the proof of tenant isolation over it, the
KMS-backed secret-storage primitive, the DNS-authenticated `sending_domain`, the per-tenant send-quota wiring,
and the raw `email_event` store that *every* later phase depends on. **It does not rebuild
sequences/suppression/consent — those already ship** (`14 §1.1`). Nothing user-visible sends yet.

**Work units (independently mergeable):**
- `db` — `packages/db/src/schema/email.ts`: the **net-new** entities (D11) — `sending_domain` (DKIM/SPF/DMARC
  + per-tenant tracking-CNAME state), `mailbox_integration` (encrypted credentials + provider), the
  **range-partitioned-by-day** `email_event` raw store (`15 §A.2`), and the per-tenant **send-quota** counter
  columns. `tenant_id` always; `workspace_id` where workspace-scoped; `owner_user_id` where user-owned (D8);
  `tenant_id`-leading indexes. **No new** `email_sequence`/`email_suppression`/`email_consent`/
  `email_idempotency_key` tables — those are the shipped `outreach_*` / `suppression_list` / `consent_records`
  / `idempotency_keys` (`14 §2`).
- `db` — `packages/db/src/rls/email.sql`: RLS **ENABLE + FORCE**, fail-closed `NULLIF` tenant predicate on
  every **new** email table, mirroring the contacts/lists/outreach RLS shape.
- `db` — extend `packages/db/src/repositories/`: a tenant-scoped repository for the new tables (no raw
  cross-tenant queries), and the **send-quota repo built on the `creditRepository` `SELECT … FOR UPDATE`
  no-overdraft pattern** (`15 §A.6`, D11) — it copies the discipline, it does not invent a lock.
- `db/test` — `packages/db/src/test/email.isolation.itest.ts`: the **MANDATORY cross-tenant isolation itest**
  (modelled on the shipped `savedSearches.itest.ts` / `list-plan/09`): seed **two tenants**, assert tenant A
  cannot read/write/modify tenant B's `sending_domain` / `mailbox_integration` / `email_event` / send-quota
  rows.
- `types` — `@leadwolf/types`: Zod DTOs for mailbox connect, sending-domain, and the send-quota.
- `core` — `packages/core/src/email/`: the **KMS envelope-encryption** secret store (D7 — this is the **first**
  live secret stored, known-gap #1; KMS is the build target, not app-AES-GCM-and-defer) and the DNS-auth
  verifier (resolves and checks SPF/DKIM/DMARC for a `sending_domain`).
- `api` — **extend** `apps/api/src/features/outreach/routes.ts` (or a sibling `features/email/`) under
  `/api/v1`: mailbox-connect (Google/Microsoft **OAuth**) and sending-domain create/verify endpoints;
  Zod-validated; RFC 9457 errors; IDOR → 404.
- `web` — `apps/web/src/features/email/` (the new `/settings/mailboxes` feature, `14 §1.4/§4`): a minimal
  connect entry behind `email.foundations`; **vanilla React + `fetchWithAuth` + `MaybeList` + `StateSwitch`**,
  copying `features/sequences/{api.ts, hooks/useSequences.ts, types.ts}` (`14 §3` — **no TanStack/`useQuery`/
  query-keys**). Add the **one** `navConfig` Mailboxes entry to the Workspace scope (`14 §4`).

**Dependencies.** None — P0 is the root.

**Feature flags.** `email.foundations` (internal only), `email.mailboxes`, `email.domains`.

**Done when.**
- New migrations apply cleanly; RLS is ENABLE+FORCE on every **new** email table and proven by the two-tenant
  itest. (Suppression/consent RLS already ship — `14 §1.1`.)
- A `mailbox_integration` connects via OAuth and its credential is **KMS-envelope-encrypted** server-side (D7)
  — never on the client, never in logs.
- A `sending_domain` can be created and only reaches **DNS-verified** when SPF + DKIM + DMARC actually pass
  (`03`); an unverified domain is unusable for any send.
- `email_event` is **range-partitioned by day** with day partitions pre-created ahead of ingestion
  (`15 §A.2`).
- The per-tenant send-quota counter exists with the `FOR UPDATE` no-overdraft `CHECK` (`15 §A.6`), ready to
  wire into the P1 send path.

**Verification recipe.**
- **Cross-tenant isolation itest** (MANDATORY): two tenants seeded; every new P0 entity proven non-crossable.
- **DNS-auth checks**: a domain with valid SPF/DKIM/DMARC verifies; one missing any record stays unverified.
- **Secret-storage test**: a stored credential round-trips via the KMS envelope primitive; plaintext never
  appears in logs or API responses.
- **Partition test**: `email_event` writes land in the correct day partition; pre-creation works.
- Gate: `npx turbo run typecheck`, `bun test`, `npx @biomejs/biome check`, `npm run lint:boundaries`,
  regenerate `docs/ARCHITECTURE_MAP.md`.

---

### P1 — Reputation isolation + real send path

**Goal.** **Swap `consoleSender` → the real ESP/mailbox `ProviderAdapter` behind `EmailSenderPort`** — sending
one real 1:1 email through the **unchanged `core/outreach/sendStep.ts` transaction**, on a **per-tenant**
sending identity, **idempotently** (the shipped `idempotency_keys`, D5), **suppression- and consent-gated**
(the unchanged in-tx `assertNotSuppressed`, D4), with the new send-quota enforced and delivery/bounce
**extending `handleBounce`** over a **signed** webhook. This phase ships the two unforgiving risks (§4) and is
the gate for the whole subsystem.

**Work units:**
- `db` — Reputation Pool + per-tenant tracking-domain columns/links on `sending_domain`/`mailbox_integration`;
  finalize the send-quota counter. (The send/idempotency state already lives on `outreach_log` +
  `idempotency_keys` — `14 §2` — not rebuilt.)
- `core` — `packages/core/src/email/`: the **`ProviderAdapter` (SES, D1 default) bound behind the existing
  `EmailSenderPort`** (`15 §B.2`); per-tenant `sending_domain` + Reputation Pool (D2) + custom tracking domain
  (D3) + credential/provider resolution per D1's hybrid table; the **send-quota decrement** (creditRepository
  pattern, `15 §A.6`). **The D4 suppression gate, D5 idempotency, CAN-SPAM footer append, and `outreach_log`
  advance in `sendStep.ts` are REUSED unchanged** (D11) — the adapter is the only new code in the send path.
- `workers` — **extend** `apps/workers/src/queues/outreach.ts` (`processOutreach` → `sendStep`) for the real
  adapter, plus a new **delivery/bounce ingestion** queue that drives `handleBounce` (bounce →
  `suppression_list` row → ADR-0013 credit-back); idempotent, at-least-once, backoff + DLQ; workers **set
  tenant context per job** (D10). The **per-mailbox throttle is Redis + queue-local** (`15 §A.1`), never a hot
  DB row.
- `api` — **extend** `outreach/routes.ts`: send endpoint (Idempotency-Key required, D5) and the **signed**
  delivery/bounce **webhook** endpoint; signatures verified; no PII in logs; the edge enqueues and returns fast
  `2xx` / `503`+`Retry-After` under load (`15 §A.5`).
- `web` — wire `/settings/mailboxes` and **reuse** the **fully-built** `/settings/compliance` Suppression
  surface (`14 §1.4`); four states, `@leadwolf/ui`, `var(--tp-*)`, WCAG 2.2 AA; vanilla React (`14 §3`).

**Dependencies.** P0 (new schema, RLS, KMS secret store, DNS-verified domain, send-quota counter).

**Feature flags.** `email.send`, `email.suppression` (plus P0's `email.mailboxes` / `email.domains`).
`email.send` is enabled per-tenant **only** after that tenant's domain is DNS-verified, its reputation pool is
isolated, and the send-quota is wired (§4 contract, §6 gap #3).

**Done when.**
- `sendStep.ts` sends via the **real adapter** **from the tenant's own DNS-verified domain and isolated
  Reputation Pool** (D2/D3); never through a shared cold pool (D1).
- A repeated **Idempotency-Key** results in exactly **one** send via the shipped `idempotency_keys` (D5).
- A recipient on `suppression_list` or without consent (`consent_records`) is **never** sent to via the
  unchanged in-tx `assertNotSuppressed` (D4) — fail-closed, server-side.
- The new **send-quota** blocks an over-cap tenant under the `FOR UPDATE` no-overdraft lock (`15 §A.6`).
- A **signed** delivery/bounce webhook drives `handleBounce`; an unsigned/forged webhook is rejected.
- Cross-tenant isolation itest (extended to `email_event` + reputation/send-quota rows) and the
  webhook-signature test are green.

**Verification recipe.**
- **Cross-tenant isolation itest** (MANDATORY, extended): tenant A cannot see/modify tenant B's `email_event`,
  reputation pool, `mailbox_integration`, send-quota, or `suppression_list` rows — and cannot send *as*
  tenant B.
- **DNS-auth check**: send is refused if the resolved `sending_domain` is not SPF/DKIM/DMARC-verified.
- **Send-path e2e (MANDATORY)**: connect a (test) mailbox → verify a domain → queue a 1:1 send → confirm a
  single delivered message advancing one `outreach_log` row, on the tenant's own identity; re-fire the same
  Idempotency-Key → no second send; add the recipient to `suppression_list` → next send is blocked (D4);
  exceed the quota → send refused (`15 §A.6`).
- **Webhook-signature test (MANDATORY)**: a correctly-signed delivery/bounce webhook is accepted and drives
  `handleBounce`; a tampered/unsigned payload is rejected and logged (IDs/actions only).
- **Throttle test**: per-mailbox rate is enforced via Redis + queue-local lease, with **no** single-row DB
  lock on the hot path (`15 §A.1`).
- Gate: as P0.

---

### P2 — Templates (externalize the inline body)

**Goal.** Reusable, **versioned**, **render-safe** subject+body templates with variables/fallbacks,
owner-scoped and shareable — **externalizing the content today inline in `outreach_steps.subject`/`body`** and
**wiring the shipped Templates panel STUB** (`features/sequences`, `fetchTemplates -> MaybeList
available:false`, `14 §1.4`).

**Work units:**
- `db` — `email_template` + `email_template_version` (`01`, `09`) — these are **genuinely new** but **slot
  into the existing step model** (`14 §2`); owner-scoped (D8), `tenant_id`-leading indexes.
- `core` — the render engine: variable substitution + fallbacks, **no untrusted template eval** (render-safety
  is an injection boundary — `01`).
- `api` — template CRUD + versioning + share endpoints on **`/api/v1/templates`** (the path the STUB already
  targets, `14 §1.4`); Zod-validated; ownership-checked (IDOR → 404).
- `web` — flip the **Templates** panel STUB from `available:false` to live (`10`); editor with variable
  insertion + fallback UI, four states; vanilla React (`14 §3`).
- `types` — template DTOs/version schema (extend the shipped `TemplateSummary { id, name, channel, subject,
  body, updatedAt }`).

**Dependencies.** P0 (new-schema/RLS). P1 only if "send a test of this template" is offered.

**Feature flags.** `email.templates`.

**Done when.** A step can reference a versioned `email_template` rather than an inline body; author → save →
version → render with variables + fallbacks; render-safety proven (a malicious variable cannot inject or
execute); templates are owner-scoped and shareable per D8; the Templates panel STUB renders live; cross-tenant
itest green.

**Verification recipe.**
- **Cross-tenant isolation itest** (MANDATORY): tenant A cannot read/edit tenant B's templates or versions.
- **Render-safety test**: hostile variable input (script/template-injection payloads) renders inert.
- **Ownership/sharing test**: non-owner without a share cannot read/edit (D8); IDOR → 404.
- **STUB-flip test**: the Templates panel's `MaybeList.available` flips to `true` once `/api/v1/templates`
  responds.
- Gate: as P0.

---

### P3 — Full tracking + Inbox + per-contact timeline

**Goal.** Full event tracking — the **`email_event` → `activities`** projection — wiring the **`/inbox`**
mailbox-sync backend (off its 404/501 stubs) and the **per-contact timeline** off `activities`, with opens
treated as **informational, not the KPI** (D6).

**Work units:**
- `db` — finalize the **range-partitioned-by-day** `email_event` (`15 §A.2`).
- `workers` — a new tracking-ingestion queue that **projects `email_event` → `activities`** (`email_sent` /
  `email_opened` / `email_clicked` / `email_replied`, already in `activities.activity_type` — `14 §1.1`) and
  drives `outreach_log` status transitions; idempotent at-least-once on the provider event id (`15 §A.2`).
- `core` — reply detection; open-pixel + click-redirect served from the **per-tenant custom tracking domain**
  (D3); event normalization (`04`); **suppression-check Redis cache** in front of the unchanged in-tx D4 gate
  (`15 §A.7`).
- `api` — event-ingest **signed webhook** (fast `2xx` / `503`+`Retry-After` under load, `15 §A.5`) + **wire
  `/inbox`** (`fetchThreads` / `sendReply` / `fetchTasks` — `14 §1.4`) + timeline endpoints; verify signatures;
  never trust client-supplied identifiers; never log PII/bodies (`04`).
- `web` — flip **`/inbox`** off 404/501 to live (`InboxThread` / `InboxTask` contracts already defined,
  `14 §1.4`); the **per-contact timeline** reads `activities`; **real-time status** (`04`, `10`); opens
  labelled informational everywhere (D6); virtualized lists for scale; vanilla React (`14 §3`).

**Dependencies.** P1 (a real send to track), P2 (templated sends to track).

**Feature flags.** `email.tracking`, `email.inbox`.

**Done when.** Open/click/reply/bounce/complaint/unsubscribe land in **`email_event`** (signed, idempotent) and
**project into `activities`**; the per-contact timeline and `/inbox` render off real data; a reply is detected
and threaded; opens are shown as soft signal, reply rate is the headline (D6); cross-tenant itest +
webhook-signature test green.

**Verification recipe.**
- **Cross-tenant isolation itest** (MANDATORY): tenant A cannot read tenant B's `email_event` / `/inbox` /
  timeline; a tracking pixel/redirect on tenant A's domain cannot attribute to tenant B.
- **Webhook-signature test** (MANDATORY): forged/replayed event rejected; duplicate event ingested once
  (idempotent on the provider event id).
- **Projection test**: a delivered `email_event` projects into the right `activities` row and `outreach_log`
  status; the product timeline reads `activities`, **never** the raw firehose (`15 §A.2`).
- **Tracking-domain check**: pixel/redirect resolves on the tenant's own custom domain (D3), not a shared one.
- **Backpressure test**: under an event storm the edge returns `503`+`Retry-After` and the ESP retries; no
  dropped events (`15 §A.5`).
- Gate: as P0.

---

### P4 — Sequence automation hardening + leader-locked scheduler

**Goal.** Harden the **existing** cadence model (`outreach_sequences` → `outreach_steps`, advancing
`outreach_log`) with scheduling, **auto-pause-on-reply**, and **throttled enrollment** of People from Lists —
all under the **leader-locked `email_sequence_tick` scheduler** specified in `15 §A.4`. **The
sequence/step/enrollment model is REUSED, not rebuilt** (D11, `14 §2`).

**Work units:**
- `core` — the cadence-engine hardening on the **existing** `enrollContact`/`sendStep` paths: step
  ordering/schedule resolution, auto-pause-on-reply (consumes P3 reply detection), per-mailbox/pool throttle.
- `workers` — **extend** `apps/workers/src/queues/outreach.ts` into the D10 `email_sequence_tick` queue: it
  scans `outreach_log` for due steps under a **leader lock** (Redis leader election **or** a BullMQ repeatable
  job with a stable `jobId`), claims a **bounded batch** via `SELECT … FOR UPDATE SKIP LOCKED LIMIT {cap}`,
  advances `current_step` / `last_event_at` transactionally, and carries an Idempotency-Key into the send path
  (`15 §A.4`); idempotent; backoff + DLQ; backpressure; concurrency-capped + per-tenant-fair (`15 §A.8`).
- `api` — enroll/pause/resume on the **existing** `/api/v1/outreach` routes (`14 §1.3`); throttled, idempotent
  enrollment (the `UNIQUE(sequence_id, contact_id)` constraint is the existing idempotency).
- `web` — extend the **fully-built** `features/sequences` (`SequenceBuilder`, `EnrollmentPanel`,
  `EnrollmentLogTable`, `SendStatusDashboard`, `05`, `10`): enrollment from a List, four states; vanilla React.

**Dependencies.** P3 (reply detection drives auto-pause); P2 (steps reference templates); P1 (the real send
path each step uses).

**Feature flags.** `email.sequences`.

**Done when.** Enroll a List into a sequence; steps fire on schedule via the **leader-locked** tick over
`outreach_log`; a reply **auto-pauses** the enrollment; enrollment/sends are **throttled** per mailbox/pool;
the scheduler fires each due step **exactly once** (two-worker no-double-advance itest); the reused D4/D5 gates
hold under automation; cross-tenant itest green.

**Verification recipe.**
- **Cross-tenant isolation itest** (MANDATORY): tenant A cannot read/enroll into tenant B's
  `outreach_sequences`; enrollment cannot cross tenants/workspaces.
- **Two-worker no-double-advance itest** (MANDATORY, `15 §A.4`, known-gap #5): two `email_sequence_tick`
  instances → each due step advances `outreach_log` **exactly once** and produces **exactly one** send.
- **Auto-pause test**: a detected reply (P3) pauses the enrollment before the next step sends.
- **Send-path e2e** (re-run through a sequence step): the reused D4 suppression / D5 idempotency still hold
  under automation.
- **Queue-isolation test**: an email sequence fan-out does not starve enrichment/imports/DSAR queues
  (`15 §A.8`).
- Gate: as P0.

---

### P5 — Deliverability + warmup + analytics

**Goal.** Automate warmup, surface a deliverability dashboard with seed/placement and blacklist monitoring, and
report analytics + leaderboards — **wiring the `/reports` "Sending & deliverability" placeholder** off its
"Connect sending" `EmptyState` (`14 §1.4`) — with **reply rate as the primary KPI** (D6).

**Work units:**
- `workers` — `apps/workers/src/queues/emailWarmup.ts` (the D10 `email_warmup` queue): scheduled warmup ramp
  per mailbox/domain, under the same **leader lock** as the scheduler (`15 §A.4`).
- `core` — warmup ramp logic; seed/placement-check hooks; blacklist monitor (`03`); **analytics rollups
  range-partitioned by hour/day** over `email_event` — **never** live-aggregated over the firehose (`15 §A.3`,
  `08`).
- `api` — deliverability + analytics endpoints (cursor-paginated; **owner-scoped aggregates only**, D8) reading
  the rollups, not the raw store.
- `web` — flip the **`/reports` deliverability tab** (auth/placement/blacklist status) and the **Analytics**
  tab + leaderboards off the placeholder (`03`, `08`, `10`); virtualized; light theme only; vanilla React.

**Dependencies.** P1 (real send path produces the volume to warm/measure); P3 (`email_event` feeds analytics).

**Feature flags.** `email.warmup`, `email.deliverability`, `email.analytics`.

**Done when.** Warmup **ramps** a new mailbox/domain on a schedule (leader-locked tick); the deliverability
dashboard shows SPF/DKIM/DMARC + placement + blacklist status; analytics read **partitioned hour/day rollups**
(never the firehose) with **reply rate as the headline** and opens as soft signal (D6); leaderboards render;
the `/reports` placeholder is live; cross-tenant itest green; **the P5 load-test SLO passes** (below).

**Verification recipe.**
- **Cross-tenant isolation itest** (MANDATORY): tenant A's analytics/leaderboards/deliverability never include
  tenant B's data; rollups are `tenant_id`-leading and workspace-scoped at the DB layer (`15 §A.3`).
- **DNS-auth check**: the dashboard accurately reflects a domain's real SPF/DKIM/DMARC + blacklist state.
- **Warmup-ramp test**: volume ramps per schedule; never jumps a cold mailbox to full volume (§4.1).
- **Rollup test**: dashboards read partitioned rollups, **never** `COUNT(*)` over raw `email_event`
  (`15 §A.3`); rollups are idempotently rebuildable from retained partitions.
- **P5 load-test SLO (MANDATORY scale gate, `15 §A.9`)**: sustain **10M `email_event` rows/day** with **no
  hot-row contention** (the only FOR-UPDATE lock under load is the low-frequency send-quota), **no ingestion
  backlog** (shed to `503`+`Retry-After`, never back up unboundedly), partition health (day partitions
  pre-created, retention drop bounded), and **no cross-subsystem starvation** of enrichment/imports/DSAR.
  Measured/monitored per doc `14`'s SLO/observability.
- Gate: as P0.

---

### P6 — Admin + governance + retention sweep

**Goal.** Give internal staff the controls to operate the subsystem safely — **mapped onto the real,
fully-built `apps/admin` consoles** (`14 §1.5`), not a new admin app: per-tenant limits/reputation on
`/tenants`, the `ProviderAdapter` registry on `/provider-configs`, `email.*` rollout on `/feature-flags`, email
queue/ingestion SLOs on `/system-health`, **global suppression**, **email-volume billing**, the **DSAR
cascade**, and the **retention / `idempotency_keys` expiry sweep**.

**Work units:**
- `admin/web` — **extend** the shipped consoles (`14 §1.5`): `/tenants` (per-tenant email limits/reputation),
  `/provider-configs` (the **`ProviderAdapter` registry** the `EmailSenderPort` resolves against, `15 §B.2`),
  `/feature-flags` (`email.*` staged rollout), `/system-health` (email **queue depth / ingestion SLOs**,
  `15 §A`); same `fetchWithAuth` + `StateSwitch` + `DataTable` pattern. **No new admin app** (`14 §1.5`).
- `admin/api` — staff per-tenant limits/reputation controls; **global suppression** (a `global`-scope
  `suppression_list` row, tenant-wide block — reuse the existing table, `14 §1.1`); **email-volume billing**
  meter; all staff actions audited via the existing `audit_log` (IDs + actions only).
- `workers` — the **retention sweep**: cold `email_event` partition **`DROP`/`DETACH`** (never a `DELETE`
  scan) and the **`idempotency_keys` expiry sweep**, both **leader-locked** and **batched** (`15 §A.2/§A.8`).
- `db/test` — the **per-endpoint cross-tenant HTTP isolation itest** (known-gaps track §6, gap #2) and the
  **DSAR-cascade** itest (erasure tombstones across `outreach_log` / `email_event` / `activities` /
  `suppression_list` / `consent_records` + a `global` `suppression_list` row prevents re-send/re-import).
- audit/compliance wiring (`06`, `12`): customer-visible access log for staff access; **break-glass = the
  shipped `apps/admin` Users impersonation** (time-boxed, audited, `14 §1.5`) for any record-level content
  access.

**Dependencies.** P1 (infra to govern), P3/P4 (volume to meter/limit), all prior phases for the entities the
DSAR cascade must reach.

**Feature flags.** `email.admin`.

**Done when.** Staff manage domains/mailboxes/limits via the **existing** `apps/admin` consoles with every
action audited; **global suppression** (a `global` `suppression_list` row) blocks sends tenant-wide;
**email-volume billing** meters per tenant; a **DSAR erasure cascades** across all email-touched entities and
writes a `global` suppression row; the **retention sweep** drops cold `email_event` partitions and expires
`idempotency_keys`; the **per-endpoint cross-tenant HTTP isolation itest** is green; compliance/audit (`06`)
and the roles/permissions matrix (`12`) hold.

**Verification recipe.**
- **Per-endpoint cross-tenant HTTP isolation itest** (MANDATORY — the new control this phase adds, known-gap
  #2): every email API/admin endpoint, called with tenant A's session against tenant B's resource IDs, returns
  404 / no cross-tenant data.
- **DSAR-cascade test** (MANDATORY): a person-level erasure tombstones the contact across all email entities
  (`outreach_log`, `email_event`, `activities`, `suppression_list`, `consent_records`) and a `global`
  `suppression_list` row prevents re-send.
- **Retention-sweep test**: cold `email_event` partitions are `DROP`/`DETACH`ed (not `DELETE`d) and
  `idempotency_keys` past retention are expired, both leader-locked and batched (`15 §A.2/§A.8`).
- **Staff-no-access test**: staff see tenant metadata/aggregate only; record-level content requires audited
  break-glass impersonation (the shipped `apps/admin` Users flow, `12`, `14 §1.5`).
- Gate: as P0.

---

## 6. Known-gaps remediation track (each assigned to a phase as a mandate)

These are the five carried-forward gaps from the TruePoint constraints digest — now **specified** against the
real engine. Each is a **mandate** in a named phase, not a wish-list item — the phase's "Done when" is not met
until it is addressed.

| # | Known gap | Mandate (phase) | Why there |
|---|---|---|---|
| 1 | **KMS / envelope encryption** for live credentials. | **P0** — the `mailbox_integration` secret store is **built KMS-envelope-encryption from the start** (D7); this is the *first* live secret the subsystem holds, so the primitive is right at P0, not deferred to app-AES-GCM. | Secrets are live mailbox credentials; a leak is account takeover (`00 §1`, D7). The shipped `creditRepository`/credit path never stored a third-party credential — `mailbox_integration` is the new exposure. |
| 2 | **No per-endpoint cross-tenant HTTP isolation test.** | **P6** — the per-endpoint cross-tenant HTTP isolation itest is a P6 "Done when" gate (§5/P6); the DB-layer cross-tenant itest already runs every phase from P0 (modelled on `savedSearches.itest.ts`). | P6 is when the full endpoint surface (customer + the extended `apps/admin`) exists to test exhaustively; the HTTP-layer test complements the per-phase DB-layer test. |
| 3 | **Per-tenant send-quota UNWIRED into the metered send path.** | **P0** (build the counter on the `creditRepository` FOR-UPDATE pattern) + **P1** (wire it into `sendStep`'s send authorization before `email.send` is enabled) + **P6** (per-tenant limits/billing UI on `/tenants`). | A metered real send path without a quota/cap is surprise spend and an abuse vector (`operations`, `15 §A.6`); the M9 engine had only the reveal-credit balance, not a *send* quota — it must be wired before any tenant sends for real. |
| 4 | **Residency siloing absent.** | **P0** (the new `sending_domain` / `mailbox_integration` / `email_event` schema and the KMS store are built residency-aware) + **P6** (staff residency controls on `/tenants`); flagged for security/legal review before any production launch with real recipients. | Residency is a storage/tenancy property; retrofitting it after `email_event` rows exist is expensive — the new model must accommodate it from P0. |
| 5 | **Leader-locked scheduler for sequence ticks.** | **P4** — the `email_sequence_tick` worker (extending `queues/outreach.ts`) runs under a **leader lock** with a `FOR UPDATE SKIP LOCKED` batch cap, proven by the **two-worker no-double-advance itest** (`15 §A.4`); **P5** warmup's tick inherits the same lock. | Scheduled jobs that fan out real sends must fire once; a double-fire is a duplicate email to a real recipient (§5/P4, `15 §A.4`, `platform`/`operations`). |

---

## 7. The mandatory cross-cutting verification controls

Five verification controls are **mandatory and recur across phases** (not one-time). They are restated here so
the contract is unambiguous:

1. **Cross-tenant isolation itest (every phase, P0 onward).** Seed **two tenants**; assert tenant A cannot
   **see or modify** tenant B's email rows or reach them through any endpoint, modelled on the shipped
   `packages/db/src/test/savedSearches.itest.ts`. New entities/endpoints added in a phase extend the itest in
   that phase. This is the structural proof behind D2/D8 and the security mandate; it is non-negotiable.
2. **DNS-auth checks — SPF / DKIM / DMARC (P0, P1, P5).** A `sending_domain` is unusable until SPF + DKIM +
   DMARC verify and align (`03`); the send path refuses an unverified domain; the deliverability dashboard
   reflects real state.
3. **Send-path e2e (P1, re-run under P4 automation).** Connect → verify domain → queue send via the real
   adapter → one delivered message advancing one `outreach_log` row on the tenant's own identity →
   Idempotency-Key replay sends once (D5) → suppressed recipient blocked (D4) → over-quota send refused
   (`15 §A.6`).
4. **Webhook-signature test (P1 delivery/bounce → `handleBounce`, P3 events → `email_event`).** A
   correctly-signed webhook is accepted; a forged/unsigned/replayed payload is rejected; events ingest
   idempotently; the edge sheds to `503`+`Retry-After` under load; no PII/bodies logged (`15 §A.5`).
5. **Two-worker no-double-advance itest (P4).** Two `email_sequence_tick` instances → each due `outreach_log`
   step advances **exactly once** and produces **exactly one** send (`15 §A.4`, known-gap #5).

**Standard gate (every phase, mirroring `list-plan/09 §5`):** `npx turbo run typecheck`, `bun test`,
`npx @biomejs/biome check`, `npm run lint:boundaries`, and regenerate `docs/ARCHITECTURE_MAP.md`. itests
(`packages/db/src/test/*.itest.ts`) run in CI (Docker/Postgres/Redis).

---

## 8. Dependency graph

```
P0 Foundations ──► P1 Reputation isolation + REAL send path ──► P3 Tracking + Inbox ──► P4 Sequence automation
   (new schema)        (consoleSender → ESP adapter)                (email_event)         (leader-locked tick)
       │                       │                                        │                         │
       │                       │                                        └─────────────► P5 Deliverability + warmup + analytics
       │                       │                                                                  ▲
       │                       └────────────────────────────────────────────────────────────────┘
       │
       └──► P2 Templates ──► (feeds P3 templated sends, P4 sequence steps)
                                  │
P1 / P3 / P4 ────────────────────────────────────────────────────► P6 Admin + governance + retention sweep
                                                                     (extends apps/admin; must finish before GA)
```

**Reading the graph (prose):**
- **P0 is the root** — the **new** schema (`sending_domain` / `mailbox_integration` / `email_event` /
  send-quota), RLS over it, the KMS secret store, the DNS-verified identity. Nothing sends for real without it.
- **P1 depends only on P0** and is the gate for the whole subsystem (the two unforgiving risks, §4, plus the
  `consoleSender` → real-adapter swap and the send-quota wiring). No later phase enables a send for a tenant
  whose P1 isolation/DNS/quota controls are not proven.
- **P2 (Templates) depends on P0** (schema/RLS) and only on P1 for an optional "send a test"; it can otherwise
  proceed in parallel with P1 — it externalizes `outreach_steps.subject`/`body` and flips the Templates STUB.
- **P3 (Tracking + Inbox) depends on P1** (a real send to track) and **P2** (templated sends to track).
- **P4 (Sequences) depends on P3** (reply detection → auto-pause), **P2** (steps reference templates), and
  **P1** (the underlying real send path).
- **P5 (Deliverability + analytics) depends on P1** (volume to warm) and **P3** (`email_event` to report).
- **P6 (Admin + governance) depends on P1/P3/P4** for the infra and volume to govern and on **all prior
  phases** for the entities its DSAR cascade must reach. Governance work may *start* after P1 but **must finish
  before GA** — exactly as the List tab's Phase 5 governance gated GA (`list-plan/09 §3`).

---

## 9. Risks & mitigations (beyond the two unforgiving items in §4)

- **Duplicate sends under automation** (P4): the `email_sequence_tick` and `email_warmup` schedulers run under
  a **leader lock** with a `FOR UPDATE SKIP LOCKED` batch cap (`15 §A.4`); sends are idempotent via the shipped
  `idempotency_keys` (D5); a double-fire never produces a second email to a real recipient — proven by the
  two-worker itest.
- **Webhook spoofing / replay** (P1/P3): every ingest endpoint **verifies signatures** and ingests
  idempotently (on the provider event id); forged payloads are rejected and logged (IDs/actions only); the edge
  sheds to `503`+`Retry-After` under load (`15 §A.5`) — inputs are attacker-controlled (`04`).
- **Surprise send-volume cost / abuse** (P0/P1/P6): the new per-tenant send-quota (the `creditRepository`-pattern
  counter, `15 §A.6`) is wired **into** the metered send path before `email.send` is enabled (§6 gap #3);
  global suppression and per-tenant reputation limits land in P6 on the existing `apps/admin` consoles.
- **Hot-row contention at volume** (P1/P3/P5): the per-mailbox throttle is **Redis + queue-local**, never a
  Postgres row (`15 §A.1`); `email_event` is range-partitioned by day (`15 §A.2`); analytics read partitioned
  rollups, never the firehose (`15 §A.3`); the only FOR-UPDATE lock under load is the low-frequency send-quota
  — proven by the **P5 10M-events/day load-test SLO** (`15 §A.9`).
- **The firehose bloating the timeline** (P3): `email_event` **feeds** `activities` (D11) — the product never
  queries the raw firehose for a timeline render (`15 §A.2`).
- **Staff over-reach** (P6): privacy-first staff matrix (`12`) + the shipped `apps/admin` Users **audited
  break-glass impersonation** (`14 §1.5`) is the only record-level content path; enforced by RLS, not UI (D8,
  security precedence).
- **Open metric over-trust** (P3/P5): opens are labelled **informational, not KPI** everywhere they appear;
  reply rate is the primary KPI (D6) — Apple MPP broke opens structurally (`04`).
- **Forking the engine** (all phases): introducing any new `email_sequence` / `email_suppression` /
  `email_consent` / `email_idempotency_key` table would create a second, weaker path the D4/D5 gates no longer
  cover (D11 rationale, `14 §6`). The vocabulary mapping (`14 §2`) and the recurring cross-tenant itest (§7)
  are the structural backstops; no phase merges with the itest red.

---

> **Closing — this is the execution contract.** The order is P0 → P1 → (P2 ∥ P3 → P4 → P5) → P6, with the two
> unforgiving risks (§4) front-loaded into P0/P1 and proven before the real sender reaches any production
> recipient. **Every phase EXTENDS the shipped M9 engine through its seams (D11) — reusing `outreach_*` /
> `suppression_list` + `assertNotSuppressed` / `consent_records` / `idempotency_keys` / `audit_log` /
> `activities` / the `creditRepository` lock pattern / the `EmailSenderPort` seam — and the only net-new build
> is `sending_domain` / `mailbox_integration` / `email_event` / the send-quota / warmup + reputation pools
> (§0, `14 §2.1`).** Each phase ships behind its `email.*` flag on the shipped Feature flags console, is
> independently mergeable, carries the mandatory cross-tenant isolation itest and the §A.9 scale gate, and
> meets the standard gate. For the *what* and *why* of any piece of work, follow the cited sibling doc:
> overview/decisions `00`, templating `01`, sending infrastructure `02`, deliverability `03`,
> status/event tracking `04`, sequences/automation `05`, compliance `06`,
> multitenancy/reputation isolation `07`, reporting/analytics `08`, data model `09`, web surface `10`,
> admin surface `11`, roles/permissions `12`, **current-state ground truth `14`**, **scalability/extensibility
> `15`**. This doc (`13`) owns the order they ship in.
</content>
</invoke>
