# 07 — Product surfaces

Design defers to `truepoint-design` (tokens, tables, WCAG) and the feature-folder rules
of `truepoint-architecture`. This doc fixes IA + scope, not pixels.

## 1. IA regroup (forced — nav is at capacity)

Web-surface scan conclusion 7: 8 rail items + 4 unrailed routes already. Adding
"Companies" + "Signals" cannot be an append. Proposed regroup of
`apps/web/src/components/shell/navConfig.ts`:

| Rail item | Contains |
|---|---|
| Home | unchanged (gains a Signals widget) |
| **Prospect** | Contacts scope (person-first search, reveals) |
| **Companies** *(new)* | account search scope (moves out of the toggle) + account lists + `/companies/:id` pages + market boards tab |
| **Signals** *(new)* | signal feed, watchlists, subscriptions |
| Lists · Imports · Reports · Data Health · Settings | unchanged |
| Sequences · Inbox | unchanged (frozen X-01 surface — no capacity, no removal) |

The `Contacts ⇄ Accounts` SegmentedControl retires; deep links redirect. This is a
navigation-map change — update `docs/planning/11-information-architecture.md`'s
successor map in the same PR ([A-01] page-layout contract commit precedent).

## 2. `/companies/:id` — the company page (MI-1)

Promotion of `AccountDetailDrawer` content into a routed page, sections in order:
1. Header: identity, industry (taxonomy node + raw), size band, HQ, stage — every field
   with the S-10 provenance badge (design thesis from `intelligence-platform/03` §5:
   freshness is a primary element, not a detail drawer).
2. Momentum strip: headcount sparkline + growth windows, latest signals.
3. Signals timeline (family-filtered).
4. Technology: uses / develops / displacement (existing sections).
5. Funding history (new section; stage filter already exists).
6. Hiring (MI-4): open-roles summary by department.
7. People: contacts in workspace + "N more in database" bridge to person search.
8. Watch button → MI-3.

Drawer remains for in-search preview; page is the canonical URL. Empty states stay
honest (sections self-hide or show "no licensed coverage" — never fabricate).

## 3. Signals surface (MI-3)

- Feed: reverse-chron tenant_signals across watched accounts, family filters.
- Watchlists: CRUD + membership from company page/search bulk action.
- Subscriptions: per-watchlist family toggles, in-app + digest cadence.
- Delivery: notifications feature (exists) + `NotificationsBell`; digest via the email
  infra **as transactional product email, not sequences** (X-01 untouched).

## 4. Market boards (MI-8)

`Companies → Markets` tab: segment matrix (industry × geo × size), each cell → count,
headcount delta, funding sum; "top movers" list. Reads MI-S7 only — no per-request
aggregation. Every number links to the drill-down search that reconciles with it.

## 5. Reports

- Re-label the permanently-empty "Intent" tab honestly: it becomes **Signals** activity
  (produced families only). LeadScore tab lights up when account scoring ships (MI-7
  gives it data at the account grain; contact composite stays as-is).

## 6. Extension

Unstub the hover-card `score` with the account momentum/fit summary once MI-7 exists;
add "company known — view in TruePoint" state for company pages. No new extraction
(doc 05 posture).

## 7. Admin (staff) surfaces

- **Data sources** page grows from the linkedin_api origin fleet into a source catalog:
  per-feed health, freshness lag, coverage counts, compliance clearance status (reads
  `provider_configs` + `source_fetch_registry` + landing metrics).
- **Coverage dashboard** (new, read-only): per-pillar fill rates — % companies with
  taxonomy node, with headcount series, with any adoption, signal volume per family.
  This is the ops answer to "is the licensed feed worth its invoice" (FinOps hook,
  truepoint-operations).
- Feature-flag console already generic — new dual-gates appear by seeding rows.

## 8. Copy discipline

Customer UI never names vendors (`sourceLabel.ts` collapse holds). Signal cards cite
"observed <date> · <evidence link>" — provenance as product (O10, the quick win).
