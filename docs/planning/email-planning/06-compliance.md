# Email — Compliance (06)

> **Status:** Plan (not yet built). **Owner:** Security (final say) + Platform + Data.
> **Last updated:** 2026-06-24. Part of the `docs/planning/email-planning/` set; mirrors the
> structure of `docs/planning/list-plan/`. The **Locked Decisions (D1–D10)**, **Shared
> Vocabulary**, **Canonical Entities**, and **Phase Map** are owned by `00-overview.md` /
> `09-data-model.md` / `13-rollout-phases.md` and are cited here **verbatim**, not re-litigated.
> **This is an engineering-controls design, not legal advice — privacy counsel must review
> before any production launch with real recipient data.** Per the constraints digest,
> **security has the final say on every compliance and PII point in this document.**

This document is the **compliance contract** for the email subsystem: how an outbound send is
made **lawful** before it leaves, how a recipient's wish to never hear from us again is honoured
**unbypassably**, how lawful basis and opt-in/opt-out are **recorded**, and how every consequential
action is **audited without ever storing PII or message bodies**. It is deliberately enforcement-
first, per **D9 — compliance is enforced, not advisory**.

Nothing here is greenfield in posture: it **inherits** TruePoint's existing isolation (RLS),
suppression-gates-everything discipline, append-only audit, and DSAR fan-out from the prospect /
list subsystems, and **extends** them to two new canonical entities — **`email_consent`** and
**`email_suppression`** (both owned by `09-data-model.md`) — and to the send path defined in
`02-sending-infrastructure.md`. Where a control is new for email, the rule is stated as a **build
mandate** against the phase that owns it (`13-rollout-phases.md`).

---

## 1. The compliance posture in one line

> **A send is illegal until proven legal.** Every `email_send` must pass, *in the same
> transaction that records it*, a **suppression check (D4, fail-closed)** and a **lawful-basis
> check**; a marketing send must additionally carry **one-click List-Unsubscribe (RFC 8058,
> D9)** and a **CAN-SPAM physical address**. No code path may bypass these. This is the email
> analogue of the list subsystem's "suppression is unbypassable" rule
> (`list-plan/08-security-compliance.md §6`).

The three regulations TruePoint must satisfy at launch are **GDPR** (EU recipients), the **India
DPDP Act 2023** (Indian recipients), and **CAN-SPAM** (US recipients). They do not agree on the
consent model, so TruePoint resolves the conflict by **recording a per-recipient lawful basis and
enforcing the strictest applicable rule per jurisdiction** — never a single global posture
(§9, the comparison table).

---

## 2. GDPR (EU)

### 2.1 Lawful basis — legitimate interest for B2B, consent where required

For **B2B sales prospecting**, the appropriate lawful basis is **legitimate interest under GDPR
Article 6(1)(f)** — not consent — provided three conditions hold: the message is relevant to the
recipient's professional role, we are transparent about where we obtained the data, and we offer a
clear opt-out. [1][2] Consent (Art. 6(1)(a)) is reserved for cases where national **ePrivacy**
transposition requires opt-in (see §2.4). This mirrors the lawful-basis stance already adopted for
list data (`list-plan/08-security-compliance.md §3.1`): **legitimate interest + a documented
balancing test**, not blanket consent.

> **Mechanism.** The basis under which a given recipient may be emailed is recorded as an
> **`email_consent`** row (`09-data-model.md`) carrying `lawful_basis ∈ {legitimate_interest,
> consent, contractual}`, `source`, `obtained_at`, `jurisdiction`, and any `withdrawn_at`. The
> send-path lawful-basis check (§1, §5) reads this row; **a send with no lawful basis on record
> for the recipient's jurisdiction is refused, not defaulted.**

### 2.2 The Legitimate Interest Assessment (LIA)

Legitimate interest is only valid if **documented**. We must be able to demonstrate, per prospect,
how the contact data was acquired, the basis (typically legitimate interest), the purpose of the
outreach and why it is relevant, and how opt-outs and data-subject rights are honoured. [1][2] The
**LIA / balancing-test snapshot is recorded at the point the basis is asserted** (carried on the
`email_consent` row's `source` + provenance fields), forming the queryable lawful-basis lineage
chain for DSAR and audit — the same lineage discipline the list plan applies to imports
(`list-plan/08-security-compliance.md §3.1`).

### 2.3 Right to object and right to erasure

Under GDPR a data subject has an **unconditional right to object** to direct-marketing processing
(Art. 21(2)). [3] In TruePoint this is **not** a soft preference — exercising it must:

1. write an **`email_suppression`** row (`reason = unsub`, scope = tenant+workspace, and a
   `global` row where the objection is identity-level — §6), which **gates every future send
   (D4)**; and
2. set `email_consent.withdrawn_at` so the lawful-basis check can no longer return a positive.

The **right to erasure** is handled by the **DSAR cascade** (§8), which deletes the Person from all
**unsent** enrollments and **suppresses** them (D9) — the email-side extension of the list plan's
person-level erasure cascade (`list-plan/08-security-compliance.md §5.2`).

### 2.4 ePrivacy divergence and residency (known gap → mandate)

GDPR is the floor; **national ePrivacy law can be stricter**. The EU ePrivacy Directive
(2002/58/EC) is transposed differently per member state — e.g. Poland's new Electronic
Communications Law (PKE), effective 10 Nov 2024, strengthened consent for direct marketing, and
Germany applies strict opt-in under the UWG. [1] TruePoint therefore keys the lawful-basis check on
the recipient's **`jurisdiction`**, not a single EU posture.

> **Mandate (residency siloing — the known gap).** The constraints digest flags that
> **residency siloing is ABSENT**. EU recipient data is *not yet* physically siloed in an EU
> region. This is recorded here as a **GDPR/DPDP residency mandate**, not a feature claimed as
> done: the `email_consent`/`email_suppression` rows already carry `jurisdiction`/`region` so the
> routing is deterministic when the region is stood up, but **multi-region residency is roadmap,
> owned outside this doc** (mirrors `list-plan/08-security-compliance.md §8`). Counsel must sign
> off on processing EU data outside the EU until siloing lands.

---

## 3. India DPDP Act 2023 (DPDP)

### 3.1 Consent is the rule — there is no legitimate-interest escape hatch

The **Digital Personal Data Protection Act, 2023** governs Indian recipients. Its model is
**materially stricter than GDPR for outbound email**: a Data Fiduciary must obtain **consent before
processing personal data**, and that consent must be **free, specific, informed, unconditional, and
unambiguous, with a clear affirmative action** (Section 6). [4][5] **DPDP has no general
"legitimate interest" basis** — only a narrow set of *legitimate uses* (government service,
statutory functions, medical emergencies, voluntary disclosure), **none of which cover cold B2B
sales email.** [5][6]

> **Enforcement consequence.** For a recipient whose `jurisdiction = IN`, the lawful-basis check
> (§5) accepts **only `lawful_basis = consent`** (or `contractual`) on the `email_consent` row.
> A `legitimate_interest` basis — sufficient for an EU recipient — is **insufficient for an Indian
> recipient** and the send is refused. This per-jurisdiction asymmetry is exactly why TruePoint
> records lawful basis per recipient rather than adopting one global posture (§1, §9).

### 3.2 Notice and the right to withdraw

DPDP requires a **standalone notice in plain language** accompanying the consent request, describing
the data collected, the purpose, the grievance-redressal route, and how the data principal exercises
their rights — available across India's scheduled languages. [4][5] Critically, **withdrawal of
consent must be as easy as giving it.** [5][6]

> **Mechanism.** Withdrawal is the **one-click unsubscribe** path (§4) plus an in-app preference
> control; both write the same `email_suppression` row and set `email_consent.withdrawn_at`. The
> notice text and grievance contact are surfaced from a **workspace/tenant compliance setting**
> (the same setting that carries the CAN-SPAM physical address — §5.3), so each tenant's notice and
> redressal route are configured, not hard-coded.

### 3.3 Data-principal rights

DPDP grants six rights: **access, correction, erasure, grievance redressal, nomination, and
withdrawal of consent.** [4][5] Access/correction/erasure are served by the **DSAR cascade** (§8);
withdrawal and grievance by §3.2.

> **Timeline (cite, don't re-derive).** DPDP Rules 2025 took effect **13 Nov 2025**; substantive
> obligations (consent, notice, data-principal rights, security) are enforced from **13 May
> 2027**. [5][7] TruePoint treats the consent/notice/withdrawal controls in this doc as **required
> at launch** regardless, because the Google/Yahoo one-click rule (§4) and CAN-SPAM (§5) already
> demand the same machinery — building it once satisfies all three.

---

## 4. One-click List-Unsubscribe — RFC 8058 (D9)

### 4.1 What the header pair must contain

Per **D9**, every **marketing** `email_send` (sequences, campaigns — not strictly transactional
system mail) must carry **one-click unsubscribe per RFC 8058**: [8][9]

- **`List-Unsubscribe`** — at least one **HTTPS URI** pointing to the unsubscribe endpoint
  (TruePoint's per-tenant custom tracking/unsubscribe domain, **D3**);
- **`List-Unsubscribe-Post: List-Unsubscribe=One-Click`** — the signal that the unsubscribe is a
  true one-click POST.

Both headers must be **covered by the message's DKIM signature** (so the mailbox provider trusts
them), and the unsubscribe **must complete without login, cookies, or any extra step** — a
confirmation page may be shown *after* the action, but the unsubscribe itself processes on the first
click. [8][9] This ties directly to the Google/Yahoo bulk-sender rules covered in
`03-deliverability.md` (cross-ref); those rules **required** one-click unsubscribe from **February
2024**, and Google escalated from temporary deferrals to **permanent rejections in November
2025**. [10][11]

### 4.2 The unsubscribe endpoint and its 48-hour (≤2-day) processing rule

Google and Yahoo require that an unsubscribe request be **processed within 2 days (48 hours)**. [9][10]
TruePoint exceeds this by processing **synchronously**: the public unsubscribe endpoint
(`apps/api/src/features/email/routes.ts`, an **unauthenticated** POST on the per-tenant unsubscribe
domain) writes the **`email_suppression`** row in the request transaction, so the recipient is
suppressed **immediately**, not within 48 hours.

> **Security mandates on the endpoint (security has final say).**
> - **No PII in the URL or logs.** The unsubscribe link carries an **opaque, signed, single-purpose
>   token** that resolves to the suppression target server-side — never a raw email address. Per the
>   constraints digest, **NO PII IN LOGS**; the endpoint logs token ID + action only (§7).
> - **Unauthenticated but unforgeable.** The token is HMAC-signed and scoped to one recipient ×
>   tenant; a tampered/absent token resolves to nothing (fail-closed). IDOR attempts return **404**,
>   per the security baseline.
> - **Idempotent.** Re-POSTing the same token is a no-op that returns success (D5 idempotency
>   discipline) — mailbox providers may retry.
> - **GET is safe.** RFC 8058 one-click is a **POST**; any GET on the link (e.g. a security
>   scanner pre-fetching it) must **not** silently unsubscribe — only the `List-Unsubscribe=One-Click`
>   POST mutates state. [8]

> **Phase mandate.** The unsubscribe endpoint + header injection land in **P1** (send path) so the
> very first marketing-capable send is compliant; the consent/suppression tables they depend on
> land in **P0** (`13-rollout-phases.md`).

---

## 5. Suppression enforcement (D4) and the lawful-basis gate

### 5.1 Suppression gates every send, fail-closed — at enqueue AND dequeue

**D4** is absolute: **suppression gates every send, fail-closed.** The `email_suppression` entity
(`09-data-model.md`) carries reasons **`{unsub, hard_bounce, complaint, manual, DNC}`**, is
**tenant + workspace scoped** (with a `global`/identity scope for DSAR/objection — §6, §8), and
matches by the **same blind-index discipline** the list subsystem uses so the check never decrypts
PII (`list-plan/08-security-compliance.md §2.2`).

The gate runs at **two points** (defence in depth against the queue's eventual consistency):

| Gate point | Where | Why both |
|---|---|---|
| **At enqueue** | `packages/core/src/email/` compliance gate, when an `email_enrollment` is created or a send is scheduled | Cheap early rejection; never enqueue a doomed send |
| **At dequeue** | The send worker (`apps/workers/src/queues/email*.ts`), **inside the transaction that writes the `email_send` row** | A suppression may have arrived *after* enqueue (a Monday unsub for a Wednesday step); the dequeue check is the **authoritative, last-moment** gate |

> **Fail-closed semantics.** The dequeue check is an **in-transaction** read like the list plan's
> `assertNotSuppressed` (ADR-0009 lineage): if the suppression store is unreachable or the result is
> ambiguous, the send **does not go out** — it is deferred/DLQ'd, never sent "to be safe." This is
> the email analogue of the RLS `NULLIF` fail-closed idiom (`list-plan/08-security-compliance.md
> §1.2`): **absence of a clear "allowed" signal means deny.**

### 5.2 What immediately suppresses

Per D4 and D9, these events write an `email_suppression` row **immediately and synchronously**:

- **Unsubscribe** (one-click §4, in-app, or List-Unsubscribe mailto) → `reason = unsub`.
- **Spam complaint** (FBL / provider webhook, see `04-status-event-tracking.md`) → `reason =
  complaint`. Verify the **webhook signature** before trusting it (security baseline).
- **Hard bounce** (permanent failure from the provider) → `reason = hard_bounce`. Soft/transient
  bounces do **not** suppress (they retry per `02-sending-infrastructure.md`).
- **DNC / manual** (staff or tenant-admin action, abuse control) → `reason = DNC` / `manual`.

A suppression is **never silently removable**; un-suppression (e.g. a recipient re-subscribes) is an
**audited, explicit, narrowly-permitted action** (`12-roles-permissions.md`), never a side effect.

### 5.3 The lawful-basis gate and the CAN-SPAM physical address (US)

Alongside suppression, the **lawful-basis check** (§2.1, §3.1) runs in the same gate: it reads
`email_consent` for the recipient's `jurisdiction` and refuses a send whose basis is insufficient
**for that jurisdiction** (legitimate-interest is fine for EU, **not** for India). For **US**
recipients the controlling rule is **CAN-SPAM**, which requires: [12]

- a **valid physical postal address** in every commercial message (a street address, a USPS-
  registered PO box, or a registered private mailbox);
- **honest, non-deceptive `From`, `Reply-To`, routing information, and `Subject` line**, and (for
  ads) identification of the message as an advertisement;
- a **clear opt-out mechanism** that stays valid for at least **30 days** after the send;
- **honouring an opt-out within 10 business days**; and a bar on selling/transferring an opted-out
  address.

> **Mechanism.**
> - The **physical postal address** is a **workspace/tenant compliance setting** (the same setting
>   that carries the DPDP notice/grievance text — §3.2), injected into the rendered template footer
>   by the send path. **A marketing send for a tenant with no physical address on file is refused**
>   (fail-closed), the same way a missing lawful basis is.
> - **Honest headers** are a render-time + send-path invariant (`01-templating.md`,
>   `02-sending-infrastructure.md`): the `From`/`Reply-To` must resolve to the tenant's verified
>   `sending_domain` (D3) and a monitored mailbox.
> - **10 business days** is comfortably met because TruePoint suppresses **synchronously** on opt-out
>   (§4.2, §5.1) — far inside CAN-SPAM's 10-day window *and* Google/Yahoo's 2-day window.

---

## 6. Consent tracking (`email_consent`)

Every consequential lawful-basis fact about a recipient is a row in **`email_consent`**
(`09-data-model.md`), capturing at minimum:

| Field | Purpose |
|---|---|
| `lawful_basis` | `legitimate_interest` \| `consent` \| `contractual` — the basis asserted (§2.1, §3.1) |
| `source` | Where the basis/opt-in came from (import attestation, form, in-app, API) — the LIA/provenance snapshot (§2.2) |
| `obtained_at` | Timestamp the basis/opt-in was recorded |
| `withdrawn_at` | Timestamp of objection/withdrawal (null while active) — set by §2.3 / §3.2 |
| `jurisdiction` / `region` | Drives the per-jurisdiction gate (§5.3) and the residency mandate (§2.4) |

Rows are **append-style** for auditability — a withdrawal sets `withdrawn_at` and writes an audit
event (§7); it does not erase the prior consent fact. Like every canonical entity, the table carries
**`tenant_id` always**, **`workspace_id`** (workspace-scoped), **`owner_user_id`** where user-owned
(D8 owner-scoped visibility), with **RLS ENABLE + FORCE**, the **fail-closed `NULLIF`** predicate,
and **`tenant_id`-leading indexes** (constraints digest; `09-data-model.md`).

> **Relationship to `email_suppression`.** Consent answers *"may we email this person?"*;
> suppression answers *"has this person told us to stop / did delivery fail?"* The send gate (§5)
> requires **both** a positive lawful basis **and** no suppression. They are separate entities
> because they have different lifecycles, owners, and retention.

---

## 7. Audit logging — IDs and actions only, never PII or body

Per the constraints digest, **audit logs store IDs + actions, NEVER PII or message bodies.** This is
a TruePoint security non-negotiable, not a regulatory minimum. Every compliance-consequential action
is recorded append-only:

- consent recorded / withdrawn (`email_consent` change);
- suppression added / reason / scope (`email_suppression` change);
- a send **blocked** by the gate (`send.blocked` with the reason: `suppressed` / `no_basis` /
  `no_physical_address`) — the email analogue of the list plan's `reveal.blocked` audit
  (`list-plan/08-security-compliance.md §6`);
- unsubscribe processed (token ID, not the address);
- DSAR cascade run (§8).

> **What an audit row may and may not contain.**
> - **MAY:** actor ID (user/staff/system), action enum, the affected **entity IDs**
>   (`email_send` id, `email_consent` id, recipient **person/contact id** — an internal id, not an
>   address), tenant/workspace id, timestamp, reason enum.
> - **MUST NOT:** the recipient's email address or phone, the rendered subject/body, or any header
>   value that embeds PII. **No PII in logs** is a security non-negotiable (final say). The
>   unsubscribe-token ID is logged; the token's PII payload is resolved only server-side and never
>   written to a log line.

Audit rows live in the existing append-only, partitioned audit store (the platform audit lineage
from `list-plan/07-admin-staff-governance.md`), surfaced to tenant admins and staff in **P6**
(`13-rollout-phases.md`) as the compliance/audit surface (`11-admin-surface.md`).

---

## 8. DSAR cascade (GDPR erasure / DPDP erasure) — D9

When a **Person** is erased via DSAR (GDPR Art. 17 / DPDP §12 erasure), the email subsystem must do
its part of TruePoint's cross-tenant **DSAR cascade** — the same fan-out the list plan defines, run
under the **one sanctioned privileged cross-workspace path**, never the tenant request flow
(`list-plan/08-security-compliance.md §5.2`; ties to the **data-skill DSAR cascade**). The email
contribution to the cascade, per **D9**, is:

1. **Remove the Person from all *unsent* enrollments.** Every `email_enrollment` for that person
   with steps **not yet sent** is cancelled/removed so no future `email_send` is generated. **Already-
   sent** `email_send` rows are *not* fabricated away — they are an immutable historical fact —
   but their **PII is nulled/tombstoned** the same way the list plan tombstones overlay copies
   (recipient resolved to a tombstoned identity; no plaintext address retained).
2. **Suppress the Person.** Write a **`global`/identity-scoped `email_suppression`** row so that no
   re-import, re-enrollment, or future sequence can re-introduce them — the email mirror of the list
   plan's "insert a `global` suppression row so re-import can't re-create the subject."
3. **Withdraw consent.** Set `email_consent.withdrawn_at` for the person across the tenant.
4. **Purge tracking PII.** `email_tracking_event` rows tied to the person are swept (IP/UA and any
   recipient-identifying payload), consistent with the no-residual-PII verification scan.
5. **Audit** the cascade (IDs + action only, §7) and do not mark the job `completed` until a
   verification scan confirms **no residual recipient PII** across consent, suppression (the
   suppression row itself is keyed by blind index, not plaintext), enrollments, sends, and tracking.

> **Mechanism + phase.** This runs as an **idempotent BullMQ worker**
> (`apps/workers/src/queues/email*.ts` — the DSAR cascade worker) joined into the existing
> `dsar-delete` fan-out, with **backoff + DLQ** (queue constraints). The cascade lands in **P6**
> (`13-rollout-phases.md`, admin + governance), but the **suppression/consent primitives it depends
> on land in P0** and are **enforced from P1** — so even before the full cascade ships, a manual
> suppression already blocks all future sends (D4).

> **Two operations, not one (mirrors the list plan).** *Removing a recipient from a sequence* (an
> ordinary tenant op — they finished, or the seller un-enrolled them) is **not** erasure: it cancels
> the enrollment but writes no global suppression and touches no consent. **Person-level erasure**
> is the privileged fan-out above. Conflating them is a bug.

---

## 9. Regulation comparison table

The single most important artefact in this doc: **the consent models disagree, so TruePoint enforces
per-jurisdiction at the send gate (§5), keyed on `email_consent.jurisdiction`.**

| Regulation | Scope (who/where) | Consent model for outbound B2B email | Unsubscribe / opt-out rule | TruePoint enforcement point |
|---|---|---|---|---|
| **GDPR + ePrivacy** [1][2][3] | EU/EEA data subjects (incl. business contacts) | **Legitimate interest (Art. 6(1)(f))** acceptable for relevant B2B prospecting *with documented LIA*; **consent** where national ePrivacy requires opt-in | **Unconditional right to object** (Art. 21(2)); must be easy and honoured | Lawful-basis gate accepts `legitimate_interest` for `jurisdiction ∈ EU` **with LIA on the `email_consent` row**; objection → `email_suppression` + `withdrawn_at` (§2, §5) |
| **India DPDP Act 2023** [4][5][6] | Indian data principals | **Consent only** — free/specific/informed/unconditional/unambiguous; **no general legitimate-interest basis**; cold B2B email needs consent | **Withdrawal as easy as consent**; six data-principal rights incl. erasure | Gate accepts **only `consent`/`contractual`** for `jurisdiction = IN` (legit-interest **refused**); withdrawal = one-click unsub → suppression + `withdrawn_at` (§3, §5) |
| **CAN-SPAM (US)** [12] | US commercial email | **No prior consent required** (opt-out regime); but honest headers + identify ads | **Honour opt-out within 10 business days**; opt-out valid ≥30 days; valid **physical postal address** required | Physical address = tenant compliance setting (**send refused if absent**); honest `From`/`Subject` enforced at render/send; **synchronous** suppression beats the 10-day clock (§5.3) |
| **RFC 8058 + Google/Yahoo bulk rules** (2024+) [8][9][10][11] | Senders to Gmail/Yahoo (≥5k/day) — practical floor for all marketing mail | N/A (deliverability rule, cross-ref `03-deliverability.md`) | **One-click `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`**, DKIM-aligned; **process within 2 days (48h)** | Header pair injected on every marketing send (**D9**); unauthenticated signed-token unsubscribe endpoint suppresses **synchronously** (§4) |

---

## 10. Compliance self-test matrix (must pass before GA)

Modelled on the list plan's compliance test matrix (`list-plan/08-security-compliance.md §9`); runs
in `packages/db/test` and `packages/core` tests.

| # | Test | Asserts | Phase |
|---|---|---|---|
| 1 | **Suppression gates send (fail-closed)** | A matching `email_suppression` (any reason, tenant/workspace/global) blocks the send at **both** enqueue and dequeue; an unreachable/ambiguous suppression store **defers, never sends**; `send.blocked` audited. | P0/P1 |
| 2 | **Lawful-basis gate, per jurisdiction** | `legitimate_interest` allows an EU send but **refuses** an `IN` send; missing basis refuses everywhere; refusal audited as `no_basis`. | P1 |
| 3 | **One-click unsubscribe (RFC 8058)** | Every marketing send carries `List-Unsubscribe` (HTTPS) + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, DKIM-covered; a one-click **POST** writes the suppression synchronously; a **GET** does **not** mutate; token tamper → 404; re-POST is idempotent. | P1 |
| 4 | **CAN-SPAM physical address** | A marketing send for a tenant with **no physical address setting** is refused (`no_physical_address`); honest `From`/`Reply-To` resolves to a verified `sending_domain`. | P1 |
| 5 | **DSAR cascade** | A person-level erasure cancels all **unsent** enrollments, writes a **global** `email_suppression`, sets `email_consent.withdrawn_at`, purges `email_tracking_event` PII, tombstones sent-row PII; the verification scan finds **no residual recipient PII**; cascade audited (IDs only). | P6 |
| 6 | **No PII in audit/logs** | No audit row or log line contains a recipient email/phone, subject, or body; only IDs + action + reason enums; the unsubscribe token resolves PII server-side only. | P1 |

**Gate (every phase):** `npx turbo run typecheck`, `bun test`,
`npx @biomejs/biome check`, `npm run lint:boundaries`, and regenerate `docs/ARCHITECTURE_MAP.md`.

---

## 11. Cross-references

- `00-overview.md` — Locked Decisions **D1–D10** (canonical; cited throughout, esp. **D3, D4, D5,
  D8, D9**), Shared Vocabulary, Phase Map.
- `02-sending-infrastructure.md` — the send path, `sending_domain` / DKIM, honest-header
  enforcement, bounce classification (hard vs soft).
- `03-deliverability.md` — the Google/Yahoo/Microsoft bulk-sender rules, spam-rate thresholds
  (0.1% / 0.3%), and authentication that the §4 / §9 unsubscribe rule ties into.
- `04-status-event-tracking.md` — complaint (FBL) and bounce webhook ingestion, signature
  verification, the events that feed §5.2 suppression.
- `05-sequences-automation.md` — `email_enrollment` lifecycle the DSAR cascade (§8) cancels.
- `07-multitenancy-reputation-isolation.md` — per-tenant reputation isolation (D2) and the
  per-tenant custom unsubscribe/tracking domain (D3) the unsubscribe endpoint lives on.
- `09-data-model.md` — **owner of `email_consent` + `email_suppression`** (and all canonical
  entities): columns, RLS ENABLE+FORCE + `NULLIF`, `tenant_id`-leading indexes, blind-index match.
- `11-admin-surface.md` / `12-roles-permissions.md` — the compliance/audit surfaces (P6) and who may
  add/remove suppression, attest lawful basis, or run a DSAR.
- `13-rollout-phases.md` — **P0** suppression + consent tables; **P1** send-path gate + unsubscribe
  endpoint + headers; **P6** admin/governance + DSAR cascade.
- `docs/planning/list-plan/08-security-compliance.md` — the prospect/list compliance design this doc
  reuses (suppression-unbypassable, in-tx gate, DSAR cascade, audit-IDs-only) and extends to email.

---

## 12. Sources

1. ComplyDog — *GDPR-Compliant Cold Emails: lawful basis, legitimate interest, LIA* —
   https://complydog.com/blog/gdpr-compliant-cold-emails
2. Stripo — *GDPR and B2B Email Marketing* —
   https://stripo.email/blog/gdpr-and-b2b-email-marketing-what-you-need-to-know-to-stay-compliant/
3. iGDPR — *Email Marketing and GDPR — Consent, Legal Bases and ePrivacy (right to object)* —
   https://www.igdpr.eu/en/gdpr-email-marketing-consent/
4. MeitY — *The Digital Personal Data Protection Act, 2023 (No. 22 of 2023), official text* —
   https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf
5. CookieYes — *India Digital Personal Data Protection Act (DPDPA): consent, notice, six rights,
   no legitimate-interest basis, DPDP Rules 2025 / May 2027 timeline* —
   https://www.cookieyes.com/blog/india-digital-personal-data-protection-act-dpdpa/
6. EY India — *Decoding the DPDP Act 2023 and DPDP Rules 2025* —
   https://www.ey.com/en_in/insights/cybersecurity/decoding-the-digital-personal-data-protection-act-2023
7. EY India — *Transforming data privacy: DPDP Act 2023 and DPDP Rules 2025 (timeline)* —
   https://www.ey.com/en_in/insights/cybersecurity/transforming-data-privacy-digital-personal-data-protection-rules-2025
8. Mailgun — *What is RFC 8058? List-Unsubscribe + List-Unsubscribe-Post one-click, DKIM coverage,
   no-login requirement* — https://www.mailgun.com/blog/deliverability/what-is-rfc-8058/
9. Customer.io Docs — *Custom unsubscribe links: staying compliant with List-Unsubscribe-Post
   (RFC 8058)* —
   https://docs.customer.io/journeys/channels/email/deliverability/custom-unsubscribe-links/
10. Google Workspace Admin Help — *Email sender guidelines (bulk senders): one-click unsubscribe,
    SPF/DKIM/DMARC, spam-rate 0.1%/0.3%)* — https://support.google.com/a/answer/81126
11. Unboxd — *Google, Yahoo & Microsoft Bulk Sender Requirements: 2026 guide (Feb 2024 effective;
    Nov 2025 permanent rejections)* — https://unboxd.ai/blog/bulk-sender-requirements.html
12. FTC — *CAN-SPAM Act: A Compliance Guide for Business (physical address, honest headers, opt-out
    within 10 business days, 30-day window)* —
    https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
