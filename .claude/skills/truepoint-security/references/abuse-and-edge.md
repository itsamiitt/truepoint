# Abuse Defence and the Edge

App-layer rate limiting (see `api-security.md`) is necessary but not sufficient at
the scale of millions of users and for a product whose data is itself a target. This
file covers the defences at and beyond the edge — DDoS, web application firewall, bot
and scraping defence — plus the compliance surface unique to a dialer (TCPA/DNC).
These are the threats the original skills under-covered relative to the
"enterprise-grade, millions of users" bar.

> **Implementation status:** the app-layer rate limiting this file builds on is in
> place — `rate-limiter-flexible` on Redis (`packages/auth/src/rateLimit.ts`): per-IP
> 30/min and per-identifier 10/min on the credential steps, plus a coarse per-caller
> 120/min cap on the resource API. The **edge** defences below (DDoS absorption, WAF,
> bot/scraping management) are the target — see the per-section status notes.

---

## DDoS and the Edge

At this scale the front door is attacked — volumetrically and at the application
layer:

- **DDoS mitigation** sits in front of the application (a CDN/edge provider with
  absorption capacity). The origin is not directly exposed to raw internet traffic;
  the edge absorbs and filters volumetric floods before they reach the backend (see
  **truepoint-platform** scaling-playbook tier 10).
- **The origin only accepts traffic via the edge** — bypassing the edge to hit origin
  directly is closed off, so protections can't be skipped.
- Edge protection complements, not replaces, app-layer rate limiting — one stops
  floods, the other stops abuse of specific expensive endpoints.

> **Implementation status:** the edge today is **Caddy** (`deploy/Caddyfile`), a reverse
> proxy/TLS terminator — it is **not a CDN/edge provider with volumetric absorption or
> bot management**. DDoS absorption and origin-shielding are the **target**; keep the
> mandate and front the origin with an absorbing edge before claiming this protection.

---

## Web Application Firewall (WAF)

A WAF at the edge filters malicious request patterns before they reach the app:

- It blocks common attack signatures (injection attempts, known-bad patterns) as a
  layer in front of the application's own input validation (`input-and-injection.md`)
  — defence in depth, not a substitute for validation.

> **Implementation status:** no WAF is present today (the Caddy edge does not filter
> attack signatures). The **target** stands — add an edge WAF as a defence-in-depth
> layer in front of the app's own validation.
- WAF rules are tuned to TruePoint's surface; overly broad rules that block
  legitimate traffic are as much a problem as missing ones.
- The WAF is part of the edge config, version-controlled and reviewed like other
  infrastructure.

---

## Bot and Scraping Defence — Existential for a Data Vendor

TruePoint's core asset is its contact/company dataset. **Scraping that dataset is an
existential threat** — a competitor or abuser extracting the data destroys the
product's value. This deserves more than the one-line "search is a scraping tool,
rate-limit it" the original skills gave it:

- **Search and data-access endpoints are the scraping target.** Beyond per-user/per-
  org rate limits (`api-security.md`), watch for scraping *patterns* — systematic
  enumeration, abnormally broad querying, velocity inconsistent with human use — and
  throttle or block them.
- **Bot management** at the edge distinguishes automated abuse from legitimate
  traffic (and from legitimate automation like a customer's sanctioned API use, which
  goes through the authenticated, tiered public API — `api-security.md`).
- **Per-account abuse detection**: a single account (or a stolen session) suddenly
  pulling far more data than its normal pattern is a signal — tie it to the same
  anomaly detection as cost spikes (**truepoint-operations** finops; a scraping spike
  and a cost spike are often the same event).
- **Account-level limits on data volume** (how much can be exported/queried in a
  window) cap the blast radius of a single compromised or malicious account.
- **Tar-pitting / progressive friction** (challenges, slowdowns) on suspected
  scraping rather than only hard blocks, to avoid breaking legitimate edge cases.

Scraping defence balances against usability — legitimate heavy users (a real
power-user, a sanctioned integration) must keep working — so it's pattern- and
anomaly-based, layered with the authenticated API for legitimate automation.

---

## Telephony Compliance: TCPA, DNC, and Consent

If the dialer is in scope (TruePoint makes outbound calls), telephony carries
compliance obligations that are **not optional** and are a distinct surface from data
security. Verification (is the number real — **truepoint-data** verification)
establishes reachability; this establishes whether you may *contact* it:

- **Do-Not-Call (DNC) scrubbing** — numbers on applicable DNC registries (and a
  customer's own suppression/opt-out list) are not dialed. DNC/opt-out state is
  checked before a call is placed and is respected system-wide (overlaps consent —
  `data-protection.md`).
- **TCPA and equivalent rules** — constraints on automated/auto-dialed calls, calling
  hours/time-zones, and consent for certain contact types. The dialer enforces these,
  not the rep's discretion.
- **Call-recording consent** — recording requires consent, and consent rules vary
  (some jurisdictions require all parties to consent). Recording behaviour respects
  the applicable rule and the consent state.
- **Line-type rules** — line type from verification (mobile/landline/VoIP —
  **truepoint-data** verification) feeds what's permissible (e.g. texting/auto-dialing
  certain line types).
- **Caller-ID integrity (STIR/SHAKEN)** and robocall-mitigation expectations apply to
  outbound calling at scale.

A call is gated by *both* "is this number reachable" (verification) and "may we
contact it" (this section). The dialer enforces compliance centrally; per-call
metadata (consent, DNC status) is recorded for audit (**truepoint-data** data-model
Call; compliance.md).

> **Implementation status:** partially in place. A `suppression_list` (global / tenant /
> workspace scopes — `packages/db/src/repositories/suppressionRepository.ts`) and
> `consent_records` (`packages/db/src/repositories/consentRepository.ts`,
> `packages/db/src/schema/compliance.ts`) exist, so suppression/opt-out and consent
> state are modelled. **Full TCPA/DNC dialer enforcement** — registry scrubbing,
> calling-hours/time-zone rules, recording-consent and line-type gating wired into the
> call path, STIR/SHAKEN — remains the **target**. Keep the mandate.

---

## Checklist

- Is the origin shielded behind edge DDoS mitigation, accepting traffic only via the
  edge?
- Is a WAF filtering malicious patterns in front of the app's own validation?
- Are data/search endpoints defended against scraping by pattern/anomaly detection,
  bot management, and per-account volume caps — not just per-request rate limits?
- Is per-account abuse tied to the same anomaly/cost-spike signals, with progressive
  friction balancing usability?
- Does the dialer enforce DNC scrubbing, TCPA/time-zone/consent rules, recording
  consent, and line-type rules centrally — gating calls alongside verification — with
  per-call compliance metadata recorded?
