# Email — Sending Infrastructure (02)

> **Status:** Plan (not yet built). **Owner:** Platform + Data + Security. **Last updated:** 2026-06-24.
> This is Doc #3 of the `docs/planning/email-planning/` set. It cites the **Locked Decisions (D1–D10)**,
> **Shared Vocabulary**, **Canonical Entities**, and **Phase Map** owned by `00-overview.md` and
> `13-rollout-phases.md` — and never contradicts them. Where this doc references schema (`mailbox_integration`,
> `sending_domain`, `email_send`), the column-level contract is owned by `09-data-model.md`; here we describe
> behaviour, not DDL. Deliverability mechanics (SPF/DKIM/DMARC, bounce/complaint loops, MPP) are owned by
> `03-deliverability.md`; reputation isolation by `07-multitenancy-reputation-isolation.md`; queues by the
> shared queue contract referenced throughout. **No code** — entity/column names, endpoint paths, and queue
> names only.

---

## 1. What this document decides

The "sending infrastructure" is the layer that turns a rendered message (`01-templating.md`) into bytes on the
wire and a row in `email_send`. It answers one question for every send: **which credential, on which domain,
through which provider, at what rate, charged to whom.** Get this wrong and nothing downstream matters —
the most carefully-segmented sequence (`05`) lands in spam.

This doc is **prescriptive**. For each sub-topic it gives the **best-in-class approach** (what Outreach,
Salesloft, Apollo, Instantly, Smartlead, Lemlist actually do in 2024–2026), the **recommended choice for
TruePoint**, and the **tradeoffs**. It anchors on **D1 — the hybrid provider strategy** and is the
operational spine of phases **P0 / P1 / P5** in the Phase Map.

### 1.1 The single anchoring decision — D1 (hybrid), restated

> **D1 — Hybrid provider strategy.** TruePoint sends across **two physically separate worlds** that must never
> share IPs, domains, or reputation:
>
> | World | Stream | How it sends | Used for |
> |---|---|---|---|
> | **Mailbox world** | 1:1 sales / cold outreach | The tenant's own **Google / Microsoft mailbox** via **OAuth + Gmail/Graph API** (SMTP fallback) | Sequences, 1:1 sales mail — the seller's real inbox, the seller's reputation |
> | **Platform world** | System + bulk (permissioned) | **Amazon SES** as the default backbone; **Postmark** for system/transactional mail; **SendGrid / Mailgun** as alternates | Password resets, invites, digests, notifications, permissioned broadcast |
>
> **NO shared-IP bulk cold outreach exists in either world.** We never push a tenant's cold sequence through a
> TruePoint-owned shared pool — that is the Instantly/Smartlead failure mode (§4.2) and it pools every tenant's
> reputation risk into one bucket, which violates **D2 — reputation isolation per-tenant**.

Everything below is the elaboration of that table.

---

## 2. Dedicated vs shared IPs

### 2.1 The mechanics

A **shared IP** is one address (or pool) that many senders transmit from; the receiving provider (Gmail,
Outlook, Yahoo) scores reputation partly at the IP level, so a noisy neighbour's complaints depress everyone's
inbox placement. A **dedicated IP** is yours alone — full control, full blame. Dedicated IPs require **warmup**
(§3): a cold IP with no history is treated as suspicious, and a sudden burst from a never-seen IP looks like a
hijacked relay.

### 2.2 When each — volume thresholds (best-in-class)

The industry rule of thumb in 2024–2026: a dedicated IP only earns its keep above **roughly 100k–250k consistent
sends/month** *on that IP*, because reputation is a function of **steady volume** — too little mail and the IP
never accumulates enough signal, so it actually performs *worse* than a well-run shared pool. Postmark gates its
dedicated-IP add-on to senders doing **300k+ emails/month** for exactly this reason ([Postmark pricing](https://postmarkapp.com/pricing)).
SES echoes the same logic: standard dedicated IPs are for senders who can keep them warm, and below that they
recommend the shared pool or managed dedicated IPs (which auto-warm) ([SES dedicated IP docs](https://docs.aws.amazon.com/ses/latest/dg/dedicated-ip.html)).

| Scenario | Use | Why |
|---|---|---|
| Low/spiky platform volume (most new tenants) | **Shared pool** (SES/Postmark default) | Not enough volume to keep a dedicated IP warm; you'd hurt yourself |
| High, *steady* platform/broadcast volume (>~100k–250k/mo, sustained) | **Dedicated IP** (or SES managed dedicated) | Insulates a big tenant from the shared pool and vice versa |
| Cold 1:1 sales (mailbox world) | **N/A — no IP decision** | Google/Microsoft own the IP; we send through the mailbox (§6) |

### 2.3 Recommended for TruePoint

- **Mailbox world (cold/sales):** there is **no IP to manage** — the message leaves Google's or Microsoft's
  infrastructure on *their* IPs, under *their* reputation, which is the entire deliverability advantage of the
  mailbox model. This is why D1 routes cold here and **not** through any TruePoint pool.
- **Platform world (SES backbone):** start every tenant on the **SES shared pool** (default). When a single
  tenant's *permissioned* platform/broadcast volume crosses the sustained threshold, promote them to a
  **dedicated IP** (modelled as the optional dedicated-IP field of their Reputation Pool — see `07`). Prefer
  **SES managed dedicated IPs** so AWS handles warmup automatically (§3.5).
- **Tradeoff accepted:** a dedicated IP is a standing cost (§7) and an operational liability (it must stay
  warm), so we only assign one when sustained volume justifies it — gated by an admin action in `11`, never
  automatic.

---

## 3. IP + domain warmup

### 3.1 What warmup is (Shared Vocabulary)

**Warmup = gradual volume ramp.** A brand-new sending identity (IP and/or domain/mailbox) has no reputation;
sending at full volume on day one looks like a compromised account. Warmup raises volume over days/weeks while
generating positive engagement, so receivers learn the sender is legitimate.

There are **two things to warm**, and TruePoint cares about both:
1. **The mailbox + its sending domain** (mailbox world) — the dominant case for cold sales.
2. **The sending IP** (platform world, only when dedicated).

### 3.2 Typical ramp schedule (2024–2026 norm)

A conservative new-mailbox ramp, consistent across Smartlead, Mailreach, and SMTP2GO guidance in 2025–2026
([Smartlead — sending frequency](https://www.smartlead.ai/blog/email-frequency-best-practices-for-cold-emails),
[Mailreach — emails/day](https://www.mailreach.co/blog/how-many-cold-emails-to-send-per-day)):

| Window | Warmup volume/day | Live cold sends/day | Note |
|---|---|---|---|
| Days 1–3 | 20–40 | 0 | warmup only, no live campaigns |
| Days 4–7 | 40–60 | 10–20 (to safe addresses) | begin trickling real mail |
| Days 8–14 | 60–80 | 30–60 | ramp live volume |
| Days 15–21 | 60–80 | 80–150 (split across mailboxes) | reaching steady state |

**A full warmup is 2–4 weeks.** The takeaway that drives §5: **to scale volume you add mailboxes, not raise
per-mailbox volume** — every mailbox stays inside its safe window forever.

### 3.3 Per-mailbox steady-state cold limits

Independent of warmup, the **steady-state cold limit per mailbox is far below the provider's hard cap.** 2025
data: the optimal cold window is **~20–49 sends/mailbox/day** (Woodpecker's 2025 data cites ~20–49/day for a
5.7% reply rate); Gmail mailboxes staying **under ~40/day** hold inbox-placement above 85%; **going above ~50/day
triggers spam filters** and causes slow, painful reputation damage ([Smartlead — sending frequency](https://www.smartlead.ai/blog/email-frequency-best-practices-for-cold-emails),
[Topo — safe sending limits](https://www.topo.io/blog/safe-sending-limits-cold-email)). The conservative default
TruePoint should ship is **30–50 cold sends/mailbox/day**, configured per mailbox and **enforced in-queue** (§9),
not by client honesty.

### 3.4 Automated warmup pools — how they work, and the risks

Tools like **Instantly, Smartlead, Mailreach, and Warmup Inbox** run a **warmup pool / network**: your mailbox
joins a pool of thousands of other mailboxes that **exchange contrived "real" emails** with each other —
auto-opening, auto-replying, and **rescuing each other's mail out of spam** — to manufacture positive engagement
signals for receiving providers ([Mailreach — Instantly warmup review](https://www.mailreach.co/blog/instantly-warmup-review),
[BuzzLead — best warmup services 2026](https://www.buzzlead.io/blogs/best-email-warmup-services-2026-the-definitive-tactical-guide)).

**The criticism is serious and well-documented (2024–2026):**

- **Pooled reputation tax.** When your domain trades signals with thousands of unknown senders, **spammy
  participants' reputation leaks into yours.** Across r/coldemail in 2024–2025, the repeated pattern is: move
  mailboxes into Instantly's *default shared* warmup → **open rates drop 30–40% within two weeks**
  ([Mailreach — Instantly warmup review](https://www.mailreach.co/blog/instantly-warmup-review)).
- **Low-trust open networks.** Open pools admit free users, unverified senders, and questionable SMTP servers;
  receivers already recognise these low-trust interaction patterns, so warmup volume rises but **reputation stays
  flat or degrades.**
- **Wrong inbox mix.** Smartlead's network skews toward cheap "Custom SMTP" inboxes and away from real Google
  Workspace / Microsoft 365 inboxes — but **only signals from real Google/Microsoft inboxes meaningfully build
  B2B reputation**, so a pool dominated by SMTP boxes trains the wrong receivers
  ([Mailreach — Smartlead warmup alternatives](https://www.mailreach.co/blog/smartlead-warmup-alternatives)).
- **Recovery is brutal.** Once domain reputation slips, **recovery can take 6+ months, if it's possible at all.**
- **It is, arguably, gaming the receiver.** Manufactured engagement is something Google/Microsoft actively work to
  detect; a warmup strategy that depends on fooling them is structurally fragile.

### 3.5 Recommended for TruePoint

- **Warmup is real and we support it — but we do not run a shared cross-tenant pool.** A TruePoint-run open pool
  would (a) reproduce the failure mode above and (b) violate **D2** by pooling reputation across tenants.
- **Mailbox/domain warmup** is an **`email_warmup` queue (D10)** behaviour: a scheduled, per-mailbox ramp that
  raises that mailbox's effective daily cap over the ramp window (§9), optionally generating low-volume
  warmup traffic **within the tenant's own mailbox set** (peer-to-peer inside one Reputation Pool — never across
  tenants). The ramp schedule (§3.2) is the default; admins tune it in `11`.
- **IP warmup (platform world):** prefer **SES managed dedicated IPs**, which AWS warms **automatically per IP
  using an adaptive, per-ISP strategy** ([SES pricing](https://aws.amazon.com/ses/pricing/),
  [SES dedicated IP docs](https://docs.aws.amazon.com/ses/latest/dg/dedicated-ip.html)) — we should not
  hand-roll IP warmup when the backbone provider does it better.
- **Tradeoff accepted:** without a shared pool, a brand-new tenant mailbox warms more slowly than an
  Instantly-style network would *appear* to. We treat that as a **feature** — durable reputation over a fast,
  fragile signal — and document the expectation in the admin surface (`11`).

---

## 4. Sending pools and rotation

### 4.1 The Reputation Pool (Shared Vocabulary)

A **Reputation Pool = a tenant's `sending_domain`(s) + its `mailbox_integration` set (+ optional dedicated IP).**
This is the unit of isolation in **D2** and the unit `07` governs. Rotation happens **inside** a pool, never
across tenants.

### 4.2 Why we do not pool across tenants

A cross-tenant sending pool is exactly the architecture this doc rejects. Two structural reasons:

- **Reputation contagion.** As Postmark/Mailgun's own behaviour shows, shared IP pools mean **one tenant's spam
  complaints downgrade the whole pool's reputation at Gmail/Microsoft** — which is precisely why Postmark
  enforces opt-in so aggressively ([Puzzle Inbox — Postmark vs Mailgun for cold email](https://puzzleinbox.com/blog/postmark-vs-mailgun-cold-email-2026)).
  D2 forbids us from inflicting that on tenants.
- **Blast radius.** A pooled architecture means one bad actor can get the **shared** identity blocklisted,
  taking every tenant down. Per-tenant pools bound the blast radius to one tenant — the same backpressure-bounds-
  fan-out discipline the queue contract requires.

### 4.3 Rotation within a pool (best-in-class)

Multi-mailbox tools rotate sends across the mailboxes in a campaign so **no single mailbox exceeds its safe daily
window** (§3.3) while the campaign as a whole achieves higher throughput. Lemlist, Smartlead, Instantly, and
Apollo all do per-mailbox round-robin / weighted rotation. TruePoint does the same **inside one Reputation Pool**:
the `email_send` queue picks the next eligible `mailbox_integration` (under its cap, warmed, not suppressed,
healthy) for each enrolled recipient.

### 4.4 Recommended for TruePoint

- **Rotation key = the Reputation Pool.** The `email_send` worker selects a mailbox from the pool by a fair,
  cap-aware policy (least-recently-used among under-cap mailboxes), records the chosen `mailbox_integration` on
  the `email_send` row, and **never** crosses into another tenant's pool.
- **Health-aware:** a mailbox with rising bounce/complaint rates (signals from `03`) is **down-weighted or
  benched** by the rotation policy before it poisons the rest of the pool.
- **Tradeoff:** rotation adds scheduling complexity and makes per-mailbox accounting essential — handled by the
  in-queue throttle state (§9).

---

## 5. Multi-mailbox / multi-domain rotation

### 5.1 The core scaling law

**You scale cold volume by adding mailboxes and domains, not by raising per-mailbox volume.** The §3.3 limits are
hard ceilings on what one mailbox can safely do; the *only* safe way to send 1,000 cold emails/day is to spread
them across **~20–30 mailboxes** at 30–50 each ([Smartlead — sending frequency](https://www.smartlead.ai/blog/email-frequency-best-practices-for-cold-emails),
[Mailwarm — warmup schedule to 1000/day](https://www.mailwarm.com/blog/email-warmup-schedule-emails)). This is the
single most important operational fact in cold outreach and it drives the whole data model: `mailbox_integration`
is **many-per-tenant**, and a tenant attaches **multiple `sending_domain`s** so volume can fan across them.

### 5.2 Best-in-class pattern

Modern stacks provision **many cheap domains** (e.g. `acme-mail.com`, `getacme.io`, `acmehq.co`) each with a few
mailboxes, all warmed, all rotated — keeping any one domain's footprint small so a single domain getting flagged
doesn't sink the campaign. The primary corporate domain is usually **kept out** of cold sending to protect it.

### 5.3 Recommended for TruePoint

- The data model supports **N `mailbox_integration` ↔ M `sending_domain`** within one tenant Reputation Pool.
  Rotation (§4.3) spreads a campaign across all eligible mailboxes/domains in the pool.
- **Per-tenant + per-mailbox caps are enforced together** (§9): the tenant has a pool-level daily budget; each
  mailbox has its own §3.3 cap; the queue respects the **tighter** of the two.
- **Tradeoff / honesty:** multi-domain rotation is a legitimate scaling tool **and** a technique abusers use to
  evade reputation tracking. `06-compliance.md` and `07` govern the line — every domain still carries proper
  auth (`03`), real consent (`D9`), and suppression gating (`D4`); we are not building an evasion tool.

---

## 6. SMTP vs API sending

### 6.1 The tradeoff (2024–2026)

| Dimension | **API** (Gmail API, MS Graph, SES/SendGrid/etc. REST) | **SMTP** |
|---|---|---|
| Throughput | Higher; ~5–10× SMTP with connection pooling + async | Capable with persistent connections + pipelining, but handshake overhead per session |
| Latency | Lower for single sends (no handshake); top transactional APIs ~<200ms p50 | Handshake + auth + confirmation per message adds latency |
| Error feedback | **Fail-fast** — invalid recipient / rate-limit / bad field returned immediately | Errors are **delayed and cryptic** — often arrive as bounces hours later |
| Features | Native tracking, templating, metadata, scheduling, idempotency hooks | Bare transport; tracking/analytics must be bolted on |
| Compatibility | Provider-specific SDK/contract | Universal; works with anything |
| Setup | Per-provider integration | One protocol, trivial config |

Source: [Mailgun — SMTP vs API](https://www.mailgun.com/blog/email/difference-between-smtp-and-api/),
[MailerToGo — email API benchmarks 2025](https://resources.mailertogo.com/statistics/email-api-performance-benchmarking-statistics-2025).

### 6.2 Recommended for TruePoint

- **Mailbox world: API-first.** Prefer **Gmail API** and **Microsoft Graph sendMail** over SMTP — better
  throughput, fail-fast errors that map cleanly to `email_send` status, and richer metadata. **SMTP (OAuth XOAUTH2)
  is the fallback** for mailboxes/providers where API access isn't available, captured as a capability flag on
  `mailbox_integration`.
- **Platform world: API.** SES/Postmark/SendGrid/Mailgun all expose APIs; we use the API for fail-fast handling
  and webhook-based events (`04`), reserving SMTP only as a contingency.
- **Tradeoff accepted:** API-first means per-provider adapters in `packages/integrations/` (one each for Gmail,
  Graph, SES, Postmark, …). That's more code than "just SMTP everywhere", but the fail-fast error mapping and
  native event hooks are worth it — and `D5 — sends idempotent` is far easier to honour against an API that
  echoes a provider message-id than against fire-and-forget SMTP.

---

## 7. Provider matrix — which provider for which job, and why

All four platform providers are best-in-class; the **job** decides which one. Pricing/positioning below is
current as of June 2026 — **verify at build time** since ESP pricing moves.

| Provider | Best for (the job) | Deliverability / positioning | Cost (current) | Tradeoffs |
|---|---|---|---|---|
| **Google / Microsoft mailbox** (OAuth + API) | **1:1 sales & cold outreach** (D1 mailbox world) | Sends on Google/Microsoft IPs under the seller's own reputation — best possible B2B inbox placement | No per-send ESP fee; cost is the seat the tenant already pays Google/MS | Hard per-mailbox caps (§7.1); scale = more mailboxes (§5); OAuth token lifecycle to manage |
| **Amazon SES** | **Default platform/system backbone + permissioned bulk** | Strong; you own deliverability via your own warmed identities; managed dedicated IPs auto-warm | **$0.10 / 1,000 emails** (per recipient); standard dedicated IP **$24.95/mo**; managed dedicated IP **$15/mo + $0.08/1k** (≤10M), $0.04/1k (10–50M), $0.02/1k (50–100M); attachments **$0.12/GB** | Most "build-it-yourself" — you own reputation, suppression, warmup config; thinnest hand-holding |
| **Postmark** | **System / transactional mail** (resets, invites, receipts, alerts) | **Best-in-class transactional deliverability**; separates Transactional vs Broadcast Message Streams so they never share IP ranges | From **$15/mo for 10k emails** (Basic, $1.80/1k overage); Pro $16.50/mo ($1.30/1k); dedicated IP **$50/mo** add-on (300k+/mo senders) | **Cold outreach is banned** and enforced — accounts suspended within days; use it *only* for system mail |
| **SendGrid** (Twilio) | **Alternate bulk / high-volume platform** | Mature, scales high; shared-pool reputation is variable unless on a dedicated IP | Free 60-day trial (100/day); **Essentials from $19.95/mo** (50k–100k); **Pro from $89.95/mo** (100k–2.5M, incl. 1 dedicated IP); extra dedicated IP **$30/mo** | Shared-pool deliverability variable; more config surface; pricing climbs at scale |
| **Mailgun** | **Alternate transactional/bulk; developer-centric** | Solid; shared-pool caveats like SendGrid | Free 100/day; **Basic $15/mo** (10k); Foundation $35/mo (50k, 1 dedicated IP); Scale $90/mo (100k); Flex pay-as-you-go **$2/1k**; extra dedicated IP **$59/mo** | Flex rate doubled (Dec 2025); dedicated IP is the priciest of the matrix; add-ons inflate the base plan fast |

Sources: [SES pricing](https://aws.amazon.com/ses/pricing/) ·
[SES dedicated IP docs](https://docs.aws.amazon.com/ses/latest/dg/dedicated-ip.html) ·
[Postmark pricing](https://postmarkapp.com/pricing) ·
[Postmark — bulk/Broadcast streams](https://postmarkapp.com/support/article/can-i-send-bulk-emails) ·
[Twilio SendGrid pricing](https://www.twilio.com/en-us/products/email-api/pricing) ·
[Mailgun pricing](https://www.mailgun.com/pricing/).

### 7.1 Provider mailbox send caps (verify at build)

These are the **hard provider ceilings** the mailbox world must respect — TruePoint's safe cold limit (§3.3) sits
**far below** them on purpose:

| Provider | Hard cap (2025–2026) | Notes |
|---|---|---|
| **Google Workspace** (paid) | **2,000 messages/day**; **10,000 total recipients/day**; **500 external recipients/day** | Rolling 24h window; mail-merge cap 1,500; trial accounts 500 ([Google Workspace sending limits](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace)) |
| **Gmail (free @gmail.com)** | **500/day**, up to 500 recipients/day | Not for business cold sending ([Smartlead — Gmail limits 2026](https://www.smartlead.ai/blog/gmail-sending-limits)) |
| **Microsoft 365 / Exchange Online** | **10,000 recipients/day** per mailbox; 30 msgs/min; 500 recipients/message | Plus the new **Tenant External Recipient Rate Limit (TERRL)** since **April 2025**: tenant cap ≈ `500 × (non-trial email licenses^0.7) + 9,500`; trial tenants 5,000/day ([Exchange Online limits](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits), [MS — Tenant Outbound Email Limits](https://techcommunity.microsoft.com/blog/exchange/introducing-exchange-online-tenant-outbound-email-limits/4372797)) |

### 7.2 Recommended provider assignment (D1)

- **Cold/sales →** the tenant's **Google/Microsoft mailbox** (always). Never an ESP, never a shared pool.
- **System mail (resets, invites, receipts, security alerts) → Postmark** (Transactional stream) for its
  transactional reputation; **SES** is the acceptable default if we standardise on one backbone.
- **Permissioned bulk / digests → SES** (default backbone), with a **Postmark Broadcast stream** or
  **SendGrid/Mailgun** as alternates — chosen via a provider-adapter abstraction so the routing is config, not a
  rewrite.
- **`packages/integrations/` houses one adapter per provider** behind a common send interface; `packages/core/src/email/`
  decides *which* adapter a given `email_send` uses based on its stream (§8) and the tenant's Reputation Pool.

---

## 8. Transactional vs bulk vs cold-outreach separation — why we never mix streams

### 8.1 The principle

The three streams have **different consent bases, different complaint profiles, and different reputational
consequences**, so they must travel on **separate identities (domains/IPs/mailboxes) and separate provider
paths**. Mixing them lets a high-complaint stream (cold) poison a must-deliver stream (password resets), and a
single complaint spike can blocklist a shared identity. Postmark institutionalises this with **separate Message
Streams whose IP ranges never mix** ([Postmark — Message Streams](https://postmarkapp.com/message-streams)) — the
canonical best-in-class pattern.

| Stream | Consent basis | Identity | Provider (D1) | Why isolated |
|---|---|---|---|---|
| **Transactional / system** | Implicit (user action) | TruePoint platform domain | Postmark / SES | Must always deliver; cannot tolerate reputation drag |
| **Bulk (permissioned)** | Explicit opt-in (`consent_records`, D9) | Tenant marketing domain | SES (Postmark Broadcast / SendGrid / Mailgun alt) | Higher complaint rate than transactional; opt-out (RFC 8058) mandatory |
| **Cold / 1:1 sales** | Lawful basis per `06` | Tenant cold domains + mailboxes | Google/Microsoft mailbox | Highest complaint risk; must ride the seller's own reputation, isolated per §3.3 caps |

### 8.2 Recommended for TruePoint

- **Stream is a first-class property of every `email_send`** (owned by `09`); the send-path picks identity +
  provider from the stream, and the streams **cannot be reconfigured to share an identity** — that's a guarded
  invariant, not a UI option.
- **`D4 — suppression gates every send, fail-closed`** applies to all three; **`D9` consent** applies to bulk and
  cold; transactional is exempt from opt-out but still suppression-checked for hard bounces.
- **Tradeoff:** three streams mean more domains and more provider config per tenant. That cost is mandatory — it
  is the entire reason TruePoint's reputation survives one tenant's bad cold campaign.

---

## 9. TruePoint mapping — entities, queues, throttling, FinOps

This section binds the above to the real codebase and the constraints digest. It is the contract `09`, `10`,
`11`, and the queue layer implement.

### 9.1 Entities (owned by `09-data-model.md`)

| Entity | Role in sending | Key constraints (digest) |
|---|---|---|
| `mailbox_integration` | One connected Google/MS mailbox (or SMTP creds); carries OAuth tokens **server-side only (D7)**, per-mailbox daily cap, warmup state, health signals, API-vs-SMTP capability flag | `tenant_id` + `workspace_id` + `owner_user_id`; secrets **never on the client**, app-AES-GCM today / **KMS target (D7, known gap)** |
| `sending_domain` | A tenant domain used for sending; carries DNS-auth status (SPF/DKIM/DMARC — `03`), stream assignment | `tenant_id` (+ `workspace_id`); custom tracking domain per `D3` |
| `email_send` | One send attempt — records chosen mailbox/provider, stream, status; the idempotency unit (`D5`) | `tenant_id`-scoped; RLS **ENABLE+FORCE**, fail-closed `NULLIF`; tenant_id-leading index; idempotent via the existing **`idempotency_keys`** table (`UNIQUE(tenant_id, key)`, `D5`) — **not** a parallel email idempotency table |

All under **RLS ENABLE+FORCE, fail-closed `NULLIF`** with **`SET LOCAL` tenant GUCs**; workers set tenant context
per job. Files: `packages/db/src/schema/email.ts` + `rls/email.sql` + `repositories/emailRepository.ts`;
adapters in `packages/integrations/`; send/policy logic in `packages/core/src/email/`;
HTTP surface `apps/api/src/features/email/{routes.ts,index.ts}` on `/api/v1`.

### 9.2 Queues (D10) — `apps/workers/src/queues/email*.ts`

- **`email_send`** — the fan-out worker that selects a mailbox from the Reputation Pool (§4.3), renders, sends via
  the chosen adapter, and writes the `email_send` row. **Idempotent, at-least-once, backoff + DLQ**; backpressure
  **bounds the fan-out** so a 50k-recipient sequence cannot stampede a provider.
- **`email_warmup`** — drives the §3.2 ramp per mailbox, raising its effective cap over the warmup window;
  peer-to-peer warmup traffic stays **inside one tenant's pool** (§3.5).
- **`email_tracking`** and the **sequence-tick worker** (`apps/workers/src/queues/outreach.ts`, the M9
  `processOutreach → sendStep` driver that advances `outreach_log` along `outreach_steps`) — owned by `04` and
  `05`; named here only for completeness.

### 9.3 Throttling — enforced **in-queue**, per-tenant **and** per-mailbox (D10)

The queue is the **only** enforcement point; client-supplied limits are never trusted (security precedence —
inputs are untrusted). For each candidate send the `email_send` worker checks, and applies the **tightest**:

1. **Per-mailbox daily cap** — §3.3 (default 30–50 cold; warmup-scaled by `email_warmup`); hard provider ceiling
   §7.1 as the absolute upper bound.
2. **Per-tenant pool budget** — the sum the tenant is allowed across the pool that day.
3. **Provider rate windows** — e.g. Microsoft's 30 msgs/min, SES account send-rate — respected with backoff and
   **`Retry-After`-style** rescheduling, never a busy-loop.

Over-cap sends are **deferred** (rescheduled to the next window), not dropped — the job stays in a user-visible
state (queue contract: user-visible job states), surfaced in `10`.

#### 9.3.1 Where the per-mailbox counter lives — **Redis, not a hot DB row**

The per-mailbox daily cap is checked on **every** candidate send, so the counter is a **hot path** — the
single most-read, most-incremented value in the whole `email_send` worker. It must **not** live in a
`mailbox_integration` column that the worker locks `SELECT … FOR UPDATE` on each send: that turns one row into
a serialization point for an entire pool's fan-out and reproduces exactly the contention failure `15` (§ scaling
the send path) warns against. The `creditRepository` `FOR UPDATE` lock pattern is the right template **only** for
the per-tenant *quota/FinOps* counter (§9.4), where the value is money and the consistency requirement is
absolute. The per-mailbox throttle has a different shape and gets a different mechanism:

- **Authoritative count → a Redis counter, keyed per mailbox per window.** Key shape
  `email:cap:{tenant_id}:{mailbox_integration_id}:{yyyymmdd}` (the calendar day matching the provider's rolling
  window, §7.1), with a TTL that expires the key after the window rolls. The worker does an atomic `INCR` (or a
  small Lua check-and-increment) and compares against the mailbox's effective cap (§3.3, warmup-scaled by
  `email_warmup`). This is O(1), lock-free, and survives the fan-out of a 50k-recipient sequence.
- **Queue-local batch cache → fewer Redis round-trips.** When the `email_send` worker drains a batch for one
  pool it caps **claims a small budget** for each mailbox up front (e.g. reserve N slots with one decrement),
  spends them in-process across the batch, and **returns the unspent remainder** at batch end. This keeps the
  hot loop in process memory rather than hammering Redis per recipient, while the Redis counter stays the single
  source of truth across all worker replicas. A crashed worker simply lets its reserved-but-unspent slots expire
  with the key — the cap is a **safety ceiling, not a ledger**, so a small over-reservation on crash is
  acceptable (unlike the FinOps counter, which is not).
- **Reconciliation, not reliance.** The durable truth of *what actually sent* is the count of `email_send` rows
  for that mailbox/day; a low-priority reconcile (the same cadence as `04`'s event reconcile) corrects Redis
  drift. Redis is the **throttle**, `email_send` rows are the **record** — they are allowed to diverge briefly
  and never gate correctness, only rate.

This split — **Redis for the rate ceiling, `creditRepository` `FOR UPDATE` only for the money quota** — is the
load-bearing decision that lets one pool's fan-out scale without a hot row, and `15` owns the broader
worker-replica scaling contract.

### 9.4 FinOps — quota + hard cap + per-user limit on metered ESP sends

Only **platform-world ESP sends are metered spend** (SES/SendGrid/Mailgun bill per email, §7); mailbox-world cold
sends cost no ESP fee. So FinOps gates the **ESP path** (operations precedence — per-tenant FinOps
quota + cap + per-user limit on metered sends):

- **Per-tenant quota** on metered ESP sends/period, with a **hard cap** that fail-closes the ESP send-path when
  hit (a hard cap, not a soft warning).
- **Per-user limit** within the tenant, so one user can't burn the tenant's whole ESP budget.
- **Known gap (digest):** *per-tenant quota gates are currently unwired* — this doc makes wiring them a
  **P5/P6 deliverable** (`13`), not an assumption. The Reputation Pool admin surface (`11`) reads these
  counters; the cap is enforced in `packages/core/src/email/` before the adapter is invoked, so an exhausted
  tenant simply cannot dispatch a metered send.

### 9.5 Phase placement (Phase Map, owned by `13`)

| Capability | Phase |
|---|---|
| Mailbox connect (OAuth, secrets server-side) + `sending_domain` DNS auth | **P0 Foundations** |
| Reputation isolation + the `email_send` path (rotation, throttle, idempotency) | **P1** |
| Deliverability + **warmup** (`email_warmup`) + analytics | **P5** |
| Admin + governance (dedicated-IP promotion, FinOps cap wiring, pool admin) | **P6** |

Sending infrastructure therefore **spans P0 / P1 / P5** (and P6 for governance), exactly as the Phase Map states.

### 9.6 The `ProviderAdapter` interface — config-registered, realized through the existing `EmailSenderPort` seam

The send transaction already has a clean seam: `packages/core/src/outreach/sendStep.ts` sends through an injected
**`EmailSenderPort`** (`packages/core/src/outreach/senderPort.ts` — `send(OutboundEmail) -> { messageId }`), and
M9 ships `consoleSender` (dev) + `staticSender` (tests). The doc's whole multi-provider story (§7) lands **behind
that one seam** — we do **not** add a second send path. Concretely:

- **`EmailSenderPort` stays the contract `sendStep` depends on.** It does not change shape: the send transaction
  keeps calling `port.send(...)` and never learns which provider answered. This is the M9→M12 swap promised in
  `senderPort.ts`'s own header (the SES/mailbox adapter "replaces these at M12 **without touching the send
  transaction**").
- **A `ProviderAdapter` is the per-provider realization the port resolves to.** Shape (behaviour, not DDL — the
  envelope contract is owned by `09`):

  > `ProviderAdapter.send(mailbox, recipient, subject, body, headers) -> { providerMessageId, error }`

  where `mailbox` is the chosen **`mailbox_integration`** row (carrying the decrypted-server-side credential, the
  provider id, and the API-vs-SMTP capability flag, §6.2 / §9.1), `headers` carries the auth/tracking/list-unsub
  headers (`03`, `D3`), `providerMessageId` is the id the worker persists on the `email_send` row to honour `D5`,
  and `error` is the **structured** failure (§9.7) the backlog-recovery state machine consumes. The
  `EmailSenderPort.send(OutboundEmail) -> { messageId }` the M9 transaction sees is the **thin projection** of
  this richer adapter result (`providerMessageId → messageId`); the extra fields (`error`, provider rate signals)
  are read by the **worker**, outside the send tx, so the tx contract is unchanged.
- **Adapters are registered via config, not code — through the existing `apps/admin` Providers surface.** The
  pluggable registry's *home* is the already-built `apps/admin/src/features/provider-configs/` slice
  (`/provider-configs`, `ProviderConfigView{ provider, label, enabled, keyHint, rateLimitPerMin,
  monthlyBudgetCents, monthToDateCents, health }`). Enabling a provider, setting its `rateLimitPerMin` (which
  feeds §9.7's window), and toggling it on/off is an **admin config edit**, never a code deploy or a new adapter
  class — exactly the "routing is config, not a rewrite" property §7.2 commits to. The mailbox-world per-tenant
  credential is **not** an admin-global config row: it lives on the tenant's own **`mailbox_integration`**
  (server-side secret, `D7`), and the adapter reads it per send. Admin Providers governs the **platform-world**
  ESP roster + global rate/budget; `mailbox_integration` carries the **mailbox-world** per-tenant credential —
  the same two-world split as D1.
- **Selection chain (unchanged seam, new internals):** `packages/core/src/email/` picks the **stream** (§8) →
  picks the **provider** for that stream from the admin Providers registry (platform world) or routes to the
  tenant's mailbox (`mailbox_integration`, mailbox world) → resolves the matching `ProviderAdapter` in
  `packages/integrations/` → hands the `EmailSenderPort` to `sendStep`. The `email_send` row records which
  `mailbox_integration` / provider answered (§9.1).

`15` owns how the adapter registry stays open for the **next** provider (the extensibility contract); this doc
only fixes that new providers arrive as **config + one adapter behind the existing port**, never as a fork of the
send transaction.

### 9.7 Provider hard-rate-limit detection + backlog-recovery state machine

§9.3 throttles **proactively** — we stay under the §3.3/§7.1 ceilings so we rarely hit a provider's hard limit.
But providers move ceilings without notice (Microsoft's TERRL, §7.1, is the canonical 2025 example), so the
worker must also handle a **reactive** cap-hit: the provider itself returning 4xx/`Retry-After`. This is a
small **state machine per `mailbox_integration`**, driven by the structured `error` the `ProviderAdapter`
(§9.6) returns.

**Detection — parse the provider response, do not guess.** The adapter maps each provider's failure into a
structured `error` the worker can act on:

| Provider signal | Mapped meaning | Worker action |
|---|---|---|
| HTTP `429` + `Retry-After: <seconds/date>` | **Soft rate-limit** (window full) | Honour `Retry-After` exactly; reschedule the job to that instant (never busy-loop) |
| `429` / `403` with a per-mailbox quota body (Gmail `rateLimitExceeded` / `userRateLimitExceeded`; Graph `MailboxConcurrencyLimit`/`SubmissionQuotaExceeded`; SES `Throttling`/`Max send rate exceeded`) | **Hard per-mailbox cap-hit for the day** | Mark this `mailbox_integration` **capped** for the rest of its window; rotation (§4.3) stops selecting it; remaining recipients route to other under-cap mailboxes in the pool |
| Sustained `4xx` over the whole window / provider block notice / repeated TERRL rejects | **Multi-day block on the mailbox or sending_domain** | Move the mailbox to **blocked**; pause selection; signal the admin (§11); accumulate a **backlog** |
| `5xx` / transport | **Transient** | Normal queue backoff + DLQ (D10) — *not* a cap-hit; do not bench the mailbox |

**State machine per `mailbox_integration` (health state, surfaced in `11`):**

1. **`healthy`** — under cap, selectable by rotation.
2. **`throttled`** — a `Retry-After` is outstanding; the mailbox is selectable again at the `Retry-After` instant.
   No admin signal (this is normal).
3. **`capped`** — provider returned a per-mailbox daily cap-hit; **benched until the window rolls** (the §9.3.1
   Redis key TTL is the natural clock). Auto-recovers; no admin signal unless it recurs daily (a sign the §3.3
   cap is set too high).
4. **`blocked`** — sustained rejects / explicit provider block: a **multi-day** condition. The mailbox is
   benched, an **admin signal is raised** (`audit_log` entry + the `11` Reputation-Pool health surface +
   `/system-health` queue/SLO surface), and the recipients that could not send accumulate as a **backlog**
   against the pool. A `blocked` mailbox does **not** auto-unblock on a timer — an admin (or a successful probe
   send) clears it, because a multi-day block usually means a reputation problem `03` must resolve first.

**Backlog recovery — drain deliberately, never stampede.** When a `blocked`/`capped` condition clears, the
backlog is **not** flushed at once (a sudden burst after a block is exactly what re-trips the limit and looks
like a hijacked relay, §3.1). Instead:

- The backlog is just the set of `email_send` jobs in a **deferred** state (§9.3) tagged to the recovering
  mailbox/pool — there is **no new backlog table**; the queue's own deferred state is the backlog.
- On recovery the `email_send` worker **re-warms into the cap**: it drains the backlog **under the same §9.3.1
  Redis throttle and §3.3 ramp** that govern fresh sends — i.e. the backlog competes for the *same* daily slots,
  it does not get a bypass. If a multi-day block created more backlog than the daily cap can clear, the pool
  **spreads the drain across days** (and across other healthy mailboxes via rotation, §4.3), which is the correct
  behaviour — volume scales by mailboxes, not by exceeding a cap (§5.1).
- The drain is **idempotent**: each backlog job is still keyed by `idempotency_keys` (`D5`) and re-checks
  `assertNotSuppressed` in-tx (`D4`) before it sends, so a recipient who unsubscribed *during* the block is never
  mailed on recovery.
- **Admin signal & visibility.** Entry to `blocked` and completion of a multi-day drain are both audited
  (`audit_log`) and surfaced to the admin in `11` (Reputation-Pool health) and `/system-health` (queue depth /
  backlog age as an SLO). The admin can pause the pool, lower the mailbox cap, or trigger a probe send — the
  governance actions `11`/`12` own.

`15` owns the broader degraded-provider / regional-failover story; this doc fixes only the per-mailbox cap-hit
detection, the four-state health machine, and the throttled backlog drain.

---

## 10. Decisions this doc commits (summary)

1. **Hybrid, two-world model (D1):** cold/sales on the tenant's Google/MS mailbox via **API-first** (SMTP
   fallback); platform/system + permissioned bulk on **SES backbone / Postmark system mail / SendGrid·Mailgun
   alternates**. **No shared-IP bulk cold, ever.**
2. **Per-tenant Reputation Pool (D2):** rotation happens **inside** a pool; **no cross-tenant pooling**.
3. **Dedicated IPs only above sustained ~100k–250k/mo**, gated by admin action, preferring **SES managed
   dedicated** (auto-warm). Most tenants stay on the shared SES pool.
4. **Warmup is supported but not a shared open pool:** `email_warmup` ramp (§3.2) inside the tenant's own pool;
   **default 30–50 cold sends/mailbox/day**; scale by **adding mailboxes/domains**, not raising per-mailbox volume.
5. **Three isolated streams** (transactional / bulk / cold) on separate identities and providers — never mixed.
6. **Throttling is in-queue (D10),** per-tenant + per-mailbox, applying the tightest of mailbox cap / pool budget /
   provider window; over-cap = deferred, not dropped.
7. **FinOps gates the metered ESP path only:** per-tenant quota + hard cap + per-user limit (wiring is a P5/P6
   deliverable — current known gap).
8. **All of it under RLS fail-closed, secrets server-side (D7), idempotent sends (D5), suppression-gated (D4).**
9. **Per-mailbox throttle lives in Redis, not a hot DB row** (§9.3.1): an atomic per-mailbox/day counter +
   a queue-local batch reservation; the `creditRepository` `FOR UPDATE` lock is used **only** for the per-tenant
   FinOps money quota (§9.4). `15` owns the worker-replica scaling contract.
10. **Multi-provider sending lands behind the existing `EmailSenderPort` seam** (§9.6): a config-registered
    `ProviderAdapter.send(mailbox, recipient, subject, body, headers) -> { providerMessageId, error }`, enabled
    via the already-built `apps/admin` Providers surface (platform world) and the tenant's own
    `mailbox_integration` credential (mailbox world) — **no second send path, no rewrite of `sendStep`**.
11. **A per-`mailbox_integration` cap-hit / backlog-recovery state machine** (§9.7): parse provider
    4xx/`Retry-After`, drive `healthy → throttled → capped → blocked`, signal the admin on a multi-day
    `blocked`, and drain the backlog (the queue's deferred state — no new table) **under the same throttle/ramp**,
    idempotent and suppression-re-checked.

---

## 11. Sources (live, 2024–2026)

- Amazon SES pricing — https://aws.amazon.com/ses/pricing/
- Amazon SES dedicated IP (managed, adaptive warmup) — https://docs.aws.amazon.com/ses/latest/dg/dedicated-ip.html
- Postmark pricing — https://postmarkapp.com/pricing
- Postmark — Message Streams (transactional vs broadcast isolation) — https://postmarkapp.com/message-streams
- Postmark — sending bulk via Broadcast streams — https://postmarkapp.com/support/article/can-i-send-bulk-emails
- Twilio SendGrid pricing — https://www.twilio.com/en-us/products/email-api/pricing
- Mailgun pricing — https://www.mailgun.com/pricing/
- Mailgun — SMTP vs API tradeoffs — https://www.mailgun.com/blog/email/difference-between-smtp-and-api/
- MailerToGo — email API performance benchmarks 2025 — https://resources.mailertogo.com/statistics/email-api-performance-benchmarking-statistics-2025
- Google Workspace sending limits — https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace
- Smartlead — Gmail/Workspace sending limits 2026 — https://www.smartlead.ai/blog/gmail-sending-limits
- Microsoft Exchange Online limits — https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits
- Microsoft — Tenant Outbound Email Limits / TERRL (April 2025) — https://techcommunity.microsoft.com/blog/exchange/introducing-exchange-online-tenant-outbound-email-limits/4372797
- Smartlead — cold email sending frequency / ramp & per-mailbox limits — https://www.smartlead.ai/blog/email-frequency-best-practices-for-cold-emails
- Mailreach — how many cold emails per day — https://www.mailreach.co/blog/how-many-cold-emails-to-send-per-day
- Mailwarm — warmup schedule to 1000/day — https://www.mailwarm.com/blog/email-warmup-schedule-emails
- Topo — safe sending limits for cold email (2025) — https://www.topo.io/blog/safe-sending-limits-cold-email
- Mailreach — Instantly warmup review (pool risks) — https://www.mailreach.co/blog/instantly-warmup-review
- Mailreach — Smartlead warmup alternatives (inbox-mix criticism) — https://www.mailreach.co/blog/smartlead-warmup-alternatives
- BuzzLead — best email warmup services 2026 — https://www.buzzlead.io/blogs/best-email-warmup-services-2026-the-definitive-tactical-guide
- Puzzle Inbox — Postmark vs Mailgun for cold email (shared-pool contagion) — https://puzzleinbox.com/blog/postmark-vs-mailgun-cold-email-2026
