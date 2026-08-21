# 04 — Permission Changes

The brief asks for an explicit, reviewable enumeration of every check being relaxed.
This is that list. Governed by `truepoint-security` (final say) and CLAUDE.md rules
3, 4 and 5.

## First, a correction to the framing

The brief describes an "add-to-workspace gate" enforced by API permission checks,
profile detail endpoints, and frontend guards. **There is no such permission check.**
The audit (Phase 0) found:

- No `GET /contacts/:id` exists at all. Contact detail is composed from a search hit
  plus sub-resources, every one of which takes a **workspace contact UUID** and
  resolves Layer-0 through the `master_person_id` bridge.
- The frontend "gate" is three lines in `ProspectPage.tsx` (`:178`, `:302`, `:407`) —
  a database row is not clickable because there is nothing to open.

So this is **not a relaxation. It is a new read surface.** Nothing is being unlocked;
something is being built. That distinction matters for review: there is no old check
to delete, and therefore no risk of deleting one that was load-bearing for something
else.

## What is NEW (net-new authorization surface)

| # | Surface | Who may call it | Returns |
|---|---|---|---|
| N1 | `GET /api/v1/search/database/people/:slug` | any authenticated user with a selected workspace | the **masked** Layer-0 person profile |
| N2 | `GET /api/v1/search/database/companies/:domain` | same | the **masked** Layer-0 company profile |
| N3 | `POST /api/v1/search/database/companies` (+ `/count`) | same | global company search page |
| N4 | `GET /api/v1/search/database/suggest`, `/industries` | same | global typeahead / taxonomy |

Every one is `authn` → `tenancy` → `requireWorkspace`. No new role is introduced;
none is bypassed. `requireWorkspace` stays because the response carries the
per-workspace `inWorkspace` flag, which is a workspace-scoped fact.

## What is UNCHANGED — the lines this work does not cross

Written as a checklist so review can verify each one rather than trust prose.

1. **Channel values stay paid and gated.** `master_emails` / `master_phones` values
   never appear in any new DTO. The profile carries `hasEmail` / `hasPhone` presence
   booleans and, for **S-04**, `hasMobile` — never an address or a number. Reveal is
   unchanged: credit-gated, entitlement-capped, `MASTER_CHANNEL_REVEAL_ENABLED`, and
   only for a record the workspace holds. **A-01 and A-03 hold.**

2. **Reveal is not offered on a database profile.** The primary action is
   `Add to workspace`. A record must be in the workspace before reveal exists as a
   control — the shipped monetization boundary, untouched.

3. **No workspace-overlay fact leaves its workspace.** A database profile shows no
   owner, stage, tags, activities, notes, scores, or reveal state. This is structural,
   not a UI choice: Layer-0 has **no workspace column**, so the global read has
   nothing workspace-scoped to expose. The overlay probe returns exactly one thing —
   *does the caller's own workspace hold this record* — and it runs under
   `withTenantTx`, RLS-scoped to the caller. `truepoint-data` ownership-and-sharing
   is preserved: seeing a global record never implies seeing another rep's or another
   tenant's work on it.

4. **`MASTER_PERSON_VISIBLE` still applies to every read.** A `private`
   (workspace-minted), `is_suppressed`, or merged person is invisible — 404,
   byte-identical to "does not exist", so ids cannot be enumerated by response shape.
   The co-op boundary holds: workspace-minted people are never sold back to anyone.

5. **`MASTER_COMPANY_VISIBLE` applies the same way** to the two new company surfaces.

6. **No Layer-0 UUID crosses the API boundary.** Addressing stays URL-shaped —
   `linkedin_public_id` for people, `primary_domain` for companies. The egress
   `.parse()` on every route is what guarantees it, exactly as
   `databaseSearchPage.parse(page)` does today. This is the 2026-08-18 D4 posture,
   applied unchanged to the new surfaces.

7. **The role wall stays.** `leadwolf_app` remains REVOKEd from every `master_*`
   table. Nothing in this work grants it access; all Layer-0 reads run under
   `withErTx` (`leadwolf_er`). See `02-backend-spec.md` §A hard constraint.

8. **`POST /contacts/from-database` is unchanged** — `requireRole("owner","admin","member")`,
   `checkCaptureRate`, one row per explicit user gesture. Hard constraint 4 holds:
   nothing here introduces bulk or background acquisition.

9. **No new contributor currency.** Nothing in this work creates points, bounties, or
   rewards. CLAUDE.md rule 7 untouched.

## New risk this creates: enumeration

Making a global profile readable by any authenticated user turns `:slug` and
`:domain` into an **enumeration surface**. A determined user could walk the database
one profile at a time.

Threat, honestly stated:

- **What they get** — masked profile facts: name, title, employer, location, history,
  education, skills. This is the *browsable* half of the product, which the operator
  has decided is what the Search surface sells access to.
- **What they do not get** — any email or phone. The monetized asset is untouched, so
  a full walk of the database yields no contactable records.
- **Cost to them** — one authenticated HTTP request per record.

Controls, all of which must ship with N1/N2:

| Control | Detail |
|---|---|
| Per-user rate limit | 120 profile reads/min, Redis counter shared across instances, `429` + `Retry-After` |
| Per-tenant rate limit | a second, higher ceiling so one tenant cannot burn the tier through many users |
| Structured logging | `{ userId, tenantId, surface, key }` on every profile read — **no PII values** |
| Metric + alert | `search.database.profile.requests` per tenant; alert on a sustained outlier, which is what a walk looks like |
| Bot/edge defence | the existing WAF posture (`truepoint-security` abuse-and-edge) covers the origin |

### DECIDED 2026-08-21 — rate limits only; profile views are NOT a metered plan dimension

The open question was whether an *entitlement* should cap profile views per plan, the
way `reveal_month` caps reveals. Decided against, on evidence rather than taste:

| Check | Production state |
|---|---|
| `entitlement` rows | **0** |
| `subscriptions` rows | **0** |
| `plan_templates` | 2 rows, both `features: {}` |
| Live `requireEntitlement` mount points | **exactly one** — `reveal_month` on `POST /contacts/:id/reveal` |
| `resolveEntitlement` behaviour with no covering grant | **fails open** |

Three reasons, in order of weight:

1. **The monetized asset is unchanged.** The one metered dimension that exists meters
   the *channel purchase*. Profile viewing is the browsable half of the product, which
   the operator has decided the Search surface sells access to. Metering the browse
   would be a pricing change smuggled in as an access-control change.
2. **A `profile_view_month` key would configure nothing.** With an empty `entitlement`
   table and empty `plan_templates.features`, the resolver fails open — so the key
   would be inert and the *actual* control would still be the rate limiter. This
   codebase already carries three recorded instances of staff-facing configuration
   that configures nothing (`retention_policies`, `master_confidence_policy`,
   `tenants.status` — audit 32 §9C/§9D/§9E, and the highest-severity finding of that
   audit). Knowingly adding a fourth is the mistake, not the caution.
3. **It stays reversible and additive.** If pricing later wants the cap, it is one
   middleware line per route — `requireEntitlement("profile_view_month")` — plus the
   grant rows. Nothing in the contract, the DTOs, or the client has to change.

The seam is left as a comment at both route definitions rather than as dead config.
Revisit when `plan_templates.features` is actually populated and a paying subscription
exists — not before.

## Compliance impact (CLAUDE.md rule 3)

This change touches personal data — it makes Layer-0 person records readable to more
authenticated users than before. Against `docs/strategy/09-compliance.md`:

| Item | Assessment |
|---|---|
| **Lawful basis** | Unchanged. Every field is served through `MASTER_PERSON_VISIBLE`, which admits only `licensed` / `coop` rows — the populations whose basis was established at landing. `private` rows are never served. |
| **Provenance** | Unchanged and improved: the profile DTO carries the confidence/provenance summary, so **A-01** ("every stored field has provenance and a lawful basis") becomes *visible* on more surfaces rather than less. |
| **Suppression** | Enforced at read via the predicate, not only at landing. A suppressed person is 404 on the new endpoints as on the existing ones. |
| **DSAR / erasure** | Unchanged. Erasure sets `is_suppressed`, which the predicate already honours on every read including the two new ones. No new copy of personal data is created — the new endpoints are reads, and the caches hold masked projections with a ≤300s TTL. |
| **Data minimisation** | The profile is bounded (25 stints / 10 schools / 50 skills / 10 languages) and carries no channel values. `truepoint-data` search-infrastructure's "keep the projection lean, fetch detail on open" is what this implements. |
| **Residency** | Unchanged — no new storage, no new cross-region movement. `region` / `jurisdiction` columns are untouched. |
| **Audit** | Profile reads are logged (above) but are **reads**, not mutations, so they do not enter `platform_audit_log` — consistent with how search reads are treated today. |

**No new PII is collected, stored, or exported by this work.** It changes who may
*view* already-stored, already-lawfully-based, masked records inside the product.

> If the human reviewer disagrees with any row above, this is the stop-and-ask point
> named by rule 3 — not after the code is written.
