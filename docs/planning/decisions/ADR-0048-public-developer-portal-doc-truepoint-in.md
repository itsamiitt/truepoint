# ADR-0048 — `doc.truepoint.in`: a public, contentful, zero-PII developer portal (`apps/doc`)

- **Status:** Proposed
- **Date:** 2026-08-21
- **Related:** [ADR-0029](./ADR-0029-credit-ledger-and-lease-decrement.md) (credit ledger — the *purchased* settlement unit) · [ADR-0041](./ADR-0041-subscriptions-and-monthly-credit-reset.md) (subscriptions/plan templates) · [ADR-0043](./ADR-0043-chrome-extension-architecture.md) (capture posture) · [ADR-0046](./ADR-0046-raw-api-interception-primary-capture.md) (Rule-4 escalation precedent)
- **Source brief:** `DocappPlan/` (10 files, operator-supplied) — a business plan for a credit-priced B2B **data API** business
- **Governing strategy:** `docs/strategy/{03-outcomes,04-opportunity-scores,06-roadmap,07-data-flywheel,09-compliance}.md`, root `CLAUDE.md` §Rules

> **Locked by this ADR.** `doc.truepoint.in` is served by a **new fifth web app, `apps/doc`
> (`@leadwolf/doc`)**: a public, unauthenticated, statically-rendered Next.js App Router site whose
> only job is **published documentation, published pricing, and published trust posture**. It holds
> **no personal data, no database client, no auth, and no `@leadwolf/config` import**. Every fact it
> renders is a typed content module committed to the repo. Anything that would accept input from a
> visitor, read a record, or meter a call belongs to `apps/api` + `apps/web` and is explicitly **out
> of scope here**.

## Context

The operator supplied `DocappPlan/`: a plan to sell live B2B company/person data through a
credit-priced API to software companies and AI-agent builders, in four phases (flat files → API →
owned supply → watchers/signals). The plan's own launch sequence puts **web surfaces first**: a
pricing page with the full published price table in weeks 1–2 (06 §5), dataset landing pages in
weeks 3–4 (10), and a public docs site with copy-paste curl examples in Phase 2 (03 §2.6, "Docs are
our sales team"). Its three repeated proof points — no-match-no-charge, published quality numbers,
a live pricing page with no demo wall (06 §2) — are all *publishing* acts, not engineering acts.

That is the shape of the thing at `doc.truepoint.in`: the published face of the data business. It
is a genuinely separate surface from the four that exist. `app.` is the authenticated customer CRM,
`auth.` is the IdP, `api.` is the Hono service, `forge.` is the staff data-operations console. None
of them can host an anonymous, crawlable, SEO-load-bearing marketing/documentation site without
dragging the authenticated shell, the session cookie surface, and the tenant-scoped data client
into a page that must serve a logged-out stranger. The architecture skill's UI-consolidation rule
asks "can this live on a surface that already exists?" — the answer here is no on all four of its
tests: different domain, different layout, different audience, and no user moves between "read the
public pricing page" and "work a list inside the CRM" in one task.

## Decision

### D1 — A fifth app, not a route group on `apps/web`

`apps/doc` (`@leadwolf/doc`) is a peer app under `apps/`. It consumes `@leadwolf/ui` (design system
+ tokens) and `@leadwolf/app-shell` (for `Logo`/`Brandmark`/`Wordmark` only — the brand is
implemented once and imported, never redrawn). It does **not** consume `AppShellFrame`: the authed
sidebar/topbar chrome is wrong for a public site, so `apps/doc` carries its own thin public header
and footer.

### D2 — Static-first, env-free build

The app renders entirely from committed content modules. It imports **no** `@leadwolf/config`, no
`@leadwolf/db`, no `@leadwolf/auth*`, and no `@leadwolf/core`. This is a deliberate hard boundary,
not an accident of scope: it means the site builds and deploys with **zero environment**, cannot
leak a secret it never holds, and cannot be the cause of a data incident. It is enforced by the
dependency-cruiser boundaries rule added with this ADR, so a future agent cannot quietly wire a
database client into a marketing page.

### D3 — Content is typed data, not MDX or raw HTML

Every page's substance lives in `src/content/*.ts` as typed objects (endpoint specs, plan tables,
credit tables, trust statements, changelog entries), rendered by a small set of presentational
components. Consequences that matter: the API reference cannot structurally drift between
endpoints, `bun run typecheck` is a content gate, no MDX toolchain is added, and there is no
`dangerouslySetInnerHTML` anywhere in the app (`truepoint-security` frontend-security).

### D4 — Nothing on this site collects personal data

No waitlist form, no newsletter input, no "request a sample" form, no contact form that POSTs. Every
call to action is an outbound link or a `mailto:`. Rationale: a form that takes an email address is
a collection path, and per `CLAUDE.md` Rule 3 + `09-compliance.md` every collection path needs a
lawful-basis tag, a consent surface, a suppression enforcement point, and an erasure propagation
path. That work is real and belongs on `apps/api`; it is not smuggled in behind a marketing page.
Lead capture is listed under *Deferred* below with the gate it must pass.

### D5 — Sample data is synthetic and labelled as such

Plan file 10 calls for a "25-row sample" on each dataset page. A public page showing 25 real
business-contact records is an anonymous, un-suppressible, un-erasable egress of personal data:
`09-compliance.md` requires suppression to be enforced at **every** egress and erasure to propagate
within 72h, and a statically-published table satisfies neither. Sample tables therefore render
**generated placeholder rows drawn from a committed fixture, visibly labelled as illustrative**,
with the real field list published alongside. A real sample, if ever needed, is delivered per-request
through an authenticated, suppression-checked, logged path — not published.

### D6 — The site documents the *purchased* credit unit only

Credits on this site are what `CLAUDE.md` Rule 7's 2026-07-31 amendment says they are: a **purchased
settlement unit**. The site never states, implies, or prices a credit that a contribution can earn.
See Conflict C1.

## Conflicts surfaced (rule 6 — recorded, NOT silently reinterpreted)

The brief and the shipped strategy disagree in five places, and reading the published pages against the shipped code has surfaced one more. None is resolved by this ADR; each is
carried as an open decision for the operator.

**C1 — Contributor-earned credits (BLOCKING; `CLAUDE.md` Rule 7).**
`DocappPlan/02 §6`, `04 §Source B` ("1 verified new contact contributed = N lookup credits", "higher
rates for rare data"), `05 §3` ("contributor-network members earn more") and `06 §4` ("contributions
earn extra credits") all describe an earned currency. `07-data-flywheel.md §Access model` states the
opposite in one line — *"Four tiers; no credit, points, or bounty currency anywhere in the system"* —
and `decisions.md` records the **MONETIZATION PIVOT** that deleted exactly this mechanic, because a
farmable currency is what turns A-03 from data-quality fraud into economic fraud and what creates the
C-06 clawback problem. The brief revives a decision already taken and reversed. **Resolution taken
here:** the portal publishes purchased credits and the existing Free/Community/Pro/Team access model;
it publishes **no** earn-rate, contribution reward, or "contribute for credits" claim anywhere. The
brief's supply thesis is *not* thereby endorsed — it needs a human decision in `decisions.md` before
any code implements it.

**C2 — Sales Navigator fallback in the waterfall (BLOCKING; `CLAUDE.md` Rule 4).**
`DocappPlan/04 §Source A` lists a "Sales Navigator fallback service" as waterfall stage 3, and
`08 §Risk 2` concedes it violates LinkedIn's User Agreement. Rule 4 forbids it outright, and no
amount of framing as an "internal stopgap" changes that. **Resolution taken here:** the published
sourcing statement enumerates the supply classes this product actually stands behind and does not
list, allude to, or leave room for logged-in-platform extraction. No retirement date is documented
here because the portal is not the place a hard-constraint breach gets scheduled — that is a
`decisions.md` entry the operator owes.

**C3 — Public sample rows (`CLAUDE.md` Rule 3).** Addressed by D5 above; recorded here because the
brief asks for the non-compliant version explicitly.

**C4 — A fourth market with no outcome IDs (`CLAUDE.md` Rule 1).**
`03-outcomes.md` names three markets: SELLER, CONTRIBUTOR, ADMIN/REVOPS. The brief's buyer — a
developer or agent-builder consuming data by API — is a fourth, and the API-as-product business it
implies is adjacent to non-goal **S-05** (raw database-size expansion). Rule 1 says work serving no
listed outcome gets **flagged, not built**. **What is built here** is the subset that does serve
shipped outcomes: **A-01** (a public, specific sourcing-and-lawful-basis statement is the first thing
a regulator or an enterprise buyer asks for), **S-10** (publishing what a confidence score and a
verification-recency badge actually mean makes the shipped badge legible outside the app), and
**A-02/S-11** (a public, findable route to opt out and erase). **What is flagged:** the commercial
pages — plan pricing, credit costs, dataset catalogue — describe a business the strategy pack has
not ratified. They ship as *published intent*, clearly dated, and the operator owes a `decisions.md`
entry ratifying the fourth market before any metering, billing, or public API code is written
against it.

**C5 — The published provenance shape is not the stored one (surfaced 2026-08-22).**
`/docs/confidence` publishes a per-field descriptor of `{ sources, class, last_seen }` with a four-value
class vocabulary (`verified` | `corroborated` | `single-source` | `inferred`), and the planned
`POST /person/enrich` example returns it. The SHIPPED substrate stores something different:
`packages/types/src/fieldProvenance.ts` defines the descriptor as
`{ src, mth, conf, obs, ver, pin, by, at, cf }` — a platform source LABEL, a match method, a confidence in
[0,1], observed-at and last-verified-at timestamps, and the human-correction pin. There is no stored count
of agreeing sources and no stored class.

Neither side is simply wrong, which is why this is a conflict rather than a bug. The stored keys are
deliberately short and internal (billions of rows x ~15 fields), and `src` carries values like
`provider:zoominfo` — publishing that verbatim would name a commercial supplier per field, a disclosure
decision nobody has taken, and the same class of leak `PLAN_03 §C2` forbids for contributing workspaces.
A public egress shape therefore has to be a DERIVED projection, and what it derives — how a confidence
number and a source label become a class word, and whether an agreement count is even computable from a
store that keeps only the winning descriptor — is an unmade product decision.

**Resolution taken here:** nothing is silently reinterpreted. The guide keeps the class vocabulary, because
it is the model the product intends and the one that makes the in-app badge legible (outcome S-10), but it
now states plainly that no callable endpoint emits `field_provenance` today — both endpoints that carry it
are `planned` — and it describes what the store actually records. A test forbids any `available`/`beta`
endpoint from declaring a `field_provenance` return until the projection exists. The operator owes a
`decisions.md` entry defining the public projection before `POST /person/enrich` ships.

**C6 — The sourcing statement describes a crawler this repository does not contain (surfaced 2026-08-22; NOT
edited, deliberately).**
`/trust` opens its source list with *"Public web pages: company sites, career pages and public job postings,
crawled directly, respecting robots.txt and rate-limited to be a polite visitor."* A repository-wide search
finds no robots.txt parsing, no crawl scheduler, and no politeness/rate-limit layer for outbound page
fetches anywhere outside `apps/doc`'s own `robots.ts` route. `master_job_postings` exists as a Layer-0 table
with a repository and a read route, but nothing in this repo writes to it from a crawl.

Two readings are possible and this ADR cannot choose between them: the claim is aspirational and currently
unbacked, or the crawling runs in a system outside this repository. Both matter, differently — the first is
a compliance statement we cannot evidence, the second is a supply path whose politeness behaviour nobody
here can verify.

**Why this was recorded rather than fixed.** `CLAUDE.md` rule 3 requires any change touching personal-data
collection to state its compliance impact and pass the checklist, and to stop and ask when uncertain. The
sourcing statement is the lawful-basis claim itself: softening it without knowing whether the crawler exists
would risk making the page wrong in the opposite direction, and an agent is the wrong actor to quietly
narrow a published data-ethics commitment. So the wording is untouched.

**What the operator owes:** confirmation of whether a crawler exists and where. If it does, a pointer to it
belongs in this ADR and its robots.txt/rate-limit behaviour should be evidenced by a test. If it does not,
the bullet has to change, and that change is a `decisions.md` entry because it narrows what the public page
claims about how data is sourced.

**C7 — Published availability described the CONTRACT, not the DOOR (surfaced and closed 2026-08-22).**
The two company endpoints are built, metered and badged `beta`, and the site had begun counting them as
callable. The router is mounted inside `if (env.PUBLIC_DATA_API_ENABLED)`, and
`deploy/env.production.template` ships that flag OFF, with its own comment: *"while off the router is not
mounted and /api/v1/public/* 404s"*. Key creation and the usage read stay live either way — deliberately, so
a credential can be provisioned before the endpoints it calls are switched on — which is exactly the sequence
that turns this into a support thread: read the docs, mint a key, curl the base URL, get a 404 from a route
that was never mounted.

The badge was not wrong. Availability answers *is the contract settled*; nothing on the site answered *is the
door open for me*. Those are different axes and only one of them was published.

**Resolution taken here:** the site says both now. `content/access.ts` carries one sentence — access is
enabled per account, keys can exist before the endpoints do, and a 404 from the base URL means the account is
not enabled rather than the path being wrong — and it appears on every callable endpoint page, in the docs
facts strip, and inside the landing page's generated status line. A test in `content/shippedContract.test.ts`
reads the deployment template and requires that wording for as long as the flag ships off; flipping the
template to `true` stops the test demanding it.

## Consequences

- A fifth deployable app, a fifth subdomain in origin/CORS config, one more CI matrix entry.
- The site is the cheapest thing in the fleet to run and the least dangerous thing to break: no env,
  no database, no session. A total outage costs marketing, not customers' data.
- The published pricing and credit tables become a **duplicate** of the values in `plan_templates`
  and the credit-cost constants. They are committed content, dated, and marked as launch estimates
  (`DocappPlan/05` opens by saying the structure matters more than the figures). If the portal and
  the product ever disagree on a live price, the product wins and the content module is corrected —
  reconciling them in code is out of scope and would drag `@leadwolf/config`/`@leadwolf/db` across
  the D2 boundary.
- Publishing a price and a bounce-rate guarantee is a public commitment. The guarantee text is
  deliberately written as the *mechanism* (credit-back above an agreed threshold) rather than a
  specific number, because no shipped code enforces a threshold today.

## Deferred (each needs its own gate before it is built)

| Deferred | Gate it must pass first |
|---|---|
| Waitlist / lead capture / newsletter | Rule 3 checklist: lawful basis, consent surface, suppression point, erasure path (`apps/api` endpoint, not a static form) |
| Self-serve API-key issuance + usage dashboard | `truepoint-platform` (metering correctness, rate limits) + billing; belongs on `app.`, not `doc.` |
| MCP server + its install docs | The MCP server has to exist; the page is a stub-free follow-up |
| Live status page | An uptime source of truth; a hand-written "all good" page is worse than none |
| Real dataset samples | An authenticated, suppression-checked, logged delivery path (D5) |
| Anything implementing the brief's supply plan | Operator decision on C1/C2 recorded in `decisions.md` |
