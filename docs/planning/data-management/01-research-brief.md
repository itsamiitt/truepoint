# 01 — Research Brief (Cross-Cutting Data Management)

> **Gate status: RESEARCH.** This is the cross-cutting research gate for the data-management plan
> series (`docs/planning/data-management/`). It must be reviewed and signed off (§7) before any
> per-dimension Phase-1 design begins. It establishes shared vocabulary, competitor benchmarks, the
> canonical primitives every later phase depends on, and a risk register grounded in the **current
> code**. **Compiled 2026-06-26.** House style: `list-plan/01-research-summary.md` + the epistemic
> legend of `research/sales-intelligence-data-research.md`. Product brand **TruePoint**; code scope
> **`@leadwolf/*`** — both correct by design.

## How to read this (epistemic legend — read first)

Every external claim is tagged; every "current behaviour" claim cites `file:line`.

- **✅ Verified** — confirmed against a primary source this run (and, for the 5 gap deep-dives,
  survived an adversarial verify pass).
- **📄 Directional** — a real source supports it, but the specific figure/detail was not pinned to a
  primary source; treat as directional.
- **🧭 Domain** — standard industry practice / synthesis (knowledge cutoff Jan 2026), not
  independently re-verified.
- **⚠️ Do-not-rely** — refuted or could-not-confirm; recorded so it is not repeated.
- **`file:line`** — first-hand read of the shipped code in this repo (the source of truth for
  "current behaviour").

> **Headline finding (read before §3 and §6).** The brief that commissioned this gate carried three
> premises from an external audit (codes `A3`/`A6`, which **do not exist** in this repo's own
> register — it uses `G-*` codes in `28-enterprise-readiness-audit.md`). **All three are refuted or
> mischaracterised by the current code:** the normalizers are *not* triplicated, there is *no*
> hardcoded country-code domain list driving false merges, and enrichment has *no* SSRF surface. The
> canonical primitives this brief is meant to "define once" **already exist, consolidated, in a
> single shipped module.** §3 documents them as the source of record; §6 records the *real*
> residuals in their place. This is a deliberate, evidence-based correction, not a gap to fill with
> new code.

---

## 1. Purpose

Establish a single source of truth for how data management works in TruePoint before committing to
per-dimension designs, and prevent the failure mode where multiple normalizers, dedup paths, and
import pipelines diverge. Concretely this brief: (a) answers each research question with a finding +
citation; (b) pins the canonical primitives to their one shipped implementation; (c) seeds an honest
risk register; (d) supplies the sign-off checklist that gates Phase 1.

It is **standalone**: findings are restated in-doc so it reads without chasing cross-references.
Where a prior artifact already settled a question, it is cited as corroboration — chiefly the 26-doc
`prospect-company-data/` corpus, `list-plan/01-research-summary.md`,
`research/sales-intelligence-data-research.md`, and ADRs 0003/0005/0006/0007/0013/0015/0021/0025/0037.

---

## 2. Findings — question → finding → citation

### 2.1 Identity & dedup

| Question | Finding | Citation |
|---|---|---|
| How do Apollo/ZoomInfo/Clay/Cognism model person/company identity & what is authoritative? | **Email-first** is the dominant authoritative key: Cognism makes email the primary match key; Apollo's precedence is email → name+company → domain/LinkedIn; companies key on **domain**. Fuzzy matching kicks in ~>85% similarity. Clay is an orchestrator over 150+ providers (waterfall), not a single identity authority. (✅) | `list-plan/01-research-summary.md` §B [16][7]; `research/sales-intelligence-data-research.md` §1 |
| Deterministic vs probabilistic match for a LinkedIn-rich + CSV (URN-poor) world? | **Deterministic keys for the common case, probabilistic for the fuzzy tail** is the accepted model: deterministic email/LinkedIn/phone/domain → blocking + MinHash/LSH candidate generation → **Splink** (Fellegi-Sunter) scoring → survivorship. (✅) | ADR-0021 Decision; ADR-0015; `research/...` §4 (Splink MIT, Zingg AGPL) |
| What is the current TruePoint identity hierarchy in code? Are the normalizers triplicated (`A3`)? | **Single deterministic ladder** (strongest→weakest): email blind index → LinkedIn public id → E.164 phone → registrable domain → fuzzy name+company. **`A3` is REFUTED** — normalizers live in one module and are reused; the matcher header states verbatim *"reuse the existing import normalizers (do NOT reimplement)"*, and ADR-0037 C5 **forbids** a second normalizer. The code uses LinkedIn **public id (slug)**, not URN — a refinement to reconcile (the brief said "URN"). (✅) | ladder `enrichment/bulk/overlayMatcher.ts:20-25`; `enrichment/matchKeys.ts:1-10`; `import/normalize.ts`; ADR-0037 C5 / `prospect-company-data/PLAN_00` C5 |
| Hardcoded country-code domain list causing false company merges (`A6`)? | **REFUTED / mischaracterised.** Domains are reduced to **eTLD+1 via the Public Suffix List** (`tldts`, `allowPrivateDomains:false`) — handling multi-part suffixes like `corp.co.uk` correctly; there is **no** hardcoded country-code list. The only hardcoded list is a **freemail/role blocklist** that *prevents* a consumer mailbox (gmail.com) from minting a fake "Gmail Inc." company — the **opposite** of A6's claimed failure mode — and is kept separate to preserve the pure eTLD+1 contract. (✅) | `enrichment/matchKeys.ts:70-81` (`registrableDomain`); `enrichment/freemailDomains.ts:1-72` |
| Confidence model — thresholds for auto-merge / review / no-merge? | **Calibrated two-threshold routing** (Fellegi-Sunter): ≥ high cutoff → survivorship-merge; between → clerical-review queue; < low cutoff → distinct. Deterministic hits are confidence **1.0**; the fuzzy threshold is an injected option. Thresholds + targets (ER precision ≥0.95, false-merge ≤0.5%) are **calibrated, not hardcoded**, owned by `22-data-quality-freshness-lifecycle.md` §5-6. MVP is deterministic-only (`review_status='auto'`). (✅) | `overlayMatcher.ts:62-68,96-118`; ADR-0015 (calibrated routing, survivorship); `prospect-company-data/PLAN_00` C5/C9 |

### 2.2 Enrichment

| Question | Finding | Citation |
|---|---|---|
| Waterfall design — order providers, stop on first acceptable result; cost-vs-accuracy? | **Implemented.** Providers ordered by `trust / max(1,cost)`; sequential first-hit-wins, with a per-process **circuit breaker** (3 errors → open 60s) and a **bulk** mode that races cheap providers and runs expensive ones after. Industry: single-source ~50-62% match, multi-source waterfall 85-95% (+30-60% coverage). (✅) | `enrichment/waterfall.ts:8-43,51-60,117-174`; providers `integrations/.../providers.ts:44-104`; `list-plan/01-research-summary.md` §B [16][17] |
| Self-hosted Reacher accuracy vs commercial; catch-all handling? | See **§5.2**. Reacher is a competent SMTP prober that can only **flag** catch-all (→ "risky"), never resolve it; realistic ceiling ~95-98% on honestly-responding domains. **No verifier is wired today** — a `passThroughVerifier` keeps the stored status (vendor is an open question). (✅ code / 📄 accuracy) | §5.2; `data-health/emailVerifier.ts:14-18` |
| Phone line-type validation & TCPA relevance (mobile vs landline gating)? | See **§5.3**. Line-type (mobile vs landline) gates TCPA consent. **Today** phone validation is an **E.164 regex only**; the `direct/mobile/hq` line types need a lookup provider that is **not wired**, and there is **no TCPA/DNC** integration. (✅ code) | §5.3; `data-health/validatePhone.ts:7-12`; line types `@leadwolf/types` |
| Cache / cost controls (never pay twice)? | **Implemented.** Provider answers cached on a SHA-256 `requestHash` of the normalized request, keyed `(workspaceId, requestHash)`; a daily platform budget breaker throws before any call. Charge-on-reveal, not enrichment. (✅) | `enrichment/requestHash.ts`; `enrichment/enrichContact.ts:121-135`; `06-enrichment-engine.md` §1 |

### 2.3 Provenance

| Question | Finding | Citation |
|---|---|---|
| Field-level provenance: JSONB `fieldSources` vs a normalized table? Query cost, audit, GDPR "source of data"? | **Decided & shipped: one JSONB `field_provenance` winner-map** per row on both overlay (`contacts`/`accounts`) and master rows, holding only the winning descriptor per field. Short-keyed for billions-row TOAST economy. The normalized shape is retained **only** for the `master_emails`/`master_phones` channels. (✅) | `@leadwolf/types fieldProvenance.ts:1-42`; `prospect-company-data/PLAN_03`; BRAINSTORM_03 (Substrate C); ADR-0003 (the layered raw→provenance→golden it revives at Layer 0) |
| Provenance record shape? | Descriptor `{src, mth, conf, obs, ver, pin, by, at}` — `src` is a **platform-level** label (`provider:zoominfo`/`import:apollo`/`user_edit`/`reveal`/`master`), **never** a workspace id; `pin=true` is a human override that blocks overwrite. The brief's `{source, value, confidence, observed_at, license}` maps onto this: *value* lives in the field itself; ***license/lawful basis*** lives at Layer 0 in `source_records.lawful_basis_snapshot`. Email/phone channel provenance is deferred to Phase 4 `revealed_channels`. (✅) | `fieldProvenance.ts:19-37,51-59`; write/pin logic `prospect/fieldProvenance.ts:40-80`; `source_records` `03-database-design.md §5.1`, ADR-0021 |

### 2.4 Compliance

| Question | Finding | Citation |
|---|---|---|
| GDPR Art. 14 notice for data not obtained from the subject; LI basis limits? | See **§5.4**. Indirect collection triggers a transparency duty including the **source** of the data (Art.14(2)(f)); timing ≤1 month / first contact / first disclosure, whichever first; the "disproportionate effort" escape is narrow. LI (Art.6(1)(f)) needs a documented LIA and is subject to an **absolute right to object** → suppression. ePrivacy separately gates the *send*. (✅) | §5.4; `08-compliance.md` |
| India DPDP applicability to B2B contact data; consent/notice duties? | See **§5.1**. **No B2B carve-out**; the product is a Data Fiduciary; the public-data exclusion is narrow and unreliable for scraped data; **no "legitimate interests" basis** exists — consent or a closed-list legitimate use only. Core obligations enforceable **13 May 2027**. (✅) | §5.1 |
| TCPA + DNC pre-dial scrubbing; CAN-SPAM suppression? | See **§5.3**. National DNC scrub **≥ every 31 days** + internal DNC honored immediately; FCC one-to-one consent rule **vacated** (IMC v. FCC, 24 Jan 2025). CAN-SPAM: honor opt-out ≤10 business days, valid postal address, truthful headers. Today: a **tri-scoped suppression list** (global/tenant/workspace) gates reveal+send; no DNC-registry/line-type scrubbing. (✅) | §5.3; suppression `db/src/rls/billing.sql:62-81` |
| CCPA/CPRA right-to-know/delete for B2B personal data? | **No B2B exemption** post-2023 sunset; business contacts have full rights; honor opt-out of sale/sharing + GPC. DSAR/erasure must cascade across all copies — provable via the golden identity. (✅) | `list-plan/01-research-summary.md` §F.3 [30]; `research/...` §2; ADR-0021 (deletion cascades golden→source→overlays) |

### 2.5 Storage & scale

| Question | Finding | Citation |
|---|---|---|
| Multi-tenant isolation pattern at TruePoint's scale; index strategy for owner- + tenant-scoped queries? | **Two-tier tenancy enforced below the app layer by Postgres RLS.** Overlay tables `ENABLE`+`FORCE` RLS with a **fail-closed** predicate on a tx-local GUC; Layer-0 master graph has **no RLS** — isolation is **by access path** (grant-off: the app role has no DML on `master_*`). Indexes back the owner/tenant queries (`idx_contacts_ws_owner`, partial `priority_score`, GIN on `custom_fields`). (✅) | predicate `db/src/rls/contacts.sql:17-48`; GUC `db/src/client.ts:64-84`; Layer-0 `db/src/rls/masterGraph.sql`; AWS SaaS isolation tenets [28][29] |
| Projection/search for lakh-row filtered search? | **Today: Postgres-native** faceted search (term/numeric/boolean facets + keyset pagination) run *inside* `withTenantTx`, so RLS is the hard boundary — **no external engine wired yet**. The billions-scale path (OpenSearch + ClickHouse + Typesense, CDC-fed) is **designed and deferred** to the gated scale track. (✅) | `db/src/repositories/searchRepository.ts`; ADR-0021 / ADR-0035 (deferred topology); `prospect-company-data/PLAN_05` |

### 2.6 Sync

| Question | Finding | Citation |
|---|---|---|
| Bi-directional CRM sync conflict resolution (LWW vs field-level SoT vs CRDT)? | See **§5.5**. Industry uses **field-level source-of-truth + LWW tiebreak + review queues**; **CRDTs are not used** for CRM field sync. **Today TruePoint has NO CRM sync** — Salesforce/HubSpot appear only as **import `source_name` values**, not live integrations; webhooks are **outbound-only**. (✅ code) | §5.5; sources enum `db/src/schema/contacts.ts:268-269`; webhooks `db/src/schema/webhooks.ts` |

---

## 3. Canonical primitives — defined ONCE (signatures + semantics)

These are the primitives every phase reuses. **They already exist as shipped code**; this section is
the source-of-record index, not a proposal for new code. The one rule: **never add a second
implementation** (ADR-0037 C5 / `prospect-company-data/PLAN_00` C5).

### 3.1 Normalizers — one module (`@leadwolf/core`)

`packages/core/src/import/normalize.ts` (pure, applied *before* hashing/encryption):

```ts
normalizeText(raw): string | undefined                 // :9   trim + collapse-ws, non-empty
normalizeEmailForStorage(raw): string | undefined      // :16  trim+lowercase, must contain "@"
normalizeEmailForIndex(storageEmail): string           // :22  storage form minus local-part "+tag"
emailDomainOf(storageEmail): string | undefined        // :33  domain facet (non-PII)
normalizeDomain(raw): string | undefined               // :39  lowercase, strip scheme/path/www
linkedinPublicIdOf(raw): string | undefined            // :48  /in/<slug> → slug (lowercase)
```

`packages/core/src/enrichment/matchKeys.ts` (deterministic match keys; reuses the above — does
**not** reimplement them):

```ts
registrableDomain(input): string | undefined           // :74  eTLD+1 via PSL (tldts), ICANN-only
toE164(phone, defaultRegion?): string | null           // :87  libphonenumber-js, validity-checked
canonicalName({firstName,lastName,fullName}): {canonical,tokens} | undefined  // :101 accent-strip, Unicode-safe
buildMatchKeys(row): MatchKeys                          // :132 composes all keys for one sparse row
```

**Semantics that matter:** email gets a *storage* form (encrypted) and an *index* form (plus-tag
stripped, blind-indexed for dedup); dots are **not** stripped (gmail-only; would merge distinct
identities). `registrableDomain` stays a **pure** PSL eTLD+1 key. The **freemail guard** is a
separate layer:

```ts
// packages/core/src/enrichment/freemailDomains.ts
FREEMAIL_DOMAINS: ReadonlySet<string>                  // :20  consumer/ISP/role blocklist (NOT country-code)
companyDomainKey(input): string | undefined            // :68  registrableDomain() minus freemail veto
```

`companyDomainKey` returns `undefined` for a freemail domain so it can never mint a company node —
the guard that *prevents* the false-merge the brief's `A6` feared.

### 3.2 Identity key hierarchy

Ordered signals, strongest→weakest (`overlayMatcher.ts:20-25`, mirrored by the `master_*` global
keys in ADR-0021):

1. `deterministic_email` — blind index of the plus-stripped, lowercased email
2. `deterministic_linkedin` — LinkedIn public id (slug)  *(reconcile with the brief's "URN")*
3. `deterministic_phone` — E.164
4. `deterministic_domain` — registrable domain (eTLD+1)
5. `fuzzy_name_company` — canonical name + company name (Splink-scored tail)

The first method the row **has** and a candidate **agrees on** wins. Global resolution adds blocking
+ MinHash/LSH before Splink to avoid O(n²) (ADR-0021). The `MatchPort` seam abstracts the lookup;
`masterGraphMatcher` is a stub until the scale track lands (ADR-0037).

### 3.3 Confidence scale

- Deterministic hit → **1.0** (free internal match).
- Fuzzy hit → Splink probabilistic score, routed by **two calibrated thresholds**: ≥ high →
  survivorship-merge; between → **clerical-review queue** (not auto-merged, not billed); < low →
  distinct.
- Survivorship per field, in order: **source priority** (verified provider/master > user import >
  inferred) → **recency** → **completeness**; every merge is audited for un-merge.
- Thresholds are **calibrated against a reviewed sample** to ER precision ≥0.95 / false-merge ≤0.5%
  — **owned by `22-data-quality-freshness-lifecycle.md` §5-6**, never hardcoded.

### 3.4 Provenance record shape

One JSONB descriptor per provenance-worthy field (`fieldProvenance.ts:19-37`):

```ts
{ src: string,        // "provider:zoominfo" | "import:apollo" | "user_edit" | "reveal" | "master"  (NEVER a workspace id)
  mth?: string,       // match_method from the matchKeys ladder
  conf?: number,      // [0,1]
  obs?: string,       // observed_at (valid-time)
  ver?: string,       // last_verified_at
  pin?: boolean,      // human override — blocks later overwrite
  by?: string, at?: string }   // pin actor + timestamp (iff pin=true)
```

Lawful basis / "source of data" for GDPR/DPDP lives at Layer 0 in
`source_records.lawful_basis_snapshot`; email/phone channel provenance → Phase 4 `revealed_channels`.

### 3.5 Tenant / workspace / owner scoping rule

The canonical predicate every overlay read/write applies (`db/src/rls/contacts.sql:17-48`):

```sql
ENABLE + FORCE ROW LEVEL SECURITY;
USING / WITH CHECK ( workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid )
```

- Set **transaction-local** by `withTenantTx` (`db/src/client.ts:64-84`), which first
  `SET LOCAL ROLE leadwolf_app` (non-BYPASSRLS) so RLS is enforced even on a privileged base
  connection. Unset/empty GUC → **zero rows** (fail-closed). Tenant-scoped tables use the
  `tenant_id` analog.
- **Layer 0** carries no `workspace_id`; isolation is **structural** — `leadwolf_app` has no DML
  grant on `master_*` (`db/src/rls/masterGraph.sql`). Sanctioned privileged paths:
  `withPrivilegedTx` (DSAR fan-out), `withErTx` (`leadwolf_er` resolution), `withPlatformTx`
  (audited staff).
- **Within a workspace, owner-scope is an app-layer soft filter** (not RLS): client-supplied IDs are
  re-filtered through `contactRepository.visibleContactIds()` inside the RLS tx before any mutation,
  and `bulkActions.ts:86-100` enforces role-based owner assignment. "My prospects"/"my lists" are
  filters, not a new access wall (`prospect-company-data/PLAN_00` C10).

---

## 4. Competitor benchmarks (re-derived)

| Platform | Primary identity key | Match approach | Verification | Network |
|---|---|---|---|---|
| **Apollo** | email → name+company → domain/LinkedIn ([16]) | deterministic-then-fuzzy | ~80% acc. (📄); Found/Verified/Compliant trichotomy ([20]) | contributory (Living Contributor Network) ([24]) |
| **ZoomInfo** | email/company/URL identifiers ([3]) | ListMatch against 250M/100M ([3]) | ~85% (📄) | contributory (Community Edition, 50M signals/day) ([23]) |
| **Clay** | per-enrichment config ([6]) | **waterfall over 150+ providers** ✅ | provider-dependent | none (orchestrator) |
| **Cognism** | **email (primary)** ([7]) | per matched record | ~90% (📄) | public + vendors; processor ([26]) |
| **TruePoint** | email blind index → LinkedIn slug → E.164 → eTLD+1 → fuzzy | deterministic ladder → Splink tail; match-against, **co-op OFF** | verifier not yet wired (§5.2); charge-for-verified live | **match-against only** (ADR-0021; D1) |

Benchmarks: waterfall lifts coverage +30-60% over single-source ([16][17]); verification chain is
syntax→MX→SMTP→confidence with vendor "95-99%" claims treated as marketing — **measure your own
bounce rate** ([20][21]). B2B data decays ~2.1%/mo (📄, treat as directional) → re-verify at point
of use, not once at import. ⚠️ Do-not-rely: specific provider pricing and the "85%/80%" accuracy
benchmark (refuted in `research/sales-intelligence-data-research.md`).

---

## 5. Gap deep-dives (cited web-research pass — fresh primary sources)

These five questions are not covered by the existing corpus. Each was researched against primary
sources and run through an adversarial verify pass; corrections are folded in.

### 5.1 India DPDP Act 2023 — applicability to B2B (verify verdict: **sound**)

- **No B2B / business-contact carve-out (✅).** "Personal data" = data about an identifiable
  individual (s.2(t)); a sales-intelligence/CRM/enrichment product is a **Data Fiduciary** (s.2(i))
  processing **Data Principals** (s.2(j)). Work email/phone/title/company tied to a person is in
  scope. ([FPF], [Vinod Kothari])
- **The public-data exclusion is narrow & unreliable for scraped data (✅).** s.3(c)(ii) excludes
  only data the **Data Principal themselves** made public, or data published under a legal
  obligation. Whether scraped/cached/republished/third-party-posted profiles qualify is **legally
  undefined** — and any verified/appended/inferred field the product generates is **not** "publicly
  available data" regardless. ([dpdpa.com s.3], [Law School Policy Review])
- **No "legitimate interests" basis (✅).** Lawful processing needs **consent** (s.5 notice + s.6)
  **or** a closed-list **s.7 legitimate use** (e.g. s.7(a) data *voluntarily provided* by the
  subject). GDPR-style "legitimate interests"/"contractual necessity" do **not** exist; "deemed
  consent" was removed. Processing prospects who never interacted with the vendor is the hardest case
  to justify. ([dpdpact2023.com ch.2], [EY])
- **Rights & duties (✅).** Access summary (s.11), correction/erasure (s.12), grievance (s.13),
  nomination (s.14); independent erasure duty on withdrawal/purpose-completion (s.8(7)).
- **Timeline (✅).** Act assented 11 Aug 2023; **DPDP Rules 2025 notified 13 Nov 2025**; phased —
  Board provisions immediate, consent-manager regime ~13 Nov 2026, **core penalty-bearing
  obligations 13 May 2027** (incl. notice, consent, breach reporting; ceiling ₹250 crore). *Nuance:*
  the 72-hour clock is the **detailed** breach report to the Board (Rule 7); initial intimation is
  "without delay." ([Privacy World], [Acuity Law])

### 5.2 Reacher (self-hosted email verification) (verify verdict: **mostly-sound + corrections**)

- **Pipeline & output (✅ headline / 📄 granular).** syntax → MX → SMTP connect → `RCPT TO`
  handshake (never sends); returns `is_reachable ∈ {safe,risky,invalid,unknown}` + `smtp.*` booleans
  (`can_connect_smtp`, `is_deliverable`, `is_catch_all`, `has_full_inbox`, `is_disabled`). The strict
  step-ordering and 250→exists/550→invalid mapping are engine-internals inference (📄). ([Reacher
  docs], [GitHub README])
- **Catch-all can only be FLAGGED, never resolved (✅).** A second `RCPT TO` to a random local-part
  still returns 250 → `is_catch_all=true` → classified "risky." This is the structural ceiling of
  any pure SMTP prober. Catch-all domains are ~28-40% of B2B data (📄); commercial verifiers
  (ZeroBounce/NeverBounce/Kickbox) add non-SMTP signals (historical send, domain-behaviour, identity
  matching) Reacher lacks. ([EmailAddress.ai], [Prospeo])
- **Big mailbox providers defeat probing (📄).** Blocked/inconclusive providers most often surface
  as `is_reachable='unknown'` (Gmail-"disabled", Yahoo-always-250, M365/SEG greylisting are commonly
  cited but third-party, not Reacher-primary). ([Reacher debugging guide], [Truelist])
- **Self-hosting is operationally heavy (✅).** Needs outbound **port 25** (blocked by most
  clouds/ISPs), a forward-confirmed **PTR/rDNS**, and **rotating/residential IPs + SMTP proxies** at
  volume; probing can **blocklist your IPs and degrade all outbound mail**. AGPL-3.0 (commercial
  license available). ([Reacher docs], [Spamhaus port-25])
- **Accuracy ceiling (📄).** ~95-98% only on honestly-responding domains; "99%+ across all
  providers" is marketing (a 15-tool benchmark leader hit ~70% on a hard mixed set). Reacher docs
  define "safe" as bounce <2% (an older FAQ said <3% — minor discrepancy). ([Truelist], [Prospeo])

> **Implication for TruePoint:** the shipped `passThroughVerifier` (`emailVerifier.ts:14-18`) is a
> seam, not a verifier. A self-hosted-Reacher-only strategy inherits hard ceilings on the ~28-40% of
> B2B that is catch-all; a hybrid (Reacher for honest domains + a commercial verifier for
> catch-all/Gmail/Yahoo) is the realistic path. The `chargeFor` policy (0-credit on
> invalid/catch_all/unknown) already presupposes a real verifier (`chargeFor.ts:18-34`).

### 5.3 TCPA + DNC + CAN-SPAM (verify verdict: **mostly-sound + corrections**)

- **Line-type gates consent (✅).** Autodialed/prerecorded **marketing** to **wireless** numbers
  needs **prior express written consent (PEWC)**; landlines are looser. Informational autodialed
  calls to wireless need **"prior express consent"** (oral/written) — *not* PEWC, and *not* the
  "invitation or permission" standard (that is the residential/DNC term). *Facebook v. Duguid*
  (2021) narrowed "ATDS" to random/sequential generators, but prerecorded-voice and DNC rules apply
  regardless. → a **line-type lookup before dial/text** is the practical gate. ([SearchBug],
  [ActiveProspect], [Nat. Law Review])
- **DNC scrubbing (✅).** Scrub against the **National DNC Registry ≥ every 31 days** (a max
  staleness window) **and** maintain an **internal DNC** honored immediately; layer in state
  registries + the **FCC Reassigned Numbers Database** (safe harbor, 📄). TSR amendment (16 May
  2024) extended internal-DNC retention 2→5 years. ([FTC DNC FAQ], [TSR DNC FAQ])
- **One-to-one consent rule is DEAD (✅).** FCC 23-107 (Dec 2023) would have barred bundled lead-gen
  consent from 27 Jan 2025; the **Eleventh Circuit vacated it in *IMC v. FCC* on 24 Jan 2025** — it
  never took effect; the prior PEWC standard governs and bundled consent is federally permissible.
  ([Goodwin], [Womble])
- **CAN-SPAM (✅).** Honor opt-out within **10 business days**; keep the mechanism working ≥30 days;
  valid **physical postal address**; truthful headers/subject; **no private right of action** (FTC /
  state AG enforcement; per-email civil penalties — current figure annually inflation-adjusted, ⚠️
  do-not-rely on a specific older number). ([FTC CAN-SPAM guide])
- **TCPA exposure (✅ with nuance).** Private right of action; **$500/violation, up to $1,500**
  willful/knowing. Nuance: §227(b) (ATDS/prerecorded) $500 is a **floor**; §227(c) (DNC) is **"up to
  $500"** — a ceiling — so a flat "$500 per call" slightly overstates DNC-only exposure.
  ([RothJackson])

> **Implication for TruePoint:** the dialer/telephony surface is **not built**; the tri-scoped
> suppression list (`billing.sql:62-81`) is the right foundation but does **not** yet do
> National-DNC/state/reassigned-number scrubbing or line-type gating. These are pre-dial pipeline
> requirements when the dialer ships.

### 5.4 GDPR Art. 14 — indirect collection (verify verdict: **mostly-sound + corrections**)

- **What & when (✅).** Indirect collection requires telling each subject the controller identity,
  purposes + legal basis, categories, recipients, transfers, retention, rights, ADM — and,
  distinctively, **the source of the data incl. whether public** (Art.14(2)(f)). Timing
  (Art.14(3)): within a reasonable period, **at latest 1 month**, or at first communication, or at
  first disclosure to a recipient — **whichever is earliest**. ([gdpr-info Art.14])
- **The "disproportionate effort" escape is narrow (✅).** Art.14(5)(b) is aimed at
  archiving/research/statistics, needs a **documented balancing test**, and even then requires
  **alternative public-notice measures**; cost alone is not enough. ([ICO right-to-be-informed],
  [EDPB WP260])
- **Enforcement exemplars.** *Bisnode* (UODO, 2019): fine ~PLN 943k/~€220k for failing Art.14 on
  "over 6 million" persons it chose not to contact; the WSA later annulled the order **for
  past-only-activity persons** (and annulled the fine), the **NSA dismissed the cassation in 2023**
  → Art.14 duty confirmed for those conducting economic activity (granular 7.5M/682k figures are 📄,
  not in the primary source). **⚠️ Correction (do-not-rely):** the *CNIL* Clearview decision did
  **not** cite Art.14 (it cited Arts 6/9, 12, 15, 17, 31); the standalone **Art.14 "failure to
  inform scraped subjects"** finding came from the **Dutch DPA (AP, ~€30.5m, 2024)** — cite that as
  the scraping exemplar. ([Légifrance CNIL], [UODO Bisnode], [Dutch DPA])
- **Lawful basis + the send (✅).** B2B prospecting usually relies on **legitimate interests
  (Art.6(1)(f))** with a documented 3-part **LIA**; the **right to object to direct marketing is
  absolute** → suppression. Separately, **ePrivacy (Art.13)** governs the *act of sending*; several
  member states require consent even B2B (soft opt-in exception). CJEU *Inteligo Media* (C-654/23,
  13 Nov 2025) held the soft opt-in is self-standing and, where it applies, **displaces** a separate
  GDPR Art.6 consent (it *relaxed*, not tightened). ([ICO legitimate interests], [Fieldfisher],
  [Freshfields])

### 5.5 CRM bi-directional sync conflict resolution (verify verdict: **mostly-sound + corrections**)

- **Four strategies in practice (📄 taxonomy).** LWW by timestamp; **field-level source-of-truth**
  (a master system per field); manual review/exception queues; field-level non-overlapping merge —
  with a time-threshold anti-ping-pong safeguard (the "5-min" figure is illustrative, not a
  standard). ([Stacksync], [Exalate])
- **CRDTs are NOT used for CRM field sync (🧭).** CRMs are authoritative mutable records over
  rate-limited REST APIs with no per-field causal metadata; CRDTs fit collaborative/offline apps,
  not CRM sync. ([crdt.tech])
- **Native dedup-on-write (✅).** HubSpot auto-matches contacts on **email**, companies on **primary
  domain** — but **API-created companies are NOT auto-deduped by domain** (must supply Record ID or
  search-then-upsert). Salesforce uses **Matching Rules + Duplicate Rules** (Block / Allow+Alert) on
  create/edit; `DuplicateRuleHeader allowSave` can bypass; some paths skip rules → don't rely on
  SF-side dedup alone. ([HubSpot dedup], [Salesforce Ben], [SF DuplicateRuleHeader])
- **Unified APIs leave conflict resolution to you (📄).** Merge.dev/Paragon/Tray provide field
  mapping + direction control but pass writes through rather than running a field-level conflict
  engine; dedicated sync engines (Stacksync, Syncari) market per-field rules. *Correction:* Paragon
  markets **real-time** (webhook/event) sync, not purely polling. ([Merge writes], [Paragon])
- **Rate/cost constraints (✅).** SF ~100k API req/day +1k/user, Bulk API 15k batches/24h
  @10k/batch; HubSpot ~190 req/10s, 625k-1M/day, batch endpoints cap 100 records/request → always
  **upsert on a stable key**, batch, diff-and-write-changed-only, backoff on 429. ([SF API limits],
  [HubSpot limits])
- **Recommended pattern (🧭).** field-level source-of-truth + **dedup-on-write (upsert on a stable
  key)** + explicit per-field sync direction + **never overwrite human-edited fields** (use the
  `field_provenance` `pin` + a verification-status field + confidence thresholds + staging fields).
  TruePoint's `field_provenance.pin` (§3.4) already models the "protect human edits" half.

> **Implication for TruePoint:** CRM sync is greenfield. When built, it should reuse `field_provenance`
> for per-field source-of-truth and `pin` to protect human edits, and upsert on the deterministic
> match keys (§3.2) for dedup-on-write — not introduce a parallel identity/provenance mechanism.

---

## 6. Risk register (seeded — honest verdicts)

| # | Risk | Verdict | Basis / mitigation |
|---|---|---|---|
| R1 | Triplicated normalizers (`A3`) | **⚠️ Refuted** | one module, reused; ADR-0037 C5 forbids a 2nd — `matchKeys.ts:1-10`, `import/normalize.ts` |
| R2 | False company merges from a hardcoded country-code domain list (`A6`) | **⚠️ Refuted / mischaracterised** | eTLD+1 via PSL (`matchKeys.ts:74`); the only hardcoded list is the **freemail guard that prevents** false company nodes (`freemailDomains.ts`) |
| R3 | SSRF in enrichment | **⚠️ Refuted (enrichment)** | provider URLs hardcoded; record fields are metadata, never fetched (`integrations/.../providers.ts`, `httpProvider.ts`) |
| R4 | **Webhook SSRF — DNS-rebinding TOCTOU** | **Open (documented residual)** | resolve-then-fetch re-resolves independently; closing needs connect-by-pinned-IP. Validation at create + every dispatch shrinks the window. `webhooks/ssrfGuard.ts:11-14`; test loopback hatch is `NODE_ENV==='test'`-gated `:31-33`. Tracked as `G-INT-5`. |
| R5 | **Mint-then-merge: deterministic-only inflates duplicate masters + false-merge tail** | **Open (designed mitigation)** | `master_*_id` is a re-pointable pointer; the `match_links.is_duplicate_of` re-point cascade is designed day-one (C4). Tolerated-duplicate-rate is an open ops question. `prospect-company-data/PLAN_00` C4/F1 |
| R6 | IDOR on owner-scoped reads | **Mostly mitigated** | client IDs re-filtered via `contactRepository.visibleContactIds()` inside RLS tx; role-checked `assignOwner` (`bulkActions.ts:86-100`). **Residual = any new path that trusts a raw client ID without the filter** — assert it in review. |
| R7 | No email verifier wired (pass-through only) | **Open gap** | `emailVerifier.ts:14-18`; vendor is an open question (§5.2). Charge-for-verified presupposes a real verifier. |
| R8 | No phone line-type / TCPA-DNC pre-dial gating | **Open gap** | `validatePhone.ts:7-12` (E.164 regex only); tri-scoped suppression exists but no DNC-registry/line-type scrubbing (§5.3) |
| R9 | GDPR Art.14 / DPDP source-notice obligation for enriched data | **Open (compliance)** | source-disclosure + timing duties (§5.1, §5.4); no "legitimate interests" basis under DPDP; provenance (`source_records.lawful_basis_snapshot`) is the enabler |
| R10 | CRM-sync conflict / dedup (when built) | **Open (greenfield)** | reuse `field_provenance` + match keys, upsert-on-stable-key; don't overwrite human-edited fields (§5.5) |

---

## 7. Sign-off checklist + exit criteria

**Exit criteria (gate Phase 1):**

- [x] All research questions answered with citations (§2, §5).
- [x] Canonical primitives defined once, pinned to the shipped source of record (§3).
- [x] Risk register seeded — refuted premises flagged with `file:line`, real residuals recorded (§6).
- [ ] **Stale-premise correction acknowledged by the reviewer:** `A3`/`A6`/enrichment-SSRF are
      refuted; Phase 1 must not re-task "consolidate the triplicated normalizers" or "fix the
      country-code domain list."
- [ ] **"LinkedIn URN vs public-id slug"** reconciliation decided (the code uses the slug; confirm
      whether URN capture is a Phase-1 requirement).
- [ ] **Verifier strategy** decided (Reacher-only vs hybrid vs commercial) before the verification
      phase is designed (§5.2).
- [ ] **Telephony compliance owner** named for the DNC/line-type pre-dial pipeline (§5.3) before the
      dialer phase.
- [ ] **DPDP/GDPR source-notice** obligation assigned to the compliance phase owner (§5.1, §5.4).

**Sign-off:**

- [ ] Platform (tenancy/RLS/scale) — primitives §3.5 and storage §2.5 match ADR-0021/0006.
- [ ] Data (model/ownership/provenance) — §3.2-§3.4 match `prospect-company-data` C1-C10 + PLAN_03.
- [ ] Security — risk register §6 accepted; R4/R6 residuals owned; isolation predicate §3.5 correct.
- [ ] Operations — R5 tolerated-duplicate-rate + R8 telephony scrubbing cadence owned.

> No unresolved **⚠️ do-not-rely** item blocks Phase 1: the do-not-rely tags (CNIL-Art.14 mis-cite,
> specific CAN-SPAM penalty figure, provider pricing/accuracy benchmarks) are corrected or excluded
> in-line; none is load-bearing for a primitive or a Phase-1 decision.

---

## Sources

**Existing internal corroboration:** `docs/research/sales-intelligence-data-research.md`;
`docs/planning/list-plan/01-research-summary.md` (numbered refs `[n]` above resolve there);
`docs/planning/prospect-company-data/` (`PLAN_00` C1-C10, `PLAN_03`, `PLAN_04`, `RESEARCH_00`);
`docs/planning/22-data-quality-freshness-lifecycle.md` §5-6; `docs/planning/06-enrichment-engine.md` §1;
`docs/planning/08-compliance.md`; ADRs 0003/0005/0006/0007/0013/0015/0021/0025/0037.

**§5.1 India DPDP:** FPF — DPDP Explained (https://fpf.org/blog/the-digital-personal-data-protection-act-of-india-explained/);
DPDP Act s.3 verbatim (https://www.dpdpa.com/dpdpa2023/chapter-1/section3.html); ch.2
(https://www.dpdpact2023.com/chapter-2); Law School Policy Review — publicly-available limits
(https://lawschoolpolicyreview.com/2026/01/13/publicly-available-data-under-the-dpdp-act-the-limits-of-exemptions-in-ai-driven-processing/);
Vinod Kothari — B2B applicability
(https://vinodkothari.com/2025/12/every-business-is-a-data-business-applicability-of-dpdp-act-to-non-financial-entities/);
EY — Decoding DPDP (https://www.ey.com/en_in/insights/cybersecurity/decoding-the-digital-personal-data-protection-act-2023);
Privacy World — DPDP Rules 2025
(https://www.privacyworld.blog/2025/11/india-passes-the-digital-personal-data-protection-rules-ushering-in-a-new-digital-age-in-india/);
Acuity Law — timelines (https://acuitylaw.co.in/notification-of-digital-personal-data-protection-law-in-india-certain-key-timelines/);
MeitY official PDF (https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf).

**§5.2 Reacher:** GitHub README (https://github.com/reacherhq/check-if-email-exists); Reacher docs —
is_reachable (https://docs.reacher.email/getting-started/is-reachable); debugging
(https://docs.reacher.email/self-hosting/debugging-reacher); Prospeo
(https://prospeo.io/s/check-if-an-email-exists); Truelist
(https://truelist.io/blog/email-address-existence-checker); EmailAddress.ai
(https://www.emailaddress.ai/blog/catch-all-email-verification-fix-unknowns); Spamhaus port-25
(https://www.spamhaus.org/faqs/port-25-general-questions/).

**§5.3 TCPA/DNC/CAN-SPAM:** FTC CAN-SPAM guide
(https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business); FTC DNC FAQ
(https://consumer.ftc.gov/national-do-not-call-registry-faqs); TSR DNC FAQ
(https://www.dnc.com/faq/what-are-dnc-provisions-tsr); Goodwin — IMC v. FCC
(https://www.goodwinlaw.com/en/insights/publications/2025/01/alerts-otherindustries-eleventh-circuit-deals-fatal-blow);
Womble — one-to-one repeal
(https://www.womblebonddickinson.com/us/insights/blogs/fcc-repeals-one-one-consent-rule-following-eleventh-circuit-decision);
SearchBug — cell vs landline (https://www.searchbug.com/info/tcpa-rules-cell-phones-vs-landlines-differences/);
ActiveProspect — autodialer (https://activeprospect.com/blog/tcpa-autodialer/); RothJackson — DNC
$500 ceiling (https://www.rothjackson.com/blog/2025/02/reminder-that-statutory-damages-for-a-dnc-violation-should-not-start-at-500-per-call-or-text/).

**§5.4 GDPR Art.14:** gdpr-info Art.14 (https://gdpr-info.eu/art-14-gdpr/); ICO right-to-be-informed
exceptions (https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/are-there-any-exceptions/);
ICO legitimate interests (https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/a-guide-to-lawful-basis/legitimate-interests/);
"disproportionate effort" analysis (https://measuredcollective.com/what-is-considered-disproportionate-effort-under-gdpr/);
Légifrance CNIL SAN-2022-019 (https://www.legifrance.gouv.fr/cnil/id/CNILTEXT000046444859); UODO
Bisnode (https://uodo.gov.pl/en/553/1572); Fieldfisher ePrivacy
(https://www.fieldfisher.com/en/insights/eu-e-marketing-requirements); Freshfields — C-654/23
(https://www.freshfields.com/en/our-thinking/blogs/technology-quotient/consent-required-cjeu-issues-landmark-ruling-on-requirements-for-marketing-email-102mgiz).

**§5.5 CRM sync:** HubSpot dedup (https://knowledge.hubspot.com/records/deduplication-of-records);
HubSpot import (https://knowledge.hubspot.com/import-and-export/import-objects); HubSpot API limits
(https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines); Salesforce Ben —
duplicate rules (https://www.salesforceben.com/salesforce-duplicate-rules/); SF DuplicateRuleHeader
(https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/headers_duplicaterules.htm);
SF API limits (https://developer.salesforce.com/docs/atlas.en-us.salesforce_app_limits_cheatsheet.meta/salesforce_app_limits_cheatsheet/salesforce_app_limits_platform_api.htm);
Merge.dev writes (https://docs.merge.dev/merge-unified/writing-data/writes/introduction); Paragon —
real-time bi-directional sync (https://www.useparagon.com/use-case/bi-directional-sync); Stacksync
(https://www.stacksync.com/blog/achieve-data-consistency-bi-directional-sync); crdt.tech
(https://crdt.tech/); Bitscale — CRM enrichment at scale
(https://bitscale.ai/blogs/crm-enrichment-at-scale-which-fields-to-sync-refresh-cadence-and-dedup-rules).

> **Method note.** Codebase findings: three parallel Explore passes + first-hand reads of the cited
> source files (2026-06-26). External gaps (§5): a fan-out research workflow (5 gaps → primary
> sources → adversarial verify pass), corrections folded into the epistemic tags above.
