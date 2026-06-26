# Email Subsystem — Deliverability (03)

> **Status:** Plan (not yet built). **Owner:** Platform + Data + Security. **Last updated:** 2026-06-24.
> Cites the **Locked Decisions (D1–D10)**, **Shared Vocabulary**, **Canonical Entities**, and **Phase
> Map (P0–P6)** in `00-overview.md` (verbatim, not re-litigated). Cross-references `02-sending-infrastructure.md`
> (the send path and ESP/provider strategy), `04-status-event-tracking.md` (open/click events, Apple MPP),
> `06-compliance.md` (one-click unsubscribe, consent, suppression as a compliance control),
> `07-multitenancy-reputation-isolation.md` (per-tenant Reputation Pools and warmup),
> `08-reporting-analytics.md` (deliverability metrics), `09-data-model.md` (the `suppression_list`,
> `sending_domain`, `activities` / `email_event` entities, and the logical `email_send` role), `10-web-surface.md` (customer
> deliverability dashboard), and `11-admin-surface.md` (staff blacklist/placement monitoring).
> **This is an engineering-controls design, not legal advice** — privacy/deliverability counsel must review
> before any production launch with real recipients.

This document is the **deliverability contract** for the TruePoint email subsystem: the end-to-end set of
controls that make a tenant's mail authenticate, reach the inbox, stay off blocklists, and meet the
mailbox-provider rules that are now hard gates (not best-effort). Deliverability is the **highest-risk**
surface in this set — a single shared-infrastructure mistake (a shared tracking domain, an unauthenticated
domain, an unhandled bounce) can blacklist every tenant at once. The whole design therefore biases toward
**per-tenant isolation** (D2, D3) and **fail-closed enforcement** (D4).

Nothing here is a style choice. Per the security-precedence rule, on any access/isolation/PII point security
wins; platform owns the tenancy mechanism (RLS) and the send path; data owns the model. Deliverability
**builds on** those, not around them.

---

## 1. The authentication stack: SPF, DKIM, DMARC, BIMI

Authentication is the foundation. It proves a message legitimately originates from the domain in the
`From:` header. As of February 2024, Gmail and Yahoo make SPF + DKIM + DMARC a **hard requirement** for bulk
senders, not an optimization (`§7`). In TruePoint this stack is established **per `sending_domain` at P0**
(Phase Map: "P0 Foundations — sending-domain DNS auth: SPF/DKIM/DMARC"). A `sending_domain` row is not usable
for any `email_send` until its DNS auth is verified.

### 1.1 What each record does

| Mechanism | What it proves | Where it lives | DNS record | Alignment role |
|---|---|---|---|---|
| **SPF** (Sender Policy Framework) | The sending **IP/host** is authorized to send for the envelope (Return-Path) domain. | DNS TXT on the bounce/envelope domain | `v=spf1 include:... -all` | Aligns on the **Return-Path (envelope) domain** vs `From:` |
| **DKIM** (DomainKeys Identified Mail) | The message body+headers were **cryptographically signed** by the signing domain and not altered in transit. | DNS TXT at `selector._domainkey.<domain>`; the ESP/sender holds the private key | `v=DKIM1; k=rsa; p=<public key>` | Aligns on the **DKIM `d=` signing domain** vs `From:` |
| **DMARC** (Domain-based Message Authentication, Reporting & Conformance) | A **policy** the domain owner publishes telling receivers what to do when SPF/DKIM **fail or fail alignment**, plus where to send reports. | DNS TXT at `_dmarc.<domain>` | `v=DMARC1; p=...; rua=mailto:...` | Requires **at least one of SPF or DKIM to pass AND align** |
| **BIMI** (Brand Indicators for Message Identification) | The brand **logo** that mailbox providers may render next to authenticated mail; a trust/branding signal layered on top of DMARC enforcement. | DNS TXT at `default._bimi.<domain>` | `v=BIMI1; l=<svg url>; a=<VMC url>` | **Gated on DMARC at `p=quarantine` or `p=reject`** |

Both Gmail and Yahoo require the **`From:` header domain to be aligned with either the SPF domain or the
DKIM domain** — passing SPF/DKIM is not enough on its own; the passing identifier must *align* with the
visible `From:` [1][2][3].

### 1.2 DMARC alignment — the part most senders get wrong

DMARC checks whether the domain that passed SPF and/or DKIM **matches the `From:` header domain**. Two modes
[4][5]:

- **Relaxed (default):** the **organizational domains** must match (e.g. `mail.acme-tenant.com` aligns with
  `acme-tenant.com`). This is forgiving of subdomains and is the **recommended posture** for TruePoint
  tenants, because each tenant sends from a subdomain of its own root.
- **Strict:** the domains must be **identical**. Rarely needed; brittle under forwarding/subdomain setups.

For **SPF alignment** the Return-Path (envelope) domain must align with `From:`; for **DKIM alignment** the
`d=` signing domain must align with `From:`. Because forwarding breaks SPF (the envelope sender changes),
**DKIM alignment is the more durable of the two** and TruePoint configures both, treating aligned DKIM as the
primary path.

**Recommended DMARC progression (per `sending_domain`):** publish `p=none` first (monitor-only; satisfies
the Gmail/Yahoo minimum and collects `rua` aggregate reports), then ramp to `p=quarantine` and ultimately
`p=reject` once aggregate reports confirm all legitimate streams pass. **Reaching `p=quarantine`/`p=reject`
is also the gate for BIMI** (`§1.4`). The `sending_domain` entity (doc 09) should record the current DMARC
policy level so the admin/web surfaces can show "monitoring → enforcing → reject" progress.

> **P0 build mandate:** TruePoint **generates the SPF/DKIM/DMARC records** a tenant must publish for each
> `sending_domain`, then **polls DNS to verify** them before marking the domain sendable. DKIM uses a
> **per-tenant selector** (TruePoint-controlled selector under the tenant's domain) with **≥2048-bit RSA
> keys** (Yahoo's stated floor is 1024-bit [3]; we exceed it). Verification status is surfaced in
> `10-web-surface.md` (tenant self-serve) and `11-admin-surface.md` (staff oversight). A domain that fails
> re-verification is flagged, not silently used.

### 1.3 Tradeoffs of the auth stack

| Decision | Best-in-class | Tradeoff |
|---|---|---|
| DKIM key size | ≥2048-bit RSA | Larger DNS TXT records (may need split strings); negligible signing cost |
| DMARC enforcement level | Ramp to `p=reject` | Premature `p=reject` can drop legitimate forwarded mail; mitigated by `p=none` monitoring period + ARC |
| Subdomain vs root sending | Send from a **subdomain** per tenant | Slight setup overhead; isolates the tenant's send reputation from their corporate root-domain mail (`§4`, ties to D2) |
| SPF lookup limit | Keep within the **10 DNS-lookup** SPF limit | Many `include:`s can blow the limit → SPF `permerror`; flatten/minimize includes |

### 1.4 BIMI and VMC/CMC

BIMI lets supporting mailbox providers (Gmail, Yahoo, Apple Mail, Fastmail) render a **verified brand logo**
next to a message. It is a **trust/branding signal, not a deliverability gate** — but it is only available
once a domain is fully authenticated and enforcing DMARC [6][7].

Requirements:

- **DMARC at `p=quarantine` or `p=reject` with `pct=100`** — `p=none` is **not** sufficient for BIMI [6].
- A **logo in SVG Tiny Portable/Secure (SVG Tiny PS)** profile, square, hosted at an HTTPS URL [6].
- A **Verified Mark Certificate (VMC)** or **Common Mark Certificate (CMC)**:
  - **VMC** validates a **registered trademark** of the logo; issued by **DigiCert or Entrust**; required by
    Gmail and Apple Mail to display the logo [6][7].
  - **CMC** (newer, 2024–2025) does **not** require a trademark — it requires proof the logo has been
    **publicly displayed on the domain for ≥12 months** via archive verification; widens eligibility [6].

**TruePoint recommendation:** BIMI is **per-tenant and tenant-owned** — TruePoint surfaces the BIMI DNS
record alongside the SPF/DKIM/DMARC records (`§1.2` mandate), but the **VMC/CMC is the tenant's to obtain**
(it certifies *their* trademark/logo, costs money annually, and legally belongs to them). This keeps
TruePoint out of the certificate-custody business and aligns with **D3**'s per-tenant-not-shared philosophy.
BIMI is **deferred to P5/P6** (it depends on a tenant reaching DMARC enforcement, which itself depends on the
P0 auth foundation being live and monitored). Treat BIMI as an **enterprise-tier deliverability feature**,
not an MVP requirement.

---

## 2. Custom tracking domains per tenant (D3) — and why shared tracking domains are a deliverability bomb

**D3 is locked: custom tracking domain per tenant, never shared.** This document explains *why* it is
non-negotiable, because it is one of the single highest-leverage deliverability decisions in the whole plan.

### 2.1 What a tracking domain is

Open/click tracking rewrites the links in an outbound email to point at a **tracking endpoint** (the pixel
host for opens; a redirect host for clicks). That host is a **domain**, and **every link a recipient's mail
provider sees is evaluated for reputation**. If the tracking domain is on a domain-based blocklist, the
**whole message** is penalized — independent of the sending domain's own reputation.

### 2.2 Why shared tracking domains tank deliverability

Most cold-email/engagement tools default to a **shared** tracking domain used by **thousands of tenants**.
This creates **guilt-by-association**: if any one tenant on the shared domain spams, the receiving providers
associate the shared tracking domain with spam and **blacklist it**, and *every* tenant's mail that contains
a link to that domain suffers — bounces and spam-foldering caused by a link, not by the sender's own list or
copy [8][9]. A custom (branded, per-tenant) tracking domain **isolates each tenant's reputation** from every
other tenant's behavior; a spammer on one tenant cannot taint another [8][9].

This is the **per-tenant reputation-isolation principle (D2)** applied to the tracking layer: a shared
tracking domain is a **cross-tenant reputation coupling**, exactly the thing D2/D3 exist to prevent.

### 2.3 TruePoint design

- The tracking domain is a **per-tenant subdomain** (e.g. `link.<tenant-domain>` or a TruePoint-issued
  per-tenant subdomain), provisioned and DNS-verified as part of the same P0 `sending_domain` onboarding
  flow as SPF/DKIM (it is part of the tenant's **Reputation Pool**, doc 07).
- Tracking endpoints serve over **HTTPS with a valid certificate** — an invalid/expired cert on the tracking
  domain is itself a deliverability and trust hit.
- The tracking domain's reputation is **monitored by the same blocklist watch** as the sending domain
  (`§4`), and surfaces in the deliverability dashboard (`§9`, `10-web-surface.md`).
- **Opens are informational, not a KPI (D6)** — Apple Mail Privacy Protection pre-fetches the open pixel, so
  open data is inflated and unreliable. Tracking-domain hygiene still matters for **clicks** (real signal) and
  for the deliverability cost of the pixel itself. See `04-status-event-tracking.md` for the full Apple MPP
  treatment; this doc only asserts that **tracking-domain reputation is a deliverability concern regardless
  of how the open data is used downstream.**

> **P3 build mandate:** the click-redirect/open-pixel endpoints (served from the per-tenant tracking domain)
> are wired in P3 ("Tracking + Inbox"), but the **tracking domain itself is provisioned and DNS-verified at
> P0** alongside the auth records, so it is reputation-isolated from day one. Endpoints live under
> `apps/api/src/features/email/` and the per-tenant domain is recorded against `sending_domain` (doc 09).

---

## 3. Content / spam scoring

Authentication gets you delivered to the *provider*; **content** decides inbox vs spam folder.

### 3.1 SpamAssassin and modern equivalents

**SpamAssassin** is the long-standing open-source rule-and-score engine: it assigns points for spammy
signals (spam-trigger phrases, excessive links, image-heavy/low-text ratio, broken HTML, missing
unsubscribe, mismatched URLs) and flags messages over a threshold. It is still the **baseline** most
pre-send checkers report against, but on its own it is **necessary, not sufficient** — modern provider
filtering (Gmail, Outlook) is **engagement- and reputation-driven ML**, not a static rule score.

Modern equivalents and complements:

- **Rspamd** — the modern open-source alternative to SpamAssassin (faster, ML-assisted scoring); the better
  choice if TruePoint ever runs its own scoring rather than relying on a checker API.
- **Pre-send content checkers** that report a SpamAssassin-style score plus authentication checks — e.g.
  **mail-tester**, **MailGenius** (content + authentication analysis only — **no seed-list placement**,
  `§5`) [10].

### 3.2 Spammy-content pitfalls to lint for

A pre-send **content lint** (P5; surfaced in the template editor per doc 01 and in the deliverability
dashboard) should flag: spam-trigger phrasing; very low text-to-image ratio / image-only emails; many or
shortened/mismatched URLs; link domains that differ from the sending domain; broken or bloated HTML; ALL
CAPS / excessive punctuation; missing plain-text alternative; and a **missing or non-functional unsubscribe**
(which is also a compliance failure, doc 06). The lint is **advisory at template-authoring time** and does
**not** block sends by itself (D4's hard gate is suppression, not content score).

| Approach | Best-in-class | Tradeoff |
|---|---|---|
| Static rule score (SpamAssassin/Rspamd) | Cheap, deterministic, good for catching obvious mistakes | Does **not** model real provider ML or engagement; a "10/10" score ≠ inbox placement |
| Seed-list placement (`§5`) | Measures **actual** inbox vs spam at real providers | Costs per test; a sample, not your whole audience |
| Provider postmaster signals (`§4.4`) | Ground-truth reputation from the provider itself | Lagging; only for domains you've verified in their tools |

**Recommendation:** integrate a **content-lint at authoring time** (advisory) + **seed-list placement
sampling** (`§5`, measurement) + **Postmaster Tools / Sender Hub** ground-truth (`§4.4`). Do not over-index
on any single spam score.

---

## 4. Blocklist / blacklist monitoring

A **blocklist (DNSBL/RBL) listing** can silently sink a domain or IP. TruePoint must **detect a listing fast**
and route it to the right surface — because per D2 a tenant's listing is *their* Reputation Pool's problem,
but a **shared-resource listing** (a shared IP or, forbidden, a shared tracking domain) is a **platform
incident** affecting every tenant.

### 4.1 The lists that matter

- **Spamhaus** — the most influential operator (protects 3B+ mailboxes); a listing can block delivery to
  Gmail, Outlook, Yahoo and most business providers [11]. Distinct lists, each with a different cause and fix
  [11]:
  - **SBL** (Spamhaus Block List) — sending **IPs/servers**.
  - **XBL** — infected/exploited hosts.
  - **PBL** (Policy Block List) — IPs not meant to send mail directly (e.g. dynamic ranges).
  - **DBL** (Domain Block List) — **domains**; a DBL listing **cannot be fixed by changing IPs** because the
    *domain* itself is flagged [11]. This is exactly why a **shared tracking domain on the DBL poisons all
    tenants** (`§2.2`).
  - **ZRD** — newly registered/zero-reputation domains.
- **Barracuda BRBL** — commercial blocklist fed by Barracuda's security appliances; checked at
  BarracudaCentral [11].
- **SpamCop**, **SORBS**, and other RBLs — secondary but worth a multi-list sweep.

### 4.2 How to monitor

- **Multi-blocklist checker** — query Spamhaus, Barracuda, SpamCop and others simultaneously (via DNSBL
  lookups) on a schedule, for **every `sending_domain`, its sending IPs, and its per-tenant tracking domain**
  [11].
- **Cadence:** scheduled background sweep (TruePoint runs it as a **`email_warmup`/deliverability-class job**
  on the existing BullMQ/Redis fan-out, D10) plus on-demand check from the admin surface.
- **Removal discipline:** **fix the root cause first** — submitting a delisting request before remediation
  results in an **escalated listing that is harder to remove** [11]. Removal timelines: Spamhaus SBL ~24–72h
  after proof of resolution; Barracuda ~12–24h [11].

### 4.3 Where it surfaces (cross-ref 10/11)

- A tenant's own domain/IP/tracking-domain listing → tenant **deliverability dashboard**
  (`10-web-surface.md`) as a high-severity alert with the list, the reason, and the remediation/delisting
  link.
- A **shared/platform resource** listing → **admin surface** (`11-admin-surface.md`) as a **platform
  incident** (ties to `truepoint-operations` runbooks). Because D3 forbids shared tracking domains, the main
  shared-resource exposure is a shared/pooled sending IP — handled under the Reputation Pool model in doc 07.

### 4.4 Provider ground-truth (not a blocklist, but the canonical reputation signal)

Beyond third-party blocklists, the **provider's own** postmaster signals are authoritative:

- **Google Postmaster Tools** — domain/IP reputation, spam rate, authentication pass rates, the **0.30% spam
  rate** measured here is the Gmail compliance metric (`§7`) [1][12].
- **Yahoo Sender Hub** — Yahoo's equivalent insights/metrics console [3][13].
- **Microsoft SNDS / JMRP** for Outlook/Hotmail.

> **P5 build mandate:** blocklist monitoring + provider-signal ingestion is part of P5 ("Deliverability +
> warmup + analytics … blacklist monitoring"). The scheduled sweep is a queue-backed job (D10); results feed
> `08-reporting-analytics.md` and the dashboards in `10`/`11`. No secret (e.g. Postmaster Tools API creds)
> reaches the client — secrets are **server-side, KMS-target (D7)**.

---

## 5. Seed-list inbox-placement testing

A **seed-list test** sends a campaign to a panel of **real inboxes** across providers and reports where it
landed — **Inbox vs Spam vs Promotions/Tabs** — plus authentication results. This is the only way to measure
**actual placement** before/while sending to real recipients; a clean SpamAssassin score does **not** predict
it (`§3`).

### 5.1 Tool comparison

| Tool | What it does | Seed-list placement? | Best for | Indicative price | Tradeoff |
|---|---|---|---|---|---|
| **GlockApps** | Seed-list inbox-placement testing across **115+ real inboxes** (Gmail, Outlook, Yahoo, regional); spam-score + auth checks; ongoing monitoring | **Yes** — true placement | Diagnosing where mail lands at major + regional providers | Free tier; paid ~$59–$129/mo [10] | Per-test cost; a sample, not full audience; no warmup |
| **MailReach** | Reputation/**warmup** tool + a spam test to a seed list of **40+ accounts** across Gmail/Outlook/Yahoo | **Yes** (smaller panel) + warmup | Cold/outbound teams improving placement **over time** via warmup | Spam test from ~$9.6/mo; warmup ~$25/mo [10] | Smaller seed panel; warmup-centric |
| **MailGenius** | **Content + authentication** analysis and AI copy suggestions | **No** — content/auth only, **not** real placement | Pre-send content/auth lint (`§3`) | ~$39/mo (annual) [10] | **Not** a placement test; don't mistake it for one [10] |
| **Mailtester / mail-tester** | SpamAssassin-style score + auth checks for a single message | No (single-message check) | Quick free pre-send sanity check | Free / low-cost | Single inbox, not a panel; rule-score only |
| **Validity Everest / Inbox Monitor** | Enterprise seed-list placement + reputation + Sender Score | **Yes** (enterprise) | Large senders wanting a managed deliverability suite | Enterprise pricing | Cost; heavier than TruePoint needs at MVP |

**Recommendation for TruePoint:** treat seed-list placement as a **measurement hook**, not a per-send gate.
Integrate a placement provider (GlockApps is the strongest dedicated placement tool with broad provider
coverage and an API [10]; MailReach is the better fit where **warmup** is the goal, which aligns with the
TruePoint **Warmup** concept and doc 07) as a **deliverability sampling job** that runs against a tenant's
Reputation Pool on a schedule and on warmup milestones, with results in the deliverability dashboard. Keep
**MailGenius/mail-tester** in the **content-lint** role (`§3`), explicitly **not** as placement.

> **P5 build mandate:** "seed/placement hooks" are a P5 deliverability deliverable. The integration is an
> **outbound, server-side** call (provider API key is a server-side secret, D7); results are stored against
> the `sending_domain`/Reputation Pool and rendered per the four-states rule in the dashboard.

---

## 6. Bounce classification and automated bounce → suppression

Bounces are the strongest negative reputation signal a sender controls, and the Gmail/Yahoo rules implicitly
punish them (high bounce rates drive complaints and spam-foldering). TruePoint must **classify** every bounce
and **automatically suppress** the permanent ones — this is the core automated loop that protects every
tenant's reputation and is the deliverability source of the `suppression_list` entity (doc 09).

### 6.1 Hard vs soft — classification

| Type | Meaning | Typical SMTP code | Action |
|---|---|---|---|
| **Hard bounce** | **Permanent** failure — address doesn't exist / domain invalid / blocked permanently | **5xx** (e.g. 550, 551, 552, 553) | **Suppress immediately; never retry** [14][15] |
| **Soft bounce** | **Temporary** failure — mailbox full, server busy, greylisting, transient filter | **4xx** (e.g. 421, 450, 451, 452) | **Limited retries** with backoff [14][15] |
| **Block bounce** | Provider-side block / policy rejection (often reputation/blocklist) | Varies (often 5xx) | **Investigate** — may indicate a `§4` listing [14] |

Two refinements that distinguish a robust implementation [14][15]:

- **Classify on the bounce message content, not just the numeric code.** Receiving servers don't follow the
  spec consistently — a 4xx can be effectively permanent and a 5xx can resolve on retry. The best ESPs parse
  the **DSN/bounce body**, not just the digit [14].
- **Soft → hard escalation:** convert a **persistently** soft-bouncing address to a hard bounce after a
  bounded number of attempts (industry practice: ~7–15, weighted by engagement) and then suppress [15].

### 6.2 The automated bounce → suppression loop (TruePoint)

1. The ESP/provider posts a **delivery/bounce webhook** to TruePoint (this webhook is established at **P1** —
   "Reputation isolation + send path (delivery/bounce webhook)"). The webhook **signature is verified** (a
   security non-negotiable — untrusted external input).
2. The handler resolves the bounce to its `email_send` (and thus tenant/workspace) and **classifies** it
   (`§6.1`).
3. A **hard bounce** (or escalated soft bounce) is processed by a **queue-backed, idempotent** worker (D5,
   D10 — `apps/workers/src/queues/email*.ts`) that **inserts a `suppression_list` row** keyed by the
   address (recipient), scoped to the appropriate tenant/workspace.
4. From that moment, **D4 — suppression gates every send, fail-closed** — no future `email_send` to that
   recipient can proceed (`§7` and doc 06 below).

Idempotency (D5) means a re-delivered webhook does **not** create duplicate suppressions or double-count.
**No PII in logs** — the bounce handler logs the `email_send` id and classification, not the recipient
address in plaintext.

> **P1 build mandate:** the delivery/bounce webhook + classifier ship in P1. The `suppression_list` write is
> the data-side output (doc 09 owns the columns); the queue is BullMQ/Redis with backoff + DLQ (D10). The
> bounce-rate metric feeds `08-reporting-analytics.md`. **Total bounce rate should be kept well under 2%**,
> tracking **hard and soft separately** [15].

---

## 7. The Google + Yahoo 2024 bulk-sender requirements (mandatory)

These are the rules that, as of **February 2024**, are **hard gates**, not best practices. Both apply to
**bulk senders = anyone sending more than 5,000 messages/day** to Gmail / Yahoo addresses respectively
[1][2][16]. TruePoint's design satisfies each by construction; this section is the authoritative checklist
the whole subsystem is measured against.

| Requirement | Gmail (Google) | Yahoo | TruePoint mechanism |
|---|---|---|---|
| **SPF + DKIM** | Both required for bulk senders | Both required | Per-`sending_domain` at **P0** (`§1`); DKIM ≥2048-bit |
| **DMARC** | Required, **min `p=none`** that passes | Required, **min `p=none`** that passes | Published at P0; ramped to enforcement (`§1.2`) |
| **DMARC alignment** | `From:` domain **must align** with SPF **or** DKIM domain | Same | Relaxed alignment via tenant subdomain + aligned DKIM (`§1.2`) |
| **One-click unsubscribe (RFC 8058)** | Marketing/subscribed mail must support **one-click** unsubscribe + visible link; honor within **2 days** | Same; honor within **2 days** | `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers on every applicable send; full design in **doc 06** (D9) |
| **Spam complaint rate** | Keep **below 0.30%** (in Postmaster Tools); **never** spike to it | Keep **below 0.3%** | Monitored via Postmaster Tools / Sender Hub (`§4.4`); **target <0.1%** per guidance [16][17] |
| **Valid forward + reverse DNS (PTR)** | Sending domains/IPs need valid **forward and reverse DNS (PTR)** | Maintain valid forward + reverse DNS; non-dynamic-looking rDNS | Enforced at the sending-infra layer (doc 02); IPs/hosts have PTR |
| **TLS** | Use a **TLS connection** for transmission | (Standards compliance) | TLS on the SMTP transport (doc 02) |
| **Message format** | RFC 5322; don't impersonate Gmail `From:` | RFC 5321/5322 compliant | Templating renders compliant MIME (doc 01) |

Authoritative specifics, quoted from the providers' own guidance:

- **Gmail [1]:** *"Keep spam rates reported in Postmaster Tools below 0.30%."* *"For direct email, the domain
  in the sender's From: header must be aligned with either the SPF domain or the DKIM domain."* *"Ensure that
  sending domains or IPs have valid forward and reverse DNS records, also referred to as PTR records."* *"Use
  a TLS connection for transmitting email."* The one-click headers must be present: `List-Unsubscribe-Post:
  List-Unsubscribe=One-Click` and `List-Unsubscribe: <https://…/unsubscribe/…>`.
- **Yahoo [3]:** implement **both SPF & DKIM** and publish a passing DMARC policy of **at least `p=none`**;
  ensure the `From:` domain **aligns** with SPF or DKIM; support **one-click unsubscribe via RFC 8058** and
  honor removals **within 2 days**; **keep spam rate below 0.3%**; maintain valid forward/reverse DNS;
  comply with RFCs 5321/5322.
- **Threshold nuance [16][17]:** 0.30% is the **fail** line; **0.1% is the danger line** — best practice is
  to keep complaints **well under 0.1%** and never let them approach 0.3%, because at 0.3% you are "in real
  trouble." Enforcement is **gradual and progressive**, and failing mail is either **bounced with an error
  code** or **spam-foldered** [16].

The **one-click unsubscribe (RFC 8058)** is owned end-to-end by **doc 06 (compliance)** and **D9** — this
doc asserts only that it is a **deliverability hard-gate** (its absence on marketing mail directly violates
Gmail/Yahoo and tanks placement), and that the unsubscribe action **must write a `suppression_list`/
`consent_records` change that D4 then enforces on every subsequent send.**

> **Cross-phase mandate:** SPF/DKIM/DMARC + PTR + TLS land at **P0** (`§1`); the bounce/complaint feedback
> loop and `suppression_list` write at **P1** (`§6`); one-click unsubscribe with the RFC 8058 headers at
> **P2/P3** with the send/templating path (enforced by D4, detailed in doc 06); deliverability dashboards +
> spam-rate/placement monitoring at **P5** (`§4`, `§5`).

---

## 8. Suppression handling (ties to D4 and doc 06)

Suppression is the **deliverability output that becomes a hard send-gate**. The `suppression_list` entity
(doc 09) is populated from several deliverability sources and is then enforced **fail-closed** on every send.

### 8.1 What feeds `suppression_list`

| Source | Scope | Section |
|---|---|---|
| **Hard bounce** (and escalated soft bounce) | recipient (workspace/tenant) | `§6` |
| **Spam complaint** (feedback loop / CFL) | recipient | `§7`, doc 06 |
| **One-click unsubscribe (RFC 8058)** | recipient / list | doc 06, D9 |
| **Global compliance suppression** (GDPR objection / DPDP / CCPA opt-out) | global | doc 06 |
| **Manual / admin suppression** | tenant/workspace | doc 11 |

### 8.2 How it gates sends (D4, fail-closed)

Per **D4**, the suppression check runs **inside the send transaction**, not as a pre-guard — there is **no
code path** that can issue an `email_send` to a suppressed address. This mirrors the platform's existing
in-transaction suppression pattern (the List-tab/`assertNotSuppressed` model in
`docs/planning/list-plan/08-security-compliance.md §6`): the gate is **unbypassable** and **fail-closed** —
if the suppression check cannot be conclusively evaluated, the send **does not proceed**. Matching is done by
the **same normalized/blind-indexed key** the rest of the platform uses, never plaintext PII (consistent with
the encryption-at-rest and blind-index posture the platform already runs).

This is also where deliverability meets **multitenancy (D2, doc 07)**: suppression scope respects the
tenant/workspace boundary (RLS-enforced — `tenant_id` always, `workspace_id` where workspace-scoped,
`ENABLE + FORCE`, fail-closed `NULLIF`), **except** global compliance suppressions which apply across all
tenants. The full suppression compliance contract — consent, CAN-SPAM, GDPR/DPDP, DSAR cascade removing a
subject's suppression/consent rows — lives in **doc 06**; this doc only establishes the deliverability inputs
and the D4 gate.

> **Phase mapping:** the `suppression_list` write path opens at **P1** (bounce-driven, `§6`); one-click
> unsubscribe and the full compliance suppression model land with **doc 06** across P2–P3; admin/global
> suppression management is **P6** (`11-admin-surface.md`).

---

## 9. The deliverability dashboard (cross-ref 10 + 11)

Deliverability is only as good as its **observability**. TruePoint surfaces a **deliverability dashboard** in
two places, per the precedence that design owns *what renders* and platform/data own the signals:

- **Tenant deliverability dashboard** (`10-web-surface.md`, **owner-scoped per D8**): per–Reputation-Pool
  authentication status (SPF/DKIM/DMARC/BIMI verified?), DMARC policy progress (`none → quarantine →
  reject`), spam-complaint rate vs the **0.3% / 0.1%** lines (`§7`), bounce rate (hard vs soft, `§6`),
  blocklist status (`§4`), and latest seed-list placement (`§5`). Built from `@leadwolf/ui` with the
  **four states** (loading/empty/error/data), WCAG 2.2 AA, light theme, i18n; large tables virtualized
  (TruePoint design constraints).
- **Admin/staff deliverability + monitoring** (`11-admin-surface.md`): cross-tenant blocklist sweep results,
  shared-resource (pooled IP) reputation, platform-wide bounce/complaint trends, and incident triggers
  (ties to `truepoint-operations`). Staff visibility follows the platform's privacy-first staff model —
  metadata/aggregate by default; record-level recipient detail requires the audited break-glass path, not
  casual browsing.

The metrics themselves are computed and stored per **`08-reporting-analytics.md`** (this doc names the
deliverability metrics; doc 08 owns their aggregation/retention). Per **D6**, **opens are shown as
informational context, never as a deliverability KPI** (Apple MPP inflation, `§2.3`,
`04-status-event-tracking.md`).

### 9.1 Compliance-metrics visibility

The Gmail/Yahoo bulk-sender rules (`§7`) are not just controls to *implement* — they are controls TruePoint
must be able to **prove it is meeting**, continuously, per tenant. The deliverability dashboards therefore
surface a small set of **compliance-coverage metrics** that turn the `§7` checklist into observable
percentages and latencies. These are distinct from placement/bounce metrics: they measure **whether the
mandatory mechanisms are actually present and honored on real traffic**, which is exactly what a provider
audit (or our own counsel) will ask for.

| Compliance metric | What it measures | Target | Source | Surface |
|---|---|---|---|---|
| **List-Unsubscribe header coverage** | % of applicable sends carrying **both** `List-Unsubscribe` **and** `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) headers | **100%** of marketing/applicable mail (`§7`) | `sendStep` send-tx footer/header injection (D9, doc 06); counted off the engagement `activities` (`email_sent`) + send-log signal | Tenant dashboard (`10`) + admin monitoring (`11`) |
| **One-click-honor latency** | Time from a one-click unsubscribe POST to the resulting `suppression_list` row being live and gating sends (`§8.2`) | **Well inside the Google/Yahoo 2-day requirement** (`§7`) — alert at p95 approaching the limit | `audit_log` `unsubscribe` → `suppression.add` event pair (D5 idempotent); the unsubscribe→suppression write loop | Tenant dashboard (`10`) + admin monitoring (`11`) as a latency SLO |
| **Consent-capture rate** | % of recipients (or enrolled `outreach_log` contacts) that have a current, non-withdrawn `consent_records` row with a valid `lawful_basis` for the send jurisdiction | High coverage; **low-consent cohorts flagged** before they become a complaint-rate problem (`§7`) | `consent_records` (D9; `valid_from`/`valid_until`/`withdrawn_at`, `jurisdiction`, `lawful_basis`) joined against the audience | Tenant dashboard (`10`) + admin monitoring (`11`) |

The same precedence applies: **doc 08 owns the aggregation/retention** of these three metrics (they are
computed and stored there, not invented in the UI), and **design owns how they render** — the dashboard shows
each as a coverage gauge / latency tile against its threshold, with the **four states** and the
admin/staff variant rolling them up **cross-tenant** so operations can spot a tenant whose header coverage
slips below 100% or whose honor latency drifts toward the 2-day line **before** Gmail/Yahoo do. Per the
privacy-first staff model (`§9`), the admin view is **aggregate/metadata by default** — recipient-level
consent detail is the audited break-glass path, not casual browsing. One-click unsubscribe and the consent
model are owned end-to-end by **doc 06 (compliance)** and **D9**; this subsection only asserts that their
**operational coverage is a first-class, monitored deliverability signal** alongside placement and bounce.

---

## 10. Risks, tradeoffs, and open questions

| Risk | Why it's high | Mitigation |
|---|---|---|
| **Shared tracking domain contagion** | One spammer blacklists everyone (`§2.2`) | **D3** — per-tenant tracking domain, never shared; monitored on the blocklist sweep (`§4`) |
| **Pooled sending IP/domain coupling** | A bad tenant on a shared IP taints the pool | **D2 / doc 07** — per-tenant Reputation Pool; isolate or move offenders; admin incident path (`§4.3`) |
| **Premature DMARC `p=reject`** | Drops legitimate forwarded mail | Mandatory `p=none` monitoring period + ARC before enforcement (`§1.2`) |
| **Over-reliance on spam scores** | A 10/10 SpamAssassin score ≠ inbox | Combine content lint + seed-list placement + provider ground-truth (`§3.2`) |
| **Complaint rate creeping toward 0.3%** | Hard Gmail/Yahoo fail line | Monitor against the **0.1% danger line** (`§7`); one-click unsubscribe + suppression hygiene |
| **Unverified bounce webhook** | Spoofed suppression / poisoning | Verify webhook signature; idempotent processing (D5); no PII in logs (`§6.2`) |

**Open questions** (to confirm before/at P5):

- **VMC vs CMC default** for BIMI — recommend tenant-owned VMC for trademark holders, CMC as the
  no-trademark path (`§1.4`); confirm whether TruePoint assists with issuance or stays hands-off.
- **Seed-list provider selection** — GlockApps (broad placement coverage + API) vs MailReach (warmup-aligned)
  vs an enterprise suite (Validity); pick at P5 against the warmup design in doc 07 (`§5`).
- **Soft→hard escalation thresholds** — the exact retry count and engagement weighting (`§6.1`) need tuning
  against real provider behavior and the queue retry/backoff budget (D10).
- **Per-tenant FinOps** — seed-list tests and VMC certificates are **metered costs**; per-tenant quota/cap
  applies (`truepoint-operations`), and these are currently in the "per-tenant quota gates unwired" gap.

---

## 11. Cross-references

- `00-overview.md` — Locked Decisions **D1–D10**, Shared Vocabulary, Canonical Entities, Phase Map (P0–P6).
- `02-sending-infrastructure.md` — the send path, ESP/provider strategy (D1 hybrid), TLS/PTR at the transport.
- `04-status-event-tracking.md` — open/click events, the **Apple MPP** treatment behind D6 (`§2.3`, `§9`).
- `06-compliance.md` — **RFC 8058 one-click unsubscribe**, consent, CAN-SPAM, GDPR/DPDP, the full
  `suppression_list`/`consent_records` compliance model and DSAR cascade (D9; `§7`, `§8`).
- `07-multitenancy-reputation-isolation.md` — per-tenant **Reputation Pool**, **Warmup**, dedicated-IP
  isolation (D2; `§2`, `§4`, `§5`).
- `08-reporting-analytics.md` — deliverability metric aggregation/retention (`§9`).
- `09-data-model.md` — `sending_domain`, the logical `email_send` role, `activities` / `email_event`, `suppression_list` schema,
  RLS, tenant-leading indexes.
- `10-web-surface.md` / `11-admin-surface.md` — tenant and staff deliverability dashboards (`§9`).
- `docs/planning/list-plan/08-security-compliance.md` — the in-transaction, fail-closed suppression pattern
  TruePoint already runs (`§8.2`).

---

## Sources

1. Google Workspace Admin Help — *Email sender guidelines* (5,000+/day bulk sender requirements): https://support.google.com/a/answer/81126
2. Mailgun — *Yahoogle: New Bulk Sender Requirements in 2024*: https://www.mailgun.com/state-of-email-deliverability/chapter/yahoogle-bulk-senders/
3. Yahoo Sender Hub — *Sending best practices / 2024 requirements*: https://senders.yahooinc.com/best-practices/
4. PowerDMARC — *DMARC Alignment Explained: Strict vs Relaxed Modes*: https://powerdmarc.com/dmarc-alignment/
5. Valimail — *What is DMARC alignment (strict vs relaxed)*: https://www.valimail.com/blog/what-is-dmarc-alignment/
6. BIMI Group — *Verified Mark Certificates (VMC) and BIMI*: https://bimigroup.org/verified-mark-certificates-vmc-and-bimi/
7. DigiCert — *BIMI setup guide for VMC and CMC*: https://www.digicert.com/blog/bimi-setup-guide-for-vmc-and-cmc
8. GMass — *What Is a Custom Tracking Domain and How Does It Improve Email Deliverability?*: https://www.gmass.co/blog/tracking-domain/
9. Instantly — *What Is a Custom Tracking Domain? / tracking pixels and deliverability*: https://instantly.ai/blog/what-is-a-custom-tracking-domain/
10. Saleshandy — *Top GlockApps Alternatives for Spam Testing* (GlockApps / MailReach / MailGenius comparison): https://www.saleshandy.com/blog/glockapps-alternative/
11. CaptainDNS — *Spamhaus vs Barracuda vs SpamCop: Comparison* (SBL/XBL/PBL/DBL/ZRD, removal timelines): https://www.captaindns.com/en/blog/spamhaus-barracuda-spamcop-comparison
12. Spamhaus — *Spamhaus Blocklist (SBL)*: https://www.spamhaus.org/blocklists/spamhaus-blocklist/
13. EmailLabs — *Yahoo Sender Hub "Insights": Understanding the New Metrics*: https://emaillabs.io/en/yahoo-sender-hub-insights-understanding-the-new-metrics/
14. SMTP2GO — *Understanding Hard Bounces, Soft Bounces, and Rejected Emails* (SMTP codes, content-based classification): https://www.smtp2go.com/blog/understanding-hard-bounces-soft-bounces-and-rejected-emails/
15. EmailVerifierAPI — *Soft Bounce vs Hard Bounce: SMTP Codes, Recovery Rules* (4xx/5xx, soft→hard escalation, <2% target): https://emailverifierapi.com/blog/soft-bounce-vs-hard-bounce/
16. Puzzle Inbox — *Google and Yahoo 2024 Bulk Sender Requirements* (5,000/day definition, gradual enforcement): https://puzzleinbox.com/blog/cold-email-bulk-sender-requirements-2024
17. Resend — *Gmail and Yahoo's bulk sending requirements for 2024* (0.3% / 0.1% danger line): https://resend.com/blog/gmail-and-yahoo-bulk-sending-requirements-for-2024
