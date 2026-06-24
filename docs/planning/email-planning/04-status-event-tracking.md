# Email — Status & Event Tracking (04)

> Cites the **Locked Decisions (D1–D10)**, **Shared Vocabulary**, and **Canonical Entities** in
> `00-overview.md`, the **Phase Map** in `13-rollout-phases.md`, and the **TruePoint constraints
> digest** (tenancy, queues, security, design) carried throughout the set. **Scope:** this doc owns
> the *behaviour* of status & event tracking end to end — what an event is, how each is detected, how
> reliable it is, how it is ingested safely, and how it surfaces in real time. It does **not** own the
> `activities` / `email_event` schema (that is **09-data-model**), the analytics roll-ups built on these
> events (**08-reporting-analytics**), the unified-inbox / record-detail pixels and panes
> (**10-web-surface**), or sequence auto-pause logic (**05-sequences-automation**). This doc is the
> contract those four build against. **No code** — entity, column, queue, endpoint, and header names
> are named; the only snippets are a JSON error shape and a one-line idempotency note where essential.

---

## 1. Why this document exists, and the one decision it turns on

Every other email surface — analytics (`08`), sequence pacing (`05`), the unified inbox (`10`) — is
downstream of a single fact: **did something happen to this message, and can we trust it?** Status &
event tracking is the system that produces that fact. It is the most quietly dangerous part of an
email subsystem, for two reasons:

1. **The inputs are attacker-controlled.** Every event arrives over a public webhook from an ESP or a
   mailbox provider, or is derived from an inbound message we did not author. The TruePoint security
   constraint is non-negotiable here: **verify webhook signatures, validate every payload, never trust
   a client-supplied identifier, and never log PII or message bodies** — audit IDs and actions only.
2. **The most-watched metric is the least trustworthy.** Open tracking — historically the headline KPI
   of every sales-engagement tool — was structurally broken by Apple Mail Privacy Protection (MPP) in
   2021 and has only degraded since. This is precisely why **D6** locks opens as *informational, not
   the KPI of record*, and makes **reply rate the primary KPI**. §4 is the evidence behind D6; the rest
   of the doc is built so that the trustworthy signals (delivery, bounce, reply, complaint,
   unsubscribe, click) are first-class and the untrustworthy one (open) is labelled as such everywhere
   it appears.

The best-in-class platforms (Outreach, Salesloft, Apollo, HubSpot, Instantly, Smartlead) all
converged on the same shape post-MPP: ingest everything via signed, idempotent webhooks; treat opens
as soft signal; treat replies as the conversion event; and pause automation on the high-trust signals
(reply, bounce, OOO, unsubscribe) rather than on opens. TruePoint adopts that shape directly.

---

## 2. The event vocabulary — the lifecycle the system tracks

Every tracked engagement occurrence becomes one `email_event` row that surfaces as an `activities`
entry (entities owned by `09`), always written through the **`email_tracking` BullMQ queue** (D10)
with tenant context set per job. Doc `09` owns the canonical enum: **`email_event.event_type ∈ {
delivery, open, click, reply, bounce, unsubscribe, complaint }`** — seven values. The table below also
lists **`sent`** so the lifecycle reads end-to-end, but `sent` is a send-record (`email_send`-role)
status transition recorded on the send path (`02-sending-infrastructure`), **not** an `email_event`.
(The table uses past-tense
display labels — `delivered` / `opened` / etc. — for the seven stored values plus `sent`.) The states
are **not** equally trustworthy, and the system must never pretend they are.

### 2.1 The event-type table (event · source · how detected · reliability caveat)

| Event | Source | How detected | Reliability caveat |
|---|---|---|---|
| **sent** | Our send path (`email_send` transition) | We record it ourselves when the ESP/mailbox accepts the message for delivery (`02-sending-infrastructure`) | **High.** This is *accepted by the provider*, not *delivered to the inbox*. Do not conflate with delivered. |
| **delivered** | ESP / mailbox provider webhook | Provider posts a `delivered` event after the receiving MX accepts the message | **High**, but means "accepted by the recipient's server", not "landed in the inbox". A spam-foldered message can still be `delivered`. |
| **bounced** | ESP / mailbox provider webhook | Provider posts `bounce` (hard, permanent) or `block`/`deferred` (soft, transient) | **High for hard bounces.** Soft vs hard classification varies per provider; a hard bounce must feed `suppression_list` (D4) and can trigger sequence auto-pause (`05`). |
| **opened** | Tracking pixel fetch | A 1×1 image at the **per-tenant custom tracking domain (D3)** is requested | **Low — see §4.** MPP and Gmail proxy prefetch fire this without a human. Labelled **informational** per D6; never the KPI. |
| **clicked** | Tracked-link redirect | Recipient hits a rewritten link on the tracking domain (D3); we 302 to the destination | **Medium–High.** The strongest *machine-readable* intent signal that survives MPP, but security scanners and link-prefetchers (corporate gateways, Outlook SafeLinks) generate false clicks. De-dupe and filter known bot UAs (§4.3). |
| **replied** | Inbound mailbox (Gmail API / Microsoft Graph push, or IMAP) | Threading match on `In-Reply-To` / `References` against a sent message's `Message-ID` (§5) | **High when matched, but reply *detection* is the hard part.** OOO auto-replies must be classified separately (§5.4) and must **not** count as a human reply. |
| **unsubscribed** | Our unsubscribe endpoint / List-Unsubscribe | Recipient clicks the unsubscribe link or the one-click `List-Unsubscribe-Post` header action | **High.** Must write `suppression_list` + `consent_records` synchronously and fail-closed (D4, `06-compliance`). |
| **complaint** (spam) | ESP feedback loop (FBL) / provider webhook | Recipient hits "Report Spam"; the mailbox provider FBL relays it to the ESP, which webhooks us | **High and severe.** A complaint must immediately suppress (D4) and is a reputation-isolation signal (`07`). Some providers (notably Gmail) do **not** expose per-message complaints, so complaint volume is partially blind. |

> **Reading the table:** the three rows TruePoint *trusts for decisions* are **delivered/bounced**
> (deliverability + suppression), **replied** (the D6 primary KPI), and **complaint/unsubscribe**
> (compliance + reputation). **opened** is decoration. **clicked** is the best surviving
> machine-readable interest signal but is filtered, not trusted raw.

### 2.2 What we store vs what we never store

Each event row carries, at minimum: `tenant_id` (always), `workspace_id`, the owning `email_send`
reference, the event type, the provider's event timestamp, our receipt timestamp, the dedup key (§6.3),
and a small typed metadata blob (e.g. bounce class, click target host, normalized UA family). Per the
data/ownership constraint, **the row never stores message bodies, reply text, or recipient PII beyond
the references already modelled** — audit IDs and actions only. Reply *content* lives where the inbox
models it (`10`), not in the tracking-event stream.

---

## 3. Open-pixel and link-tracking mechanics — and their downsides

### 3.1 Open pixel — how it works

The classic mechanic: embed a unique 1×1 transparent image whose URL encodes (opaquely, server-side
only) which `email_send` it belongs to. When a mail client renders the HTML and fetches that image, our
edge records an **opened** event. **Recommended tech:** serve the pixel from the **per-tenant custom
tracking domain (D3)** — never a shared TruePoint domain — so a single tenant's tracking footprint and
reputation are isolated (`07`) and the tracking host aligns with the sending domain for deliverability
(`03`). The pixel handler is a thin edge endpoint that enqueues to `email_tracking`; it does **no**
synchronous DB work and returns the image immediately.

**Downsides (all real, all why D6 exists):**
- **Images-off renders nothing.** Many clients block remote images by default; a real human read with
  images off produces **no** open event. Open rate therefore *under*counts privacy-conscious readers
  and *over*counts proxied ones — error in both directions.
- **Proxy prefetch fabricates opens** (§4) — the dominant failure mode today.
- **Caching hides repeat opens.** Once a proxy (Gmail's, §4.4) caches the image, subsequent genuine
  re-opens by the same person fetch the cached copy and never hit our server — under-counting the most
  engaged readers ([Suped](https://www.suped.com/knowledge/email-deliverability/technical/how-accurate-are-email-open-rates-and-how-does-gmail-image-caching-affect-them)).
- **It is a deliverability and privacy liability.** Tracking pixels are a spam-filter signal and a
  GDPR/PII concern; `06-compliance` governs whether tracking is even permitted for a given tenant /
  region, and the pixel must respect that gate.

### 3.2 Link tracking — how it works

Each outbound link is rewritten to a redirect URL on the **tenant tracking domain (D3)**. On request we
record a **clicked** event and issue a 302 to the original destination. Click is the **best
machine-readable interest signal that survives MPP** ([beehiiv](https://www.beehiiv.com/blog/apple-mpp-open-rate),
[datainnovation.io](https://datainnovation.io/en/apple-mpp-email-open-rate-fix/)) — MPP prefetches
*images*, not link clicks, so clicks reflect a genuine human action far more often than opens.

**The redirect must never fail the recipient.** The click handler's *only* job that the recipient
depends on is the 302 to the real destination; recording the `click` event is a side effect that
must never block or break that hop. The handler therefore (1) resolves the destination from the
rewritten token *first*, (2) enqueues the click event to `email_tracking` (fire-and-forget — never a
synchronous DB write on the recipient's request path, §3.3), and (3) issues the 302. The
event-enqueue path is wrapped in a **5-second timeout**: if the enqueue is slow or the queue is
under backpressure (§6.3), the handler **abandons the event and falls through to the destination
redirect anyway**. A recipient clicking a link in our email must **never** see a TruePoint error
page, a spinner, or a delay because our tracking pipeline is degraded — a dropped click event is an
acceptable analytics loss; a broken link to the customer's own content is not. (The dropped event is
counted as a tracking-loss metric, §6.3, feeding the operations ingest SLO.)

**Downsides:**
- **Bot/scanner clicks.** Corporate security gateways, Outlook **SafeLinks**, and link-preview
  prefetchers visit every link before (or instead of) the human. These produce false clicks, often
  within seconds of delivery and frequently from datacenter IP ranges or recognisable UAs. **Mitigation:**
  de-dupe per (`email_send`, link) and filter known scanner UA/IP signatures before counting a click as
  intent (§4.3).
- **Link rewriting can hurt deliverability and trust.** A mismatch between the visible link and the
  redirect host looks phishy to filters; this is exactly why D3's per-tenant tracking domain (aligned,
  authenticated) matters, and why some compliance regimes (`06`) may disable rewriting entirely.

### 3.3 The TruePoint posture on both

Pixels and link-rewrites are **per-tenant, per-D3-domain, and compliance-gated**. The edge handlers are
write-light (enqueue to `email_tracking`, return fast). Opens are stored but flagged informational (D6)
everywhere they surface. Clicks are stored and filtered, and feed analytics (`08`) as a *secondary*
engagement signal — secondary to replies.

---

## 4. Apple Mail Privacy Protection (MPP) and proxy prefetch — the evidence behind D6

This section is **required** and is the empirical basis for **D6** (opens informational, reply rate
primary). It is the single most important fact in this document.

### 4.1 What MPP does

Apple Mail Privacy Protection, introduced with iOS 15 / macOS Monterey in **late 2021** and on by
default for anyone who taps "Protect Mail activity", routes inbound mail through **Apple-managed proxy
servers that pre-download all remote content — including the tracking pixel — before, and regardless of
whether, the human ever opens the message**
([beehiiv](https://www.beehiiv.com/blog/apple-mpp-open-rate),
[Paubox](https://www.paubox.com/blog/how-apple-mail-privacy-protection-inflates-email-open-rates)).
Apple also strips the recipient's IP and approximates location, so even the metadata on a "real" open
is unreliable. The consequence: for any recipient on Apple Mail with MPP on, **an "open" event tells
you nothing about whether a human saw the message.**

### 4.2 The scale of the inflation (cite-able numbers)

- Apple Mail accounts for roughly **58% of all email opens globally** by early 2025 (Litmus, as cited
  in [emailtooltester](https://www.emailtooltester.com/en/blog/apple-mpp-open-rate/) /
  [datainnovation.io](https://datainnovation.io/en/apple-mpp-email-open-rate-fix/)) — so the majority
  of "opens" pass through MPP-capable infrastructure.
- Open rates for senders with a meaningful iOS audience are **inflated by 15–35%** depending on list
  composition; a 2024 Validity analysis put MPP-dominant audiences **18–32 percentage points above
  verified engagement** ([datainnovation.io](https://datainnovation.io/en/apple-mpp-email-open-rate-fix/)).
- Real-world illustration: a newsletter that "usually sat at a 28% open rate hit 55% out of nowhere"
  after MPP ([beehiiv](https://www.beehiiv.com/blog/apple-mpp-open-rate)); some senders saw reported
  opens at **nearly double** pre-MPP levels
  ([Omeda](https://www.omeda.com/blog/the-impact-of-apples-mail-privacy-protection-6-months-later/)).

**This is why TruePoint cannot make open rate the KPI of record.** A "55% open rate" that is really 28%
of humans plus 27% of Apple's robots is worse than no number — it is a *confidently wrong* number that
would mis-pace sequences and mislead reps. D6 makes **reply rate primary** because replies are a human
action MPP cannot fabricate.

### 4.3 Gmail / proxy image-prefetch effects (not just Apple)

The problem predates and extends beyond Apple. Since 2013 Gmail proxies **all** images through Google's
servers (`googleusercontent.com` / `ggpht.com`), and it **prefetches and caches** them — a single fetch
can be triggered by Gmail displaying a message to an *active* user, but equally by prefetching, security
scanning, browser/mailbox extensions, or filters
([Suped](https://www.suped.com/learn/email-deliverability/how-does-gmails-image-proxy-affect-email-open-tracking-and-what-could-cause-very-fast-opens),
[Filippo Valsorda](https://words.filippo.io/how-the-new-gmail-image-proxy-works-and-what-this-means-for-you/)).
GMass, analysing ~307 million opens, found a bot-UA-driven **false-open incidence rising from ~2.5% to
~6.5%**, and identified the tell-tale proxy signature `(via ggpht.com GoogleImageProxy)` in the user
agent ([GMass](https://www.gmass.co/blog/false-opens-in-gmail/)).

**TruePoint mitigations for the open signal (applied in the `email_tracking` worker, never trusted at
the edge):**
- **Very-fast-open filter:** opens that arrive within seconds of `sent`/`delivered` are flagged
  likely-machine (prefetch/scan), not human.
- **UA classification:** opens carrying known proxy/bot UA families (Google Image Proxy, Apple's MPP
  fetcher, scanner UAs) are tagged `machine` and excluded from any human-engagement view.
- **Click corroboration:** an open with a subsequent click from a non-bot UA is weighted higher.

These mitigations *reduce* noise; they do not make opens trustworthy. The product treatment (D6) — open
shown as a soft, labelled signal, reply as the headline — remains the real defence.

### 4.4 Caching also *suppresses* real signal

Because Gmail caches proxied images, a genuinely engaged reader who opens the same email three times
generates **one** pixel fetch — under-counting the most engaged
([Suped](https://www.suped.com/knowledge/email-deliverability/technical/how-accurate-are-email-open-rates-and-how-does-gmail-image-caching-affect-them)).
So opens are inflated by robots *and* deflated by caching simultaneously. There is no correction factor
that recovers truth from this; the only sound response is the one D6 mandates.

### 4.5 Click-to-open rate (CTOR) — and why even *it* inherits the open caveat

Analytics (`08`) and reps will ask for **CTOR — click-to-open rate**, defined as
**unique clicks ÷ unique opens** (the share of "openers" who also clicked). CTOR is genuinely
useful as a *content/copy-quality* signal — of the people the pixel says saw the message, how many
acted — and it is **less** distorted than raw open rate because the click in the numerator is a
real human action that survives MPP (§3.2).

**But CTOR is not clean, and the doc must label it as such.** Its denominator is the open count, so
**every open-inflation pathology in §4.1–§4.4 flows straight into the CTOR denominator**:
- MPP and proxy prefetch **inflate opens**, which **deflates** CTOR — the "openers" pool is padded
  with robots that never click, so the ratio reads artificially low.
- Gmail image caching **suppresses** repeat opens, nudging the denominator the other way.
- Numerator and denominator are filtered by *different* rules (clicks are bot-filtered per §4.3;
  opens are machine-tagged per §4.3), so a naïve `clicks ÷ opens` mixes signal qualities.

**TruePoint rule:** CTOR is computed by `08` from the same partitioned `email_event` store (`09`),
**only over human-classified opens and bot-filtered clicks** (never raw counts), and is rendered
with the **same "informational" labelling as opens (D6)** — because it inherits the open
denominator, it is a secondary copy-quality signal, **never** a KPI of record. Reply rate remains
primary (D6).

---

## 5. Reply detection — the highest-value, hardest-to-get-right event

Because reply rate is the primary KPI (D6), **reply detection is the most important detection problem in
the whole subsystem.** It has two halves: (a) recognising that an inbound message is a reply to one of
our sends, and (b) deciding whether it is a *human* reply or an automated one (OOO/auto-reply).

### 5.1 Threading — the matching mechanism

Every send TruePoint emits carries a unique RFC 5322 `Message-ID`. A genuine reply from a conformant
client sets `In-Reply-To: <our-message-id>` and includes our `Message-ID` in its `References` chain
([EmailEngine](https://learn.emailengine.app/docs/sending/threading/overview), Medium "Threading
Emails"). **Recommended approach:** store each send's `Message-ID` on `email_send`, and on every inbound
message parse `In-Reply-To` and `References` and match against stored IDs to bind the reply to its send
(and thus its `outreach_log` and contact). This is provider-agnostic and is the documented,
recommended path even for Microsoft Graph, whose proprietary `Thread-Index`/`conversationId` is *not*
reliable across external systems
([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/1348031/using-ms-graph-api-how-to-reply-to-an-email-thread)).
Fallbacks for non-conformant senders: subject normalisation (strip `Re:`/`Fwd:`) plus recipient match,
used only as a secondary heuristic.

### 5.2 How we *see* inbound mail — push vs poll

| Mechanism | Provider | Tradeoffs |
|---|---|---|
| **Push / webhooks (preferred)** | **Gmail API** (watch + Pub/Sub notifications), **Microsoft Graph** (subscription → change notifications) | **Best-in-class.** Near-real-time; no constant polling. Provider pushes a JSON notification when a message arrives/changes ([Unipile](https://www.unipile.com/microsoft-graph-api-email-integration-guide/)). Costs: subscriptions **expire and must be renewed** on a schedule; notifications often carry only an ID, so we fetch the message detail (then thread-match per §5.1); OAuth scopes and consent are required (`12-roles-permissions`, `06`). |
| **IMAP polling (fallback)** | Generic IMAP mailboxes (D1 hybrid covers providers without a modern API) | Universally compatible but **higher latency and load**: we poll on an interval (e.g. IDLE where supported, else periodic `email_sequence_tick`-cadence checks). No native thread IDs — threads are built **manually** from `Message-ID`/`In-Reply-To`/`References` ([EmailEngine](https://learn.emailengine.app/docs/sending/threading)). Pure polling is the highest-overhead option and is reserved for mailboxes that cannot push. |

**Recommended:** push for Gmail/Graph (the common case), IMAP poll as the compatibility floor — aligned
with **D1 (hybrid provider strategy)**. Inbound discovery is itself a queued job (`email_tracking`):
the webhook/notification only *enqueues*; the worker fetches detail, thread-matches, classifies, and
writes the event with tenant context set per job (D10).

### 5.3 Out-of-office / auto-reply detection (must not count as a reply)

An OOO bounce-back is an inbound message that threads to our send but is **not** a human reply, and must
not be scored as one (and should pause/defer the sequence per `05`, not advance it). Detection follows
RFC 3834 and the established multi-signal heuristic
([RFC 3834](https://datatracker.ietf.org/doc/html/rfc3834),
[arp242](https://www.arp242.net/autoreply.html)):
- **`Auto-Submitted` header** present and not `no` (`auto-replied` / `auto-generated`) — the standards
  signal.
- **`X-Autoreply` / `X-Auto-Response-Suppress`** — Microsoft/Outlook.
- **`Precedence: bulk|auto_reply`** — legacy but still widespread.
- **Subject/body patterns** — e.g. "Out of Office", "AutoReply", as a secondary confirmation.

**Recommended rule (per the cited best practice):** require **at least two signal types** (a header plus
a subject/body pattern) before classifying as auto-reply, because non-conformant servers set only one.
An OOO event is stored as its own classification on the reply pathway — never tallied as a human reply,
never feeding the D6 KPI.

### 5.4 What "replied" means downstream

A confirmed **human** reply: (1) writes a `replied` `email_event` row surfaced in `activities`; (2) is
the conversion event for D6 analytics (`08`); (3) **auto-pauses** the contact's `outreach_log` so the
sequence stops
mailing someone who answered (`05`); and (4) surfaces in the **Unified Inbox** (`10`). An OOO/auto-reply
does (1) with an `auto_reply` classification and may **defer** the next step rather than pause — but
never counts as engagement.

---

## 6. Webhook & notification ingestion — the security-critical path

Every externally sourced event (ESP delivery/bounce/complaint webhooks; Gmail/Graph push
notifications) enters through one disciplined pipeline. This is where the TruePoint **security
constraint is load-bearing**: *verify webhook signatures, validate input, idempotent at-least-once.*

### 6.1 Endpoints and queue boundary

Ingestion endpoints live under the email feature in `apps/api`
(`apps/api/src/features/email/routes.ts`, with the email-feature `index.ts`), versioned under
`/api/v1`. **The endpoint does almost nothing synchronously:** verify the signature, validate the
payload shape (Zod schemas in `@leadwolf/types`), enqueue to the **`email_tracking` BullMQ queue**, and
return `2xx` fast (ESPs require a `2xx` within ~10 seconds or they retry —
[Twilio SendGrid Event Webhook](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event)).
All matching, classification, suppression writes, and timeline updates happen in the
`apps/workers/src/queues/email*.ts` worker with tenant context set per job (D10). This keeps the public
edge thin, fast, and hard to overload — and means a slow database never causes the ESP to think we're
down.

### 6.2 Signature verification (mandatory, fail-closed)

A webhook with a missing or invalid signature is **rejected, not processed** — full stop. Verification
specifics vary by provider and we implement per-provider verifiers:
- **SendGrid** signs with **ECDSA** (not HMAC), sending `X-Twilio-Email-Event-Webhook-Signature` plus a
  timestamp header; the signature is over the **raw request body**, so verification must run on the
  unparsed bytes *before* any JSON parsing
  ([Twilio SendGrid](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event),
  [Hookdeck](https://hookdeck.com/webhooks/platforms/guide-to-sendgrid-webhooks-features-and-best-practices)).
- **Other ESPs** (Postmark, etc.) commonly use HMAC over the raw body with a shared secret.
- **Gmail/Graph** push: validate the subscription's `clientState`/validation token and confirm the
  notification's subscription ownership before fetching.

The verifying secret/public key is a **server-side secret per the security constraint (D7, KMS target)**
— never on the client, never in logs. A failed verification returns an RFC 9457 problem response and is
counted (a spike is an alert / possible spoofing attempt), e.g.:

```json
{ "type": "https://truepoint.in/problems/webhook-signature", "title": "Invalid webhook signature", "status": 401 }
```

**Failed-signature logging + rate-limit (anti-abuse).** A signature failure is a security event, so
it is **logged distinctly** — but with the same PII discipline as §6.4: log the **provider name, the
source IP, the claimed event type, and a failure reason** only, **never** the raw body or any
recipient identifier (a spoofed payload may itself carry PII bait). Failure logging emits a metric
that drives an alert on a spike (a sustained run of invalid signatures is either a rotated/misapplied
secret or a spoofing probe; operations triages via `15`'s ingest-health view). Because the
verification endpoint is **public and unauthenticated by design**, it is also **rate-limited per
source IP** (and per provider where the source set is known/allow-listed), so a flood of forged or
malformed posts cannot exhaust the edge or the verification CPU — a rate-limited caller gets a `429`
RFC 9457 problem response and never reaches the queue. Genuine ESPs post from documented IP ranges
and retry within their own backoff, so the limit is sized to absorb legitimate batch redelivery
while shedding abusive volume.

### 6.3 Idempotent ingest (at-least-once, exactly-once effect)

ESPs explicitly **redeliver the same event** on retry, so ingestion must be idempotent
([inventivehq SendGrid guide](https://inventivehq.com/blog/sendgrid-webhooks-guide),
[Hooklistener](https://www.hooklistener.com/guides/sendgrid-webhook-events)). Each provider exposes a
stable per-event id (SendGrid's `sg_event_id`; Gmail/Graph message+history ids). **Recommended:** persist
that provider id as the dedup key on `email_event` (a unique constraint), so a replayed webhook
is a no-op — the same pattern as TruePoint's `idempotency_keys` for sends (D5), applied to the
*ingest* side. ESPs also **batch** up to 1,000+ events per POST, so the worker must process the array
element-by-element, each element independently idempotent — one poison event must not drop the batch
(BullMQ backoff + DLQ for the genuinely un-processable). This satisfies the queue constraint:
*idempotent at-least-once, backoff + DLQ, backpressure.*

### 6.4 Ingestion backpressure (bounded queue, fast 2xx, 503 when full)

The edge must stay fast and bounded **even when the system behind it is saturated** — an ESP's
event firehose can spike far above steady state (a large send completing, a bounce storm, a
complaint cascade). The pipeline is therefore explicitly backpressured rather than unbounded:
- **Bounded enqueue.** The `email_tracking` queue has a **bounded admission depth**; the edge does
  not buffer events in process memory waiting for the queue, and it does no synchronous write to the
  durable store on the request path.
- **Fast 2xx is the success path.** When admission succeeds, the edge returns `2xx` within the ESP's
  ~10-second window (§6.1) and the worker drains asynchronously into the **partitioned `email_event`
  store** (§6.6, `09`).
- **503 to the ESP when full.** When the bounded queue is at capacity, the edge **does not** block,
  drop silently, or fall over — it returns a **`503` (with `Retry-After`)** RFC 9457 problem
  response. ESPs treat a `503`/timeout as "retry later" and **redeliver** (the same redelivery §6.3
  already makes idempotent), so shedding under load is **lossless**: we hand the event back to the
  provider's durable retry buffer instead of risking our own. This is the deliberate inverse of the
  recipient-facing redirect rule (§3.2) — there we *never* error the human and drop the event; here
  we *do* error the (retrying, machine) ESP rather than accept work we cannot durably queue.
- **Observability.** Admission rejections, queue depth, and the worker→store drain latency are the
  ingest SLO signals surfaced in `15`'s system-health / ingest view; a sustained `503` rate is a
  capacity alert, not normal operation.

```json
{ "type": "https://truepoint.in/problems/ingest-overloaded", "title": "Event ingestion temporarily at capacity", "status": 503 }
```

### 6.5 Soft-delete before hard-delete (so late replies still thread)

Send and message rows are **soft-deleted before they are ever hard-deleted** — the same `deleted_at`
tombstone pattern the platform already uses on `contacts` (canon: `contacts.deleted_at`). A reply
can arrive **days or weeks** after a send, long after a sequence has completed, a contact has been
archived, or a cleanup job has run. If the originating send row (carrying the stored `Message-ID`,
§5.1) were hard-deleted, the inbound reply would **fail to thread** — it could not bind to its
enrollment/contact, would be mis-scored or orphaned, and the highest-value event in the subsystem
(D6 reply) would be lost. **Rule:** retention/cleanup sets `deleted_at` on send/message rows and
**threading still resolves against soft-deleted sends**, so a late reply continues to match and
attribute correctly; only after a defined grace window (governed by `06` retention / `09` data
model, and respecting DSAR hard-erasure which always wins, §6.4) may a soft-deleted row be hard
deleted. Hard deletion is the terminal, irreversible state — never the first action.

### 6.6 Where ingested events land — the partitioned store *and* the activity feed

Every event the worker accepts is written into the **high-volume partitioned `email_event` store**
(the genuinely new tracking store owned by `09`), which is built for ingest volume and is the source
of truth for analytics roll-ups (`08`) and the per-contact timeline (§7). That same write **feeds
the `activities` engagement timeline** — the worker emits the corresponding `activities` row
(`activity_type ∈ { email_sent, email_opened, email_clicked, email_replied }`, `channel = email`,
`occurred_at` = the provider event timestamp) so the event also appears in the **product FEED /
record activity stream** alongside calls, LinkedIn touches, and notes. `email_event` is the raw,
partitioned, high-cardinality store; `activities` is the human-readable, cross-channel feed it feeds
— neither is a parallel of the other, and a tracking event is not "ingested" until it has landed in
both (one transaction in the worker). This is the §7 timeline's durable backing and the §8
post-commit publish source.

### 6.7 What ingestion must never do

Never log the raw body or any recipient PII (security + data constraints) — log the provider event id,
the event type, and the resolved `email_send` reference only. Never trust a recipient identifier from
the payload to *select* a row across tenants — resolve via our own stored references under the job's
tenant context, so a spoofed/leaked id can never cross a tenant boundary (RLS + app-filter; IDOR → 404).

---

## 7. Per-contact event timeline

Every event, once written, is attributable to a contact (via `email_send` → `outreach_log` →
contact) and rolls up into a **per-contact email timeline**: an ordered stream of *sent → delivered →
opened (informational) → clicked → replied / OOO → unsubscribed / complaint* for that person, across all
their enrollments and one-off sends.

- **Where it surfaces:** the **record detail** and the **Unified Inbox** in `apps/web`
  (`10-web-surface` owns the rendering; this doc owns the event stream behind it). The timeline is the
  rep's single answer to "what has this person done with our emails?"
- **Ownership & visibility:** the timeline obeys **D8 (owner-scoped visibility)** and RLS — a rep sees
  the events on contacts within their workspace scope, owner-filtered, never another tenant's. The query
  is `tenant_id`-leading and cursor-paginated per the API constraint (timelines can be long).
- **Labelling (D6 in the UI):** open rows are rendered as **informational** ("opened — may be
  automated"), visibly distinct from a confirmed human reply, so a rep is never misled by an
  MPP/prefetch open. This labelling is a hard requirement, not a nicety — it is how D6 reaches the user.
- **Design constraints:** four states (loading / empty / error / populated), virtualised for long
  histories, WCAG 2.2 AA, light theme only, `var(--tp-*)` tokens, i18n copy — per the design constraint
  and `10`.
- **No bodies in the event stream:** reply *content* is shown from the inbox model (`10`), not stored on
  `email_event` (§2.2).

---

## 8. Real-time status updates — SSE vs WebSocket vs polling

Reps watch sends go out and replies land; the surface should update without a manual refresh. The
question is the transport.

| Mechanism | Direction | Fit for TruePoint | Tradeoffs |
|---|---|---|---|
| **Polling / long-polling** | client pulls | Floor / fallback | Simplest, works everywhere, no persistent connection. **Highest overhead** — full HTTP headers per request — and bounded latency. Fine for low-frequency views ([algomaster](https://blog.algomaster.io/p/polling-vs-long-polling-vs-sse-vs-websockets-webhooks)). |
| **SSE (Server-Sent Events)** | **server → client only** | **Recommended default** | Email status flow is **one-directional** — the server learns of an event (delivered/replied/bounced) and pushes it to the open inbox/timeline. SSE is **HTTP-native, auto-reconnects, passes proxies/firewalls without special config, and multiplexes over HTTP/2** ([Ably](https://ably.com/blog/websockets-vs-sse), [RxDB](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html)). ~5 bytes/message overhead. Caveat: production buffering through some proxies must be tested ([RxDB](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html)). |
| **WebSocket** | full-duplex | Not needed here | Lowest latency, bidirectional — but requires manual reconnect/health/session logic and is overkill for a notify-only stream ([WebSocket.org](https://websocket.org/comparisons/sse/)). Reserve for genuinely interactive, two-way features (not status updates). |

**Recommended:** **SSE as the default**, polling as the universal fallback for clients/networks where SSE
buffers, and **no WebSocket** for status — the data flow is server→client only, which is exactly SSE's
sweet spot ([dev.to guide](https://dev.to/crit3cal/websockets-vs-server-sent-events-vs-polling-a-full-stack-developers-guide-to-real-time-3312)).
The SSE stream is **tenant- and owner-scoped** (D8): a connection only receives events for records the
authenticated user may see, enforced server-side — the stream is an output of the same RLS/app-filter,
never a back-door around it. The stream is fed by the `email_tracking` worker as it commits events (a
post-commit publish), so the real-time path and the durable timeline (§7) never diverge. This also
respects the operations constraint of a **tracking-ingest latency SLO**: the worker→SSE hop is what that
SLO measures end to end.

---

## 9. Phase placement & cross-references

Per the **Phase Map** (owned by `13-rollout-phases.md`):

- **P1 (send path):** the **delivery / bounce webhook** ingestion lands here — signed, idempotent, into
  `email_tracking`. This is the minimum viable tracking: we must know a message delivered or bounced
  (and suppress on hard bounce, D4) from day one.
- **P3 (Tracking + Inbox):** the **full event tracking** set — opens (informational), clicks, replies,
  unsubscribes, complaints — plus **per-contact timeline (§7)**, **reply detection (§5)**, the **unified
  inbox**, and **real-time status (§8)**. This is the bulk of this document.
- Tracking therefore **ships across P1→P3**, exactly as the Phase Map states.

**Cross-references:**
- `09-data-model` — owns `activities` / `email_event` (and every entity named here); this doc specifies
  the *behaviour* their columns must support (dedup key, classification, timestamps).
- `08-reporting-analytics` — consumes these events; reply rate is its headline (D6), opens are
  informational, clicks are secondary.
- `05-sequences-automation` — consumes `replied`/`bounced`/`unsubscribed`/OOO to auto-pause or defer
  enrollments.
- `10-web-surface` — renders the per-contact timeline and unified inbox, hosts the open/click pixels'
  effects, consumes the SSE stream.
- `06-compliance` — gates whether tracking (pixel/link-rewrite) is permitted per tenant/region;
  unsubscribe + complaint feed `suppression_list` / `consent_records`.
- `07-multitenancy-reputation-isolation` — complaints and bounces are reputation signals; D3 tracking
  domain is per-tenant.
- `02`/`03` — the send path emits `Message-ID` (for reply matching) and the `sent` event; deliverability
  governs the tracking-domain alignment.

---

## 10. Acceptance summary (the contract)

1. **Eight canonical event types** (§2), each written as one `email_event` row (surfaced in
   `activities`) via the `email_tracking` queue with per-job tenant context (D10); the event-type table
   (§2.1) is the source
   of truth for source/detection/reliability.
2. **Opens are informational, never the KPI (D6).** §4 is the evidence: MPP inflates opens 15–35% and
   Apple Mail is ~58% of opens; Gmail proxy prefetch adds false opens and caching hides real re-opens.
   **Reply rate is primary.** Opens are labelled informational everywhere they render (§7).
3. **Clicks** are stored, bot-filtered (§3.2/§4.3), and used as a *secondary* interest signal.
4. **Reply detection** matches `In-Reply-To`/`References` against stored `Message-ID`s (§5.1), prefers
   Gmail/Graph push with IMAP poll fallback (§5.2, D1), and classifies OOO/auto-replies out of the human
   reply count via multi-signal RFC 3834 detection (§5.3).
5. **All webhook/notification ingest is signature-verified (fail-closed), validated, idempotent on the
   provider event id, and queue-backed** (§6) — the edge returns `2xx` fast and never logs PII/bodies.
6. **Per-contact timeline** (§7) is owner-scoped (D8), RLS-enforced, cursor-paginated, four-state,
   virtualised, and never stores reply bodies.
7. **Real-time status via SSE** (default), polling fallback, no WebSocket, tenant/owner-scoped server
   side, fed post-commit by the tracking worker within the tracking-ingest latency SLO (§8).

---

### Sources (2024–2026)

- Apple MPP impact — [beehiiv](https://www.beehiiv.com/blog/apple-mpp-open-rate),
  [datainnovation.io (Validity-cited 2024 data)](https://datainnovation.io/en/apple-mpp-email-open-rate-fix/),
  [emailtooltester (Litmus ~58%)](https://www.emailtooltester.com/en/blog/apple-mpp-open-rate/),
  [Paubox](https://www.paubox.com/blog/how-apple-mail-privacy-protection-inflates-email-open-rates),
  [Omeda](https://www.omeda.com/blog/the-impact-of-apples-mail-privacy-protection-6-months-later/).
- Gmail image proxy / prefetch / caching —
  [Suped](https://www.suped.com/learn/email-deliverability/how-does-gmails-image-proxy-affect-email-open-tracking-and-what-could-cause-very-fast-opens),
  [Suped (caching/accuracy)](https://www.suped.com/knowledge/email-deliverability/technical/how-accurate-are-email-open-rates-and-how-does-gmail-image-caching-affect-them),
  [GMass false opens](https://www.gmass.co/blog/false-opens-in-gmail/),
  [Filippo Valsorda](https://words.filippo.io/how-the-new-gmail-image-proxy-works-and-what-this-means-for-you/).
- Reply detection / threading —
  [EmailEngine threading](https://learn.emailengine.app/docs/sending/threading/overview),
  [Gmail threads API](https://developers.google.com/gmail/api/guides/threads),
  [Microsoft Graph reply threading](https://learn.microsoft.com/en-us/answers/questions/1348031/using-ms-graph-api-how-to-reply-to-an-email-thread),
  [Unipile Graph email guide](https://www.unipile.com/microsoft-graph-api-email-integration-guide/).
- OOO / auto-reply — [RFC 3834](https://datatracker.ietf.org/doc/html/rfc3834),
  [arp242 detecting autoreply](https://www.arp242.net/autoreply.html).
- ESP webhooks (signature, idempotency, batching) —
  [Twilio SendGrid Event Webhook](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event),
  [Hookdeck SendGrid best practices](https://hookdeck.com/webhooks/platforms/guide-to-sendgrid-webhooks-features-and-best-practices),
  [inventivehq SendGrid guide](https://inventivehq.com/blog/sendgrid-webhooks-guide),
  [Hooklistener](https://www.hooklistener.com/guides/sendgrid-webhook-events).
- Real-time transport — [Ably WebSockets vs SSE](https://ably.com/blog/websockets-vs-sse),
  [RxDB comparison](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html),
  [algomaster](https://blog.algomaster.io/p/polling-vs-long-polling-vs-sse-vs-websockets-webhooks),
  [WebSocket.org SSE comparison](https://websocket.org/comparisons/sse/).
