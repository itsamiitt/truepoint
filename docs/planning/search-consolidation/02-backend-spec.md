# 02 — Backend Spec

Governed by `truepoint-platform` (API contract, tenancy, caching, scale) +
`truepoint-data` (model, search) + `truepoint-security` (access).

## A hard constraint that shapes everything below

`leadwolf_app` — the RLS-enforced role the API connects as — is **REVOKEd from every
`master_*` table**, explicitly and again through a dynamic `^master_` defence-in-depth
loop in `applyMigrations.ts`. Only `leadwolf_er` (`withErTx`) may read Layer-0.

Therefore **a global search and a workspace anti-join cannot be one SQL query.** Any
design that says "just LEFT JOIN contacts" requires granting `leadwolf_app` access to
the graph, which reverses a deliberate security wall. This spec does not propose that.
Everything below is built as: page the graph under `withErTx`, then probe the overlay
under `withTenantTx` — the two-transaction shape `core/prospect/searchDatabase.ts`
already established.

## Endpoints

Existing, reused unchanged: `POST /search/contacts`, `POST /search/count`,
`POST /search/facets`, `GET /search/suggest`, `POST /account-search/*`,
`POST /contacts/from-database`.

| Method | Path | Status | Purpose |
|---|---|---|---|
| POST | `/api/v1/search/database` | extended | global people search |
| POST | `/api/v1/search/database/count` | extended | + `capped` |
| GET | `/api/v1/search/database/people/:slug` | **new** | composed masked person profile |
| POST | `/api/v1/search/database/companies` | **new** | global company search |
| POST | `/api/v1/search/database/companies/count` | **new** | count, capped |
| GET | `/api/v1/search/database/companies/:domain` | **new** | composed masked company profile |
| GET | `/api/v1/search/database/suggest` | **new** | global typeahead (`field` + `prefix`) |
| GET | `/api/v1/search/database/industries` | **new** | the seeded canonical taxonomy for the industry picker |

`/search/database/*` is the global namespace; `/search/*` stays the workspace
namespace. All are `authn` + `tenancy` + `requireWorkspace` — a workspace is still
required, because the response carries the per-workspace `inWorkspace` flag.

Every one is additive under `/api/v1` (api-contract: adding an endpoint or an
optional field is not breaking).

## Contracts (`@leadwolf/types` — the single source of truth)

### `databaseSearch.ts` — extended, additive

```ts
export const databaseFacetKey = z.enum([
  "title", "company", "company_domain", "location", "seniority", "industry",
  "school", "skill", "language",
]);

export const databaseTermFilter = z.object({
  kind: z.literal("term"),
  field: databaseFacetKey,
  op: z.enum(["include", "exclude"]).default("include"),   // NEW — closes the exclude gap
  values: z.array(z.string().min(1)).min(1),
});

export const databaseBoolFilter = z.object({
  kind: z.literal("bool"),
  field: z.enum(["has_email", "has_phone", "has_mobile"]),  // has_mobile NEW
  value: z.boolean(),
});

export const databaseRangeFilter = z.object({               // NEW
  kind: z.literal("range"),
  field: z.enum([
    "employee_count", "revenue_minor", "founded_year",      // the employer's firmographics
    "years_experience", "years_in_role", "job_change_days", // derived, see 03 §Materialized
  ]),
  gte: z.number().optional(),
  lte: z.number().optional(),
}).refine((r) => r.gte !== undefined || r.lte !== undefined, "range needs gte or lte");

export const databaseQuery = z.object({
  text: z.string().trim().max(200).optional(),
  filters: z.array(databaseFilter).default([]),
  sort: z.enum(["relevance", "recently_updated", "recently_changed_job"]).default("relevance"), // NEW
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

// additive fields on the existing DTO
export const maskedDatabasePerson = /* … existing … */.extend({
  companyEmployeeCount: z.number().int().nullable(),
  companyEmployeeBand: employeeBand.nullable(),
  primaryStartedOn: z.string().date().nullable(),   // drives "changed job N days ago"
});

export const databaseCountResult = z.object({
  total: z.number().int().nonnegative(),
  capped: z.boolean().default(false),               // NEW — see Count strategy
});
```

`in_workspace` is deliberately **not** a filter field on this contract — see
Workspace-status filtering below.

### `databaseCompanySearch.ts` — new file

```ts
export const databaseCompanyFacetKey = z.enum([
  "industry", "hq_country", "hq_city", "hq_region", "ownership_type", "specialty",
]);

export const databaseCompanyTermFilter = z.object({
  kind: z.literal("term"),
  field: databaseCompanyFacetKey,
  op: z.enum(["include", "exclude"]).default("include"),
  values: z.array(z.string().min(1)).min(1),
});

export const databaseCompanyRangeFilter = z.object({
  kind: z.literal("range"),
  field: z.enum(["employee_count", "revenue_minor", "founded_year", "headcount_growth_pct"]),
  gte: z.number().optional(), lte: z.number().optional(),
}).refine(…);

export const databaseCompanyQuery = z.object({
  text: z.string().trim().max(200).optional(),
  filters: z.array(databaseCompanyFilter).default([]),
  sort: z.enum(["relevance", "name_asc", "headcount_desc", "recently_updated"]).default("relevance"),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

/** One database company as the customer sees it. NO Layer-0 uuid; addressed by domain. */
export const maskedDatabaseCompany = z.object({
  primaryDomain: z.string(),                 // the addressing key (see 00 §Populations)
  name: z.string(),
  websiteUrl: z.string().nullable(),
  logoUrl: z.string().nullable(),
  description: z.string().nullable(),
  linkedinCompanyUrl: z.string().nullable(),
  industry: z.string().nullable(),
  industryCode: z.string().nullable(),       // canonical node from master_industries
  industryLabel: z.string().nullable(),
  employeeCount: z.number().int().nullable(),
  employeeBand: employeeBand.nullable(),     // DERIVED from employeeCount, never the dead column
  revenueMinMinor: z.number().nullable(),
  revenueMaxMinor: z.number().nullable(),
  revenueCurrency: z.string().length(3).nullable(),
  revenueDisplay: z.string().nullable(),
  ownershipType: z.string().nullable(),
  yearFounded: z.number().int().nullable(),
  specialties: z.array(z.string()),
  hqCountry: z.string().nullable(),
  hqCity: z.string().nullable(),
  hqRegion: z.string().nullable(),           // from master_company_locations (kind='hq')
  updatedAt: z.string().datetime({ offset: true }),
  /** Set when THIS workspace already holds the company (RLS-scoped probe back to `accounts`). */
  inWorkspace: z.object({ accountId: z.string().uuid(), contactCount: z.number().int() }).nullable(),
});
```

### Profile DTOs — one round trip each

The drawer needs identity + history + attributes at once, and it is one `withErTx`
read, so it is **one endpoint**, not four. Sub-collections are bounded server-side
(employment 25, education 10, skills 50, languages 10) — no unbounded collection
ever leaves the API.

```ts
export const databasePersonProfile = z.object({
  person: maskedDatabasePerson,
  employment: z.array(z.object({
    companyName: z.string().nullable(), companyDomain: z.string().nullable(),
    title: z.string().nullable(), location: z.string().nullable(),
    isCurrent: z.boolean(), isPrimary: z.boolean(),
    startedOn: z.string().date().nullable(),   // '-infinity' sentinel mapped to null
    endedOn: z.string().date().nullable(),
    startPrecision: z.string().nullable(), endPrecision: z.string().nullable(),
  })).max(25),
  education: z.array(z.object({
    schoolName: z.string().nullable(), degree: z.string().nullable(),
    fieldsOfStudy: z.array(z.string()),
    startedOn: z.string().date().nullable(), endedOn: z.string().date().nullable(),
  })).max(10),
  skills: z.array(z.string()).max(50),
  languages: z.array(z.object({ name: z.string(), proficiency: z.string().nullable() })).max(10),
  confidence: fieldConfidenceSummary,   // reuse the shipped provenance/confidence leaf
});

export const databaseCompanyProfile = z.object({
  company: maskedDatabaseCompany,
  locations: z.array(masterLocationDto).max(10),
  headcountSeries: z.array(z.object({ month: z.string(), employeeCount: z.number().int() })).max(36),
  confidence: fieldConfidenceSummary,
});
```

No channel value (`master_emails` / `master_phones`) appears in either DTO. Presence
booleans only. The egress `.parse()` at the route is load-bearing — it is what
structurally guarantees no Layer-0 identifier and no PII value can leak, exactly as
`databaseSearchPage.parse(page)` does today.

## Repositories (`packages/db`)

| File | Status | Contents |
|---|---|---|
| `masterPersonReadRepository.ts` | extend | `readProfileBySlug` (composed, bounded) |
| `masterPersonSearchRepository.ts` | extend | `op: exclude`, range clauses, new sorts, joins for school/skill/language |
| `masterCompanyReadRepository.ts` | **new** | `MASTER_COMPANY_VISIBLE`, `COMPANY_SELECT`/`COMPANY_FROM`, `readCompanyBySlug` |
| `masterCompanySearchRepository.ts` | **new** | keyset search + capped count over the visible company population |
| `contactRepository.ts` | extend | `findRevealStateBySlugs` exists; no change |
| `accountRepository.ts` | extend | `findByMasterDomains(tx, workspaceId, domains[])` — the overlay probe for companies |

### `MASTER_COMPANY_VISIBLE` — the new policy predicate

Companies have no visibility model today. People do (`MASTER_PERSON_VISIBLE`), and
the `0123` partial indexes are built on it. The company twin, proposed:

```sql
org_kind = 'company'
AND primary_domain IS NOT NULL
AND field_provenance <> '{}'::jsonb
```

Three populations this deliberately excludes, and why:

1. **Schools.** `masterProfileRepository` mints education institutions as
   `master_companies` rows with `org_kind = 'school'`. A university in a company
   search is wrong; `orgKindCopy.ts` exists because this already bit the UI once.
2. **Rows with no addressable key.** `primary_domain` is the URL-shaped key the
   cursor and the profile route address, and `uniq_master_companies_primary_domain`
   already guarantees it is unique.
3. **Minted stubs — the clause that actually matters.** A company first observed as a
   numeric LinkedIn id on someone's position is minted with `name` +
   `linkedin_company_id` and no firmographics at all.

> **The domain clause does NOT exclude stubs — measured, 2026-08-21.** The first
> draft of this predicate justified `primary_domain IS NOT NULL` as the stub filter.
> Production says otherwise: `fillCompanyPrimaryDomain` back-fills domains onto minted
> stubs from the employer's website, so **3,747 rows pass a domain-only predicate and
> only 231 of them carry any firmographics** — 94% would render as blank rows. That is
> the "empty filter destroys trust" failure moved down to the row level.
>
> | Candidate predicate | Rows |
> |---|---|
> | `org_kind='company'` | 4,189 |
> | `+ primary_domain IS NOT NULL` (first draft) | 3,747 |
> | `+ field_provenance <> '{}'` (**adopted**) | **231** |
> | `+ (industry OR employee_count OR description) IS NOT NULL` | 231 |
>
> `field_provenance <> '{}'` and the firmographic test select the identical set, and
> the provenance clause is preferred because it is the **cause** — `updateCompanyProfile`
> stamps it if and only if a company document actually landed — rather than a symptom
> that would go stale if a landing ever wrote only a logo. `prov_hwm` was also
> considered and rejected: it is never written (0 rows).

> **Verified against the schema:** `master_companies` has **no** merge tombstone —
> `merged_into_person_id` exists on `master_persons` only. Do not add a
> `merged_into_company_id IS NULL` clause; there is no such column. When a company
> merge tombstone is introduced, this fragment and the `0134` partial indexes must
> change together, in one migration.

> **Cost, stated honestly:** 20 landed companies (251 → 231) have no domain yet and
> are therefore invisible. `fillCompanyPrimaryDomain` closes that on the next company
> document. Same posture as `p.full_name IS NOT NULL` on the people side — a sellable
> result must have an identity and something to say.

Like `MASTER_PERSON_VISIBLE`, the predicate lives in **one exported fragment applied
inside every read**, so no caller can forget it, and the partial indexes in `0134`
are built on exactly that predicate.

## Pagination — keyset, and the filtered-keyset correction

Cursor, never offset (api-contract). Encoded base64url JSON, opaque to the client,
carrying no Layer-0 id.

| Population | Sort key | Cursor payload |
|---|---|---|
| database people, `relevance` / `recently_updated` | `(created_at DESC, linkedin_public_id DESC)` | `{k, s}` (existing) |
| database people, `recently_changed_job` | `(primary_started_on DESC, linkedin_public_id DESC)` | `{k, s}` |
| database companies, `relevance` / `recently_updated` | `(created_at DESC, primary_domain DESC)` | `{k, d}` |
| database companies, `name_asc` | `(name ASC, primary_domain ASC)` | `{k, d}` |
| database companies, `headcount_desc` | `(coalesce(employee_count,-1) DESC, primary_domain DESC)` | `{k, d}` |

**The workspace-exclusion correction.** Because the anti-join cannot live in the ER
query (see the constraint at the top), rows owned by the workspace are removed
*after* the ER page is read. Post-filtering a keyset page is normally a bug — it
returns short pages and, if the cursor is taken from the last *returned* row, it
**skips** the rows that were filtered out. `searchRepository.ts` documents exactly
this failure for the suppression anti-join.

The correct form, which this spec mandates:

- Read `limit * OVERFETCH + 1` candidates from ER (`OVERFETCH = 3`, capped at 300).
- Probe the overlay once for those slugs/domains.
- Drop owned rows, return at most `limit`.
- **Derive `nextCursor` from the last CANDIDATE examined, not the last row returned.**

That makes the cursor honest: no row is skipped and none is duplicated. A page may
come back short while `nextCursor` is non-null; the client keeps loading, which is
already how "Load more" behaves. This is written down here because getting it wrong
is silent and expensive.

## Workspace-status filtering

Three states, exposed as a segmented control, resolved client-side into *which
engine runs* rather than as a filter field on the global contract:

| State | Behaviour |
|---|---|
| **All** (default) | owned engine + global engine both run; results merged, owned first |
| **Only my workspace** | global engine disabled; the owned engine alone answers — sorting and counts are exact |
| **Exclude my workspace** | owned engine disabled; the global engine runs with the filtered-keyset correction above |

This keeps the global contract free of a workspace-dependent predicate and gives the
two non-default states a single, correctly-sorted population.

> **Known wart, in All mode.** The merged grid is two concatenated sorted lists, not
> one sorted list — owned rows always sort above global ones. This is existing
> People-tab behaviour, inherited by Accounts. It is not fixable without either
> bridging every owned record to Layer-0 or breaking the role wall. Mitigation: a
> subtle labelled divider between the two sections so the ordering is legible rather
> than mysterious, and the two single-population modes above for anyone who needs a
> true sort. Recorded as risk R6.

## Count strategy

- **Workspace contacts** — unchanged: `CONTACT_COUNT_CAP = 10_000`, `{total, capped}`,
  rendered `10,000+`.
- **Global people and global companies** — currently `count(*)`, exact and uncapped.
  This spec **caps both** at `DATABASE_COUNT_CAP = 10_000` using
  `SELECT count(*) FROM (SELECT 1 … LIMIT 10001) t`, returning `{total, capped}`.
  Rationale: an exact count over a trgm-filtered population has unbounded cost, and
  nothing bills or gates off this number — it is a header. Adding `capped` is an
  additive contract change.
- Exact counts that matter (billing, entitlements) never come from here.

## Caching

`truepoint-platform` caching: read paths are cached deliberately with explicit
invalidation.

| Read | Tier | TTL | Key | Invalidation |
|---|---|---|---|---|
| global people count | Redis | 120s | `db:cnt:p:{hash(query)}` | TTL only |
| global company count | Redis | 120s | `db:cnt:c:{hash(query)}` | TTL only |
| global suggest | Redis | 300s | `db:sug:{field}:{prefix}` | TTL only |
| industry taxonomy | Redis | 3600s | `db:industries` | TTL only + on `0128`-class migration |
| company profile | Redis | 300s | `db:prof:c:{domain}` | TTL only |
| person profile | Redis | 60s | `db:prof:p:{slug}` | TTL only |
| **`inWorkspace` overlay probe** | **never cached** | — | — | it is per-workspace and flips on add |
| global search page reads | not cached | — | — | keyset pages are cheap; correctness cost outweighs |

**A new `databaseReadCache`, not the existing `searchReadCache`.** The shipped tier
is *generation-keyed* on a per-workspace Redis counter INCR'd by contact mutations.
Reusing it for global reads would be wrong twice: an unrelated workspace write would
evict global entries, and a Layer-0 landing — the only thing that actually changes
this data — would **not**. So the global tier is TTL-only, in a separate namespace.
Everything fails open: a Redis error degrades to the loader, never to an error.

## Rate limits

Declared in the contract and enforced server-side via shared Redis counters.

| Endpoint | Limit | Why |
|---|---|---|
| `POST /search/database`, `/companies` | per user, search-tier | expensive trgm scans |
| `GET …/people/:slug`, `…/companies/:domain` | **per user, 120/min** | these are enumeration surfaces — a slug or a domain is guessable. See `04-permission-changes.md` R2 |
| `POST /contacts/from-database` | unchanged (`checkCaptureRate`) | one row per explicit gesture (hard constraint 4) |

## Errors

One envelope, RFC 9457 `problem+json`, existing `ProblemDetails`. A person or
company that fails the visibility predicate returns **404**, byte-identical to one
that does not exist — denied and missing are indistinguishable so ids cannot be
enumerated by response shape (api-contract; security access-control).

## Observability

- Structured log per global search: `{ surface, tab, filterCount, hasText, tookMs, hits, capped }` — **no filter values** (a title or company name is user-supplied and can carry PII).
- Counters: `search.database.people.requests`, `.companies.requests`, `.profile.requests`, `.profile.rate_limited`, `.empty_population` (fires when the visible population is zero — the R1 tripwire).
- The `.empty_population` counter is the alert that tells us the Layer-0 database went or stayed empty, rather than discovering it from a support ticket.
