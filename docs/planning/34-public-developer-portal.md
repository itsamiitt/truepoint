# 34 — The public developer portal (`doc.truepoint.in`)

- **Status:** built (first cut), 2026-08-21
- **Decision:** [ADR-0048](./decisions/ADR-0048-public-developer-portal-doc-truepoint-in.md)
- **Source brief:** `DocappPlan/` (operator-supplied, 10 files)
- **App:** `apps/doc` (`@leadwolf/doc`), port 3007

This is the pre-build reasoning pass required by
`.claude/skills/truepoint-architecture/references/pre-build-thinking.md`, plus the plan it produced and a
record of what was actually built.

---

## What was built

A fifth Next.js app serving the public face of the data business: what the API does, what a call costs,
where the data comes from, and how a person gets their own record removed. It is anonymous, statically
rendered, and holds no personal data, no database client, no auth and no `@leadwolf/config` import.

21 routes, all prerendered:

| Route | What it is |
|---|---|
| `/` | Positioning, the three commitments, the endpoint index |
| `/pricing` | Per-action credit costs, plans, and what a credit is *not* |
| `/datasets`, `/datasets/[slug]` | Flat-file catalogue; field lists with fabricated sample rows |
| `/docs` | Quickstart (the documentation index) |
| `/docs/[slug]` | Guides: authentication · errors · pagination and rate limits · confidence and provenance |
| `/docs/api/[endpoint]` | Endpoint reference, generated from typed specs |
| `/trust` | Sourcing statement, what we never collect, data-subject rights |
| `/changelog` | Dated record of contract, price and sourcing changes |
| `/robots.txt`, `/sitemap.xml` | Generated from the content layer |

---

## The reasoning pass

**Source of truth.** Every fact rendered is a typed module under `src/content/`, committed to the repo.
There is no runtime source and nothing is fetched. Two values are *deliberate duplicates* of product state:
the plan prices (which really live in `plan_templates`) and the per-action credit costs. They are duplicated
by hand, carry a `PRICING_REVIEWED` date rendered on the page, and if the two ever disagree the product wins
and the content module is corrected. Reconciling them in code would require importing `@leadwolf/config` or
`@leadwolf/db`, which is precisely the boundary ADR-0048 §D2 draws.

**Failure modes.** There is no API call, no mutation and no async state on this site, so the usual list
collapses to two cases. A build-time content error is a type error (`bun run typecheck` is the content gate).
A runtime failure can only be the container being down, which Caddy answers with its own error page; the
compose service declares `depends_on: []` so the portal stays up when the database, Redis and API are all
down — a documentation site that goes dark during an incident is a documentation site that is missing
exactly when people need it.

**Duplicate prevention.** No writes, so no duplicate records. The analogous risk is duplicate *routes*: two
guides or two endpoints sharing a slug would silently publish one and lose the other through
`generateStaticParams`. That is asserted against in `src/content/content.test.ts`.

**Audit and change history.** Git is the audit log; `/changelog` is its public projection. Entries are added
when the published contract, the price or the sourcing posture changes — not when copy is edited.

**Security.** The threat surface is close to empty by construction and that is the point. No session, no
cookie, no secret, no user input, no outbound request, no `dangerouslySetInnerHTML`, no route handler.
`dynamicParams = false` on all three dynamic routes means an unknown slug is a 404 rather than a request
that reaches application code. The origin is deliberately **not** added to `APP_ORIGINS`: that list is the
CORS and token-audience allowlist for authenticated origins, and a site with no session has nothing to gain
from being on it while everything on it widens that surface. Security headers match the rest of the fleet;
`X-Frame-Options` is `DENY` rather than the customer app's `SAMEORIGIN`, since nothing embeds a marketing
page. No CSP yet — see Risk flags.

**Scalability.** 21 static files behind Caddy. The load ceiling is the edge, not the app. The one thing that
would change this is adding a form or a live data read, which is why both are explicitly out of scope.

**Monitoring.** A compose healthcheck on `/`. Beyond that the honest answer is that this app has no
telemetry and does not need per-feature instrumentation — but *traffic* to it is a business signal (the plan's
thesis is that documentation is the sales channel), so web analytics is a real follow-up. It is not in this
cut because analytics on an anonymous site is a privacy decision, not a plumbing one.

**Rollback.** No feature flag, and none is warranted: rollback is redeploying the previous image, and there
is no state to migrate back. No database migration is involved anywhere in this app.

**Edge cases.** Unknown slug → 404 through the app's own `not-found.tsx`, which keeps the masthead and the
footer's route to `privacy@truepoint.in` so a mistyped URL still leads somewhere useful. Empty content
arrays render empty sections rather than crashing. Wide tables scroll inside their own container so the page
body never scrolls sideways at 375px.

**Assumptions.** That `doc.truepoint.in` is meant to be crawled (the site sets `robots: index`, unlike every
other app in the fleet, and `apps/auth` sets the opposite). That the endpoints described are the contract the
operator intends to build to — they do not exist yet, which is why every one carries a status badge.

**Misuse.** A visitor can request pages in a loop. They are static files; the edge handles it. Nothing here
can be made expensive by a caller.

**Worst case.** The worst thing this app could do is publish personal data — a real contact row in a sample
table, served to anonymous visitors, cached beyond our reach, and therefore neither suppressible nor
erasable. That is why sample rows are fabricated on RFC 2606 reserved domains and why a test asserts it. The
second-worst is publishing a claim we cannot stand behind: a price, a coverage figure, or a service we do not
run. That is why availability is a required field on every endpoint, dataset and plan, and why no measured
number (match rate, bounce rate, record count) appears anywhere on the site.

---

## Structure

```
apps/doc/src/
  app/                    thin routes: metadata + mount, plus robots.ts / sitemap.ts / not-found.tsx
  components/             shared chrome and prose primitives (SiteChrome, Prose, CodeBlock,
                          ReferenceTable, Note, PageIntro, AvailabilityBadge, ButtonLink)
  content/                typed data: site, pricing, endpoints/, guides/, datasets, trust, changelog
  features/               marketing · pricing · api-reference · datasets · trust · changelog
```

Three components are clients and each for a stated reason: `SiteHeader` and `DocsSidebar` read the pathname
for `aria-current`, and `ReferenceTable` owns the boundary to the design system's `DataTable` (whose API is
column descriptors carrying functions — building those server-side fails the build outright). Everything
else renders on the server.

`ButtonLink` is the one place the design system is extended rather than consumed: `TpButton` renders a real
`<button>` and takes no `asChild`, and the shadcn `Button`'s Tailwind classes resolve to nothing in an app
with no Tailwind engine. It applies the DS's own `.tp-ui-btn` classes to an anchor, which is the correct
element for a navigation.

---

## Risk flags

1. **The four strategy conflicts** in ADR-0048 §C1–C4 are open and belong to the operator: contributor-earned
   credits (forbidden by rule 7 and already reversed once in `decisions.md`), the Sales Navigator supply stage
   (forbidden by rule 4), public real-data samples (rule 3), and the fourth market with no outcome IDs
   (rule 1). Nothing here implements any of them; the portal's copy is written to the shipped strategy.
2. **The prices are published and duplicated.** They will drift from `plan_templates` unless someone re-reads
   the date on the page. This is a deliberate trade against dragging a data client into a public site.
3. **No CSP.** This app is the best candidate in the fleet for one — no inline handlers, no third-party
   origins, no user content — but Next emits inline bootstrap scripts, so a real policy needs a nonce plumbed
   through the layout and a report-only rollout against a live deployment.
4. **No analytics**, so there is currently no way to tell whether the documentation is doing the job the plan
   assigns it.
5. **A build-time BOM in an app's `package.json` silently breaks module resolution** for the whole workspace —
   dependency-cruiser reports every import in the app as unresolvable and the boundary rules stop applying,
   while typecheck and build carry on passing. It cost real time here. Worth knowing before it happens again.

## Dependencies to wire

| Cross-cutting concern | How it is handled |
|---|---|
| Audit | Git + `/changelog`. No mutations to audit. |
| Permissions | None — the app is anonymous by design. |
| Feature flags | None. Rollback is a redeploy. |
| Search indexing | `robots.ts` + a generated `sitemap.ts`; the site is meant to be crawled. |
| Notifications / webhooks / export | Not applicable — no data, no events. |
| Analytics | **Not wired.** Listed as a follow-up above rather than stubbed. |

## What this pass did NOT do

- No lead capture, waitlist or newsletter form. A form that takes an email address is a collection path and
  needs a lawful basis, a consent surface, a suppression enforcement point and an erasure path
  (`CLAUDE.md` rule 3) — that belongs on `apps/api`, not behind a static page.
- No self-serve API-key issuance or usage dashboard. That is metering and billing; it belongs on `app.`.
- No MCP server page. The MCP server does not exist; documenting it would be documenting nothing.
- No status page. A hand-written "all systems normal" is worse than no status page at all.
- No real dataset samples. They need an authenticated, suppression-checked, logged delivery path.
- Nothing implementing the brief's supply plan (contributor rewards, vendor waterfall, crawling). Those are
  ADR-0048 §C1/§C2 decisions the operator owes before any code is written.
