# 03 — Enterprise Research (citation register)

> **Status:** ✅ research complete · Accessed **2026-07-02** (all sources) · Program:
> import-and-data-model-redesign.
> **Rule:** no external-platform claim may enter any design doc in this series except via this
> doc. Design docs cite `03 §area [n]`; `[n]` resolves in the [citation register](#appendix--citation-register).
> **Confidence key:** **doc** = official help-center/developer docs/RFC fetched directly ·
> **doc(snippet)** = official page surfaced only via search snippet (page 403s or JS-walled) ·
> **blog** = third-party blog/community thread — must not load-bear alone in a design doc.
>
> **Relationship to prior research docs (extend, don't duplicate):**
> [`database-management-research/02-Enterprise-Research.md`](../database-management-research/02-Enterprise-Research.md)
> already covers platform-wide practice across 23 dimensions (ingestion, validation, dedup
> *detection*, enrichment, queues, RBAC, monitoring) — cited below as **DBM-02 §n**.
> [`prospect-database-platform/01-Enterprise-Research.md`](../prospect-database-platform/01-Enterprise-Research.md)
> covers multi-source ingestion, identity resolution, and waterfall enrichment — cited as
> **PDP-01 §n**. This doc adds the *delta this series needs*: import-wizard mechanics, merge
> *execution* semantics, multi-value channel schemas, company hierarchy/domain modeling, job
> visibility rules, and the durable-job-lifecycle contract, at per-claim citation granularity.
>
> **Root-cause / gap keys:** the series gap register is formalized as **G01…G26** in
> [`02-Root-Cause-and-Gap-Analysis.md`](02-Root-Cause-and-Gap-Analysis.md), which also carries
> the alias map from this doc's working IDs: G-B1 = **G01**, G-A1 = **G10**, G-A2 = **G07**,
> G-A3 = **G08**, G-A4 = **G09**, G-A5 = **G03**, G6 = **G04**, G8 = **G26**, G9 = **G25**.
> Implications below give both forms (working ID first, formal ID in parentheses). The program
> brief names RC-1 (workspace-wide job-visibility leak) and RC-5 (marker-only dedup) explicitly;
> intermediate RC numbers follow doc 02's register.

---

## §1 Import wizard UX, mapping templates, auto-mapping (R1)

### 1.1 Findings

| Claim | Platform | Cite | Conf |
|---|---|---|---|
| Wizard order: choose objects → file(s) → import mode (create+update / create-only / update-only) → upload → map columns → details/review (name, consent, formats) | HubSpot | [1] | doc |
| DIW order: object → operation (add / update / add+update) → upload CSV → auto-map + manual map → review → start; async, completion email; monitored in Bulk Data Load Jobs | Salesforce | [30] | doc |
| "Match Contact by…" (dedup key) chosen early, as part of the operation step | Salesforce | [68] | blog |
| Stages: destination → define objects → upload → mapping → **value review** (correct interpreted data) → **import preview** (summary of changes) → execution with per-record progress | Attio | [85] | doc |
| Entity chosen up front (separate Contacts vs Accounts flows); upload → set Stage → per-column dropdown mapping → import; status at Settings > Imports and exports | Apollo | [79] | doc(snippet) |
| Table-first: import lives inside a table; upload → destination (current/new/replace table) → map → run enrichments now or save without running | Clay | [90] | doc |
| Auto-map = header ↔ property-name matching ("header, header language, and the property name"); unmapped columns get explicit "Don't import column" | HubSpot | [1][2] | doc |
| Auto-match "providing the headers… resemble the fields"; unmatched = "Unmapped" + Map link; matching ignores case/punctuation; one column can map to multiple fields | Salesforce | [68][31] | blog / doc |
| Two-pane mapping (file column left, attribute right); auto-map where possible; **x** to ignore a column | Attio / Folk | [85][92] | doc |
| Saved mapping reuse: HubSpot "Use as template" on a past import (copies mappings + per-column don't-overwrite; 6-month window); Data Loader **Save Mapping** → per-user `.sdl` file (CLI-reusable); DIW "remembers previous mappings for repeat imports" | HubSpot / Salesforce | [4][32][33][69] | doc / blog (DIW memory) |
| Named shareable mapping templates: shipped by **nobody**; HubSpot community explicitly requests it | all six | [21] | blog (gap signal) |
| Limits: HubSpot paid = 512 MB/file, 1,048,576 rows/file, 10M rows/day, 3 concurrent; Salesforce DIW ≤50k records vs Data Loader ≤5M (the two-tool split); Attio 100k rows/100 MB; Clay 50k rows/table; Folk 25k rows; Apollo ~10k advisory + weekly quota | (each) | [3][30][85][91][92][83] | doc / blog (Clay, Apollo error text) |
| Preview: HubSpot validates full-file on the mapping screen (per-column error counts + drilldown); Attio previews **effects** (adds vs updates per object); Salesforce DIW shows counts only; Folk's review grid is editable in place | (each) | [1][5][85][68][92] | doc / blog (SF) |
| Mid-import custom-field creation: HubSpot typed property panel in-flow; Attio "+ Create new attribute"; Apollo custom field; Folk untyped (always text); Salesforce DIW cannot (admin-gated schema) | (each) | [1][85][79][92][30] | doc |
| Completion: HubSpot = created/updated counts + error-type table + "View rows with errors"; Salesforce = email + durable job console with success/error result files; Attio = live per-record ticks + failed count in Import history; Apollo/Folk/Clay = file-level status only | (each) | [5][30][68][85][86][79] | doc |
| Error artifacts: HubSpot ships two downloads — "Download errors as file" (error report) and "Download rows with errors as file" (repair CSV, fix-and-reimport); Attio inline-only (hover icons, no downloadable file) | HubSpot / Attio | [5][86] | doc |

### 1.2 Comparison matrix — wizard steps

| Step | Apollo [79] | HubSpot [1] | Salesforce DIW [30] | Clay [90] | Attio [85] |
|---|---|---|---|---|---|
| 1. Entity/destination | separate flows | choose objects | choose object | table = destination | object or list |
| 2. Dedup/mode choice | in import settings | **explicit early step** | **explicit early step** ("Match by…") | n/a (table append) | implicit (unique attribute mapped?) |
| 3. Upload | CSV | CSV/XLSX ≤512 MB | CSV ≤50k rows | CSV | CSV ≤100 MB/100k |
| 4. Mapping | dropdown/column | auto-map + create property + skip | auto-map + manual | map to table columns | auto-map + create attribute + skip |
| 5. Review/preview | none documented | validation counts on mapping screen | counts only | the table itself | value review + **effect preview** |
| 6. Run/monitor | Settings > Imports | durable history + summary | email + job console | per-cell enrich status | live per-record progress |

### 1.3 Implications for TruePoint

- **G-A1 (G10) / G-A5 (G03):** HubSpot's one-wizard-server-decides model (512 MB ceiling expressed only as quotas [3]) is the enterprise direction; Salesforce's wizard-vs-Data-Loader fork [30] is the legacy pattern the dead-end "Large file" toggle imitates. Kill the toggle; the server picks the path on the unified `import_jobs` trio (doc 08).
- **G-A5 (G03) / G6 (G04):** the market bar for completion is a **durable job record** with created/updated/failed counts + error-type breakdown + row drilldown [5][30] — precisely what Redis-only sync state cannot provide. Import history is a first-class navigable surface on every platform that does this well [4][86][79][54] → doc 11's dedicated Imports section.
- **RC-5 adjacency:** make merge strategy an explicit early wizard step — Attio's implicit unique-attribute dedup demonstrably causes duplicate disasters per its own troubleshooting doc [86].
- **Leapfrog:** named workspace-shared mapping templates are whitespace ([4][32][21]); no vendor shows mapping-confidence scores — binary mapped/unmapped + per-column override + explicit skip is parity [1][85].
- **Both error artifacts (repair CSV + error report) are PII-bearing** → same encryption/AV/retention envelope as uploads (doc 13; interacts with G-A2/G-A3 = G07/G08).

---

## §2 Duplicate detection & merge (R2)

Dedup *detection* practice at platform level is surveyed in **DBM-02 §4.5–4.6**, and
probabilistic identity-resolution/matching practice in **PDP-01 §3.2**; this section adds the
merge-strategy and merge-execution delta.

### 2.1 Findings

| Claim | Platform | Cite | Conf |
|---|---|---|---|
| Contacts auto-dedup on `Email`; companies on primary `Company domain name`; Record ID supersedes all identifiers in imports; up to ten custom unique-value properties | HubSpot | [8][1] | doc |
| Two-layer rules engine: **Matching Rules** (define, exact or fuzzy per field) vs **Duplicate Rules** (act: alert/block/report); ≤3 matching per duplicate rule, ≤5 active each per object; standard contact rule is fuzzy/composite (name+email+account) | Salesforce | [34][35][36][37] | doc / doc(snippet) |
| Contacts matched on first/last name, company, email, or LinkedIn URL; accounts on domain; not user-configurable | Apollo | [81] | doc(snippet) |
| Auto-detects on "domain for companies and email address for people"; imports may use other unique attributes | Attio | [87][86] | doc |
| When enabled per object, **Salesforce's own duplicate rules fully replace ZoomInfo's logic** on export (CRM = system of record for "what is a duplicate") | ZoomInfo | [93][94] | doc(snippet) |
| Import modes: "Create and update" / "Create only" / "Update only" | HubSpot | [1] | doc |
| "Prevent property overwrite" = per-property update-only-if-never-populated | HubSpot | [1] | doc |
| DIW modes: add / update / add+update; match by SFDC ID, Email, or Name | Salesforce | [38][39] | doc(snippet) |
| Duplicate rules can be bypassed for import tools/API (bulk saves "without user intervention") | Salesforce | [34] | doc |
| CSV import duplicate options: "Do not import" (skip) vs "Update the existing record"; merge can be offered during import | Apollo | [79][81] | doc(snippet) |
| Admin-sets-default, user-picks-within-allowed export-duplicate governance ("only update based on the admin preferences, create duplicate people, or not export duplicates"); "Exclude Exported" list option prevents re-export of already-exported records (~24 h refresh lag) | ZoomInfo | [95][97][102] | doc(snippet) / doc / blog (lag) |
| Merge default: chosen-primary wins, loser fills blanks; per-property override before confirm | HubSpot | [9] | doc |
| Type-aware merge exceptions: losing email → **secondary email**; losing domain → secondary domain; lifecycle stage = funnel-max; form/analytics counts summed | HubSpot | [9] | doc |
| Merge wizard = side-by-side, user picks the surviving value per field; master preselected; 3 records at a time | Salesforce | [70][71] | blog (canonical, corroborated) |
| Merge priority: source-of-truth record wins; populated custom fields never overwritten, blanks filled | Apollo | [81] | doc(snippet) |
| Whole-record priority only ("the record on the right is prioritized"; swap arrow); no per-field picker | Attio | [87] | doc |
| **Unmerge exists nowhere.** HubSpot: "not possible to unmerge" + 250-lifetime-merge cap; Salesforce: recycle-bin husk 15 days, children stay re-pointed; Attio: loser "permanently deleted" | (all) | [9][40][87] | doc |
| Children always union onto the survivor (activities, notes, associations, list entries re-point; survivor keeps its ID); restore never un-reparents ("related records stay on the master"); divergence: HubSpot drops secondary's static-list memberships + unenrolls workflows | (all) | [9][40][81][87][70][72] | doc / blog (restore detail) |
| Persistent review queue: Salesforce **Duplicate Record Sets** (stored, reportable, ≤100 dupes/rule); HubSpot AI pair-review + bulk merge with winner heuristics (most-recent-engagement / oldest / created-first/last / most-recently-updated); Apollo/Attio = point-in-time prompts only; ZoomInfo delegates at-rest dedup to RingLead (ZI Operations) dedup tasks | (each) | [34][8][81][87][88][96] | doc / doc(snippet) |

### 2.2 Comparison matrix — import-time merge strategy options

| Option | HubSpot [1] | Salesforce DIW [38] | Apollo [79] | Attio [86] | ZoomInfo [95][97] |
|---|---|---|---|---|---|
| Create only | ✅ | ✅ ("add new") | ✅ ("do not import" dupes) | implicit (no unique attr mapped) | ✅ (create new / allow dup toggles) |
| Update only | ✅ | ✅ | — | — | ✅ ("update existing") |
| Create + update (upsert) | ✅ (default) | ✅ | ✅ ("update the existing record") | ✅ (unique attr mapped) | admin-configured |
| Don't-overwrite-populated switch | ✅ per property | — | ✅ (custom fields, always) | — | admin mapping rules |
| Key choice | Record ID > email/domain > custom uniques | SFDC ID / Email / Name | fixed composite | any unique attribute | delegates to CRM rules |
| Row-level dup blocking on bulk | bypassed | bypassable per rule | n/a | n/a | pre-set default |

### 2.3 Implications for TruePoint

- **RC-5:** TruePoint's shipped keys (email blind index, LinkedIn ID, domain) are already canonical [8][81][87]; the gap is the strategy layer. v1 ceiling = HubSpot fixed-keys + escape hatch, not a Salesforce rules engine [34].
- Import must expose the **triad + orthogonal don't-overwrite switch** [1][38][79]; maps onto `data-management/15`'s `planFieldWrite`. ZoomInfo's admin-default-with-user-choice [95] fits the org-role model (doc 10).
- **Merge must be type-aware and sequenced after doc 05:** identity fields demote to secondary values, never discarded [9] — only possible once multi-value channel tables exist. The grain-A executor's no-child-re-pointing is disqualifying for customer-facing merge; Salesforce mechanics (re-point children → survivor keeps ID → soft-delete loser [40]) are the reference. Accounts need `deleted_at` first (doc 06) or losers can't tombstone.
- **Design for irreversibility guardrails, not unmerge** [9][40][87]: never auto-merge (keep marker-only auto layer as the suggestion source), side-by-side review, tombstone + audit event ([89]: Attio emits `record.merged`), merge caps (3-at-a-time [70], 250-lifetime [9]).
- **Duplicate review = persistent queue object** (Duplicate Record Sets [34]); TruePoint's `duplicate_of_contact_id` + I5 `match_links` are the raw material. Bulk/import paths never row-block on duplicates [34] — strategy applies silently + post-import "N potential duplicates" rollup.

---

## §3 Multi-value phone/email channel modeling (R3)

Load-bearing for docs 04/05. No overlap with prior research docs (neither covers channel schemas).

### 3.1 Findings

| Claim | Platform | Cite | Conf |
|---|---|---|---|
| `ContactPointPhone` child object (Individual/person accounts, not classic B2B Contact): `TelephoneNumber` (req), `AreaCode`, `ExtensionNumber`, `IsPrimary`, `IsSmsCapable`/`IsFaxCapable`, `IsBusinessPhone`/`IsPersonalPhone`, `PhoneType` (Home/Mobile), `UsageType` (Home/Work/Temporary/Inactive), active-date range, best-time-to-contact | Salesforce | [41][66] | doc / doc (mirror) |
| `ContactPointEmail`: `EmailAddress` (req), `EmailDomain`, `EmailMailBox` (local part decomposed), `IsPrimary`, `UsageType`, `EmailLatestBounceDateTime/ReasonText` | Salesforce | [42][67] | doc / doc (mirror) |
| Data Cloud DMO adds `FormattedE164Phonenumber`, `PhoneCountryCode`, capability flags, `IsVerified` | Salesforce | [43] | doc |
| Classic B2B `Contact` = 6 flat phone columns + 1 `Email` — the flat cache never went away; runs **alongside** ContactPoint\* | Salesforce | [44] | doc |
| One primary `email` property; secondaries in read-only computed `hs_additional_emails`; "Make primary" = atomic swap demoting the old primary | HubSpot | [10][22][20] | doc / blog |
| Phones = flat typed properties (`phone`, `mobilephone`, …); type is *which property* holds the number; no per-number verification | HubSpot | [11] | doc |
| Segment filters, reports, workflows, and marketing sends reference **only the primary** email; secondaries need `CONTAINS_TOKEN` on `hs_additional_emails` — top community complaint | HubSpot | [10][23] | doc / blog |
| Phone validation: E.164 stored unformatted, displayed regionally; `hs_calculated_phone_number` = derived E.164 parallel to the raw property; default-country inference applied **only on import** | HubSpot | [12][24] | doc / blog (property name) |
| vCard 4.0: `TEL` TYPE = text/voice/fax/cell/video/pager/textphone + work/home; `PREF` = 1–100 ranked (1 most preferred), unbounded cardinality; extensions ride the RFC 3966 tel URI (`;ext=`) | RFC 6350 | [122] | doc |
| JSContact: `phones`/`emails` = **map of stable Id → object**; map keys "MUST be preserved across versions" (normative per-value identity); three orthogonal axes — `features` (capability), `contexts` (work/private), `pref` (1–100) | RFC 9553 | [123] | doc |
| Merge unified model: `phone_numbers[] = {value, phone_number_type}` (enum HOME/WORK/MOBILE/SKYPE/OTHER); no primary flag, no verification, no E.164 split | Merge.dev | [127][128] | doc |
| Apideck keeps `{id, country_code, area_code, number, extension, type}` with `primary` as a **type value**; Nango refuses a fixed schema ("use your existing internal model") | Apideck / Nango | [132][133][134] | doc / blog |
| Twilio Lookup line types (12, carrier-live): landline, mobile, **fixedVoip/nonFixedVoip**, personal, tollFree, premium, sharedCost, uan, voicemail, pager, unknown (+ carrier, MCC/MNC) | Twilio | [124] | doc |
| libphonenumber `PhoneNumberType` (12, offline): FIXED_LINE, MOBILE, **FIXED_LINE_OR_MOBILE** (US ambiguity is inherent), TOLL_FREE, PREMIUM_RATE, SHARED_COST, VOIP, PERSONAL_NUMBER, PAGER, UAN, VOICEMAIL, UNKNOWN | Google | [125][126] | doc |
| Dialing: HubSpot dials the primary by default with an at-call property picker; HubSpot↔Salesforce sync matches on primary email only, secondaries don't sync; exports flatten to primary column + semicolon-joined "additional" column; Data Cloud resolves multi-source contact points via an explicit **source priority order** | HubSpot / Salesforce | [13][25][10][45] | doc / blog (sync) / doc(snippet) |

### 3.2 Comparison matrix — phone-modeling approaches

| Axis | Salesforce ContactPoint\* [41][43][66] | HubSpot [10][11][12] | vCard/JSContact [122][123] | Merge/Apideck/Nango [127][132][133] |
|---|---|---|---|---|
| Shape | child object per value | flat typed properties + computed overflow list | unbounded entries / **stable-Id map** | `[{value, type}]` array (LCD) |
| Type model | `PhoneType` + `UsageType` + capability booleans | type = which property | features ⊥ contexts ⊥ pref (3 axes) | single 5-value enum |
| Primary | `IsPrimary` flag | primary slot + atomic "Make primary" swap | `PREF` 1–100 ranking | absent (Merge) / `primary` as type (Apideck) |
| E.164 | Data Cloud derived field + raw + decomposed area/ext | raw property + `hs_calculated_phone_number` | tel URI (`;ext=` for extension) | Apideck decomposed; Merge raw only |
| Verification | bounce fields; Data Cloud `IsVerified` | none per-value | none | none (dropped in flattening) |
| Per-value provenance | none | none | none | none |

### 3.3 Implications for TruePoint

- **Spine validation:** child tables + retained flat primary cache is the industry-proven shape — Salesforce runs both models simultaneously [41][44]; HubSpot runs primary + computed list [10]. Keep `contact_phones`/`contact_emails` + existing encrypted flat columns as permanent primary cache (docs 04/05).
- **Exactly-one-primary is the load-bearing invariant** (partial unique on `is_primary`); dial/send/sync/export/dedup all bind to it; promotion = atomic swap [10][13][25].
- **Dual phone representation:** raw-as-entered + derived E.164 (+ blind index), extension in a **separate column** (E.164 cannot hold it [122][132][43]), default-region knob at import [12].
- **Line type = the union enum** (libphonenumber ∪ Twilio [124][125]) + how-determined provenance — only paid lookups resolve US mobile-vs-landline and the VOIP split.
- **Leapfrogs:** any-value search/filter (HubSpot's biggest documented gap [10][23]); per-value verification + provenance (no CRM has it [43]); stable per-value row IDs for merge/sync (RFC 9553 normative [123]). Interop projection must degrade gracefully to `[{value, type, primary}]` [127][132] — never expect verification/provenance to survive CRM sync.

---

## §4 Company hierarchy, domains, locations (R4)

Company-person edges and resolution are covered in **DBM-02 §4.6–4.7**; this section adds the
hierarchy/domain/location schema delta.

### 4.1 Findings

| Claim | Platform | Cite | Conf |
|---|---|---|---|
| Hierarchy = single `Parent Account` lookup (pointer); tree derived by walking; display ≤2,000 accounts (Lightning); no native depth limit (formula workarounds cap ~10 levels) | Salesforce | [46][47][74] | doc(snippet) / blog |
| Cycles rejected at write time: self-reference blocked; `CIRCULAR_DEPENDENCY` on edit/merge | Salesforce | [48][73] | doc / blog |
| Parent/child = association labels; single-parent invariant, multi-level allowed; **merge-time loop guard** (merges creating an association chain to itself are blocked) | HubSpot | [14] | doc |
| Every D&B record carries **4 pointer DUNS**: own Site + Parent/HQ + Domestic Ultimate + Global Ultimate, plus a 2-digit hierarchy code 01–09 (effective 9-level ceiling) | D&B | [104][105] | doc(snippet) |
| Hierarchy shipped as ~55 denormalized fields per record (Ultimate/Domestic/Immediate Parent IDs + type flags), refreshed quarterly; Ultimate Parent re-pointed after acquisitions | ZoomInfo | [98][101] | blog (vendor) |
| Sub-organization = typed "Relationship to Parent" dropdown (subsidiary/division/investment arm); acquisitions are a separate first-class entity deliberately duplicated onto the org for query ease | Crunchbase | [109][110] | doc(snippet) / blog |
| `Company domain name` = multi-value set with explicit primary; primary = dedup key; **all** domains drive contact auto-association; import dedup uses primary **and** secondary domains; UI-create dedups on primary only; API-create not deduped at all | HubSpot | [15][8] | doc |
| Documented secondary-domain asymmetries: cannot import multiple domains, cannot set primary via import, secondaries not exported, no property history | HubSpot | [15][26] | doc / blog |
| Follows redirects, returns `domainAliases`; any alias resolves to the canonical company; separate Name→Domain resolver | Clearbit | [112][113][114] | doc |
| Single-domain identity ("Account Website" = the key); duplicate accounts keyed on domain; contact-matches-multiple-accounts → user prompted to choose | Apollo | [81][82] | doc(snippet) |
| Locations: **no surveyed CRM has a customer-facing locations child object** — flat HQ address; extra offices = extra account records via parent pointer; D&B/ZoomInfo model every site as a record (own DUNS; branch shares HQ legal identity, subsidiary is separate entity; ZoomInfo locations are enrichable entities of their own) | (all) | [46][14][104][107][108][111][103] | doc / doc(snippet) / blog (ZI locations) |
| Location-grained identity keys fragment accounts ("a firm with 40 offices has 40 DUNS Numbers") | ZoomInfo | [99] | blog (vendor) |
| **CRMs compute no hierarchy rollups** (display-only; third-party market fills the gap); vendors precompute per-site vs consolidated figures keyed on the ultimate-parent pointer | SF / HubSpot / D&B / ZI | [74][75][29][106][100] | blog / doc(snippet) |
| Hierarchy ⊥ permissions: "The hierarchy doesn't display details of accounts you don't have permission to view" | Salesforce | [47] | doc(snippet) |
| Hierarchy × dedup hazards: parent-child pairs cannot be merged until labels removed; shared domains can wrongly auto-merge child into parent | HubSpot | [14][29] | doc / blog |
| Import matching: domain-first exact match decides create-vs-update; ≥2 matches on one domain → **row errors loudly** (HubSpot) or prompts (Apollo); fuzzy name+city/zip (Salesforce standard account rule) is advisory/review-layer only, never a silent import key | (each) | [8][82][49][50][51] | doc / doc(snippet) |
| Hierarchy links ride the import file: child rows reference parents by Record ID or domain mapped as a "Parent Company" association | HubSpot | [14] | doc |

### 4.2 Implications for TruePoint

- **Doc 06 spine:** parent pointer + **denormalized ultimate-parent key** (D&B/ZoomInfo pattern [104][98]) so rollups/family checks are `GROUP BY`, not recursive CTEs. Cycle prevention = app-layer write-time validation that **re-runs at merge time** [48][14]; soft depth cap ~10 (D&B proves 9 suffices [104]).
- **Domains:** `account_domains` set + `accounts.domain` as primary cache (symmetric with contacts); match on the whole set, dedup-key on primary [15][112]; normalize before matching; make secondaries first-class in import/export/history from day one — HubSpot's three asymmetries [15][26] are the failure modes to avoid.
- **Ambiguity fails loudly** (≥2 domain matches → row error/review, never silent pick [8][82]) → doc 08 partial-success design. Fuzzy name+geo is a suggestion layer only [49][51].
- **Locations = child table subordinate to company identity, never identity keys** [99][104]; leapfrogs CRMs without the DUNS fragmentation trap.
- **G-B1 (G01) adjacency / doc 10:** hierarchy is orthogonal to visibility everywhere [47] — rollups must not leak rows a user cannot see. Master-graph hierarchy surfaces as accept/reject suggestions only, matching how CRMs consume vendor hierarchy feeds [98][106].

---

## §5 Job visibility & permission models (R5)

RBAC in general is covered in **DBM-02 §4.15** (and staff caps are fixed by the shipped
`packages/types/src/staffCapability.ts`); this section is specifically about **job-object**
visibility in the customer surface — the G-B1 (G01)/RC-1 evidence base for doc 10.

### 5.1 Findings

| Claim | Platform | Cite | Conf |
|---|---|---|---|
| Bulk job monitoring page tracks jobs "created by any client application" (org-wide surface); `GET /jobs/ingest` returns "all jobs in the org" | Salesforce | [54][55] | doc |
| Cancel rule: "abort a job if you created it **or** if you have the 'Manage Data Integrations' permission" — a dedicated named permission for monitor/abort of everyone's bulk jobs, decoupled from the ability to load data | Salesforce | [56][76] | doc / blog (monitor wording) |
| Past-imports table shows "Created by User ID" (name + email) — shared list with per-row creator attribution | HubSpot | [6] | doc (attribution) / inferred (list shows all users) |
| Export log rule: "Super admins can view all of the account's exports, while individual users can view only their personal exports" — the exact members-see-own / admins-see-all split | HubSpot | [7] | doc |
| Downloading the **original import file** = "the user who completed the import or Super Admin"; the history row itself stays visible; per-import actions incl. download error file, use-as-template, delete newly-created records; **no undo** for updates | HubSpot | [6] | doc |
| Super admins can track who downloaded an export file, incl. IP and date | HubSpot | [7] | doc |
| Imports page sits under Administration > System Activity (admin surface); per-job drilldown; failed imports download a CSV | Outreach | [115][116] | doc |
| Import history entry point phrased as "your previous imports" (owner-leaning), but an import's *records* are team-visible via People-list filter by import name | Salesloft | [118][119] | blog (JS-walled — do not load-bear) |
| "Import at all" is a named per-user grant everywhere: HubSpot "Import" toggle; Outreach governance "CSV Import"; Apollo "bulk import contacts/accounts via CSV" per profile (granularity itself plan-gated); never implicit from membership | (each) | [17][117][79][80][84] | doc / doc(snippet) / blog |
| HubSpot export permission ladder: "Export" / "Export without approval" / "Approve exports" — do / do-ungated / govern-others | HubSpot | [17] | doc |
| Per-record sharing exists for **records** (Salesforce OWD + manual sharing; role hierarchy sees subordinates' data; Outreach per-type Record Visibility scopes on the profile) and **content assets** (HubSpot partitioning "Manage Access"); **import jobs get neither** — no platform exposes a per-job "share with team" toggle; job visibility derives from role/permission only | (each) | [52][53][117][16] | doc |
| Where the product UI lacks attribution, the audit log is the documented fallback surface | HubSpot | [27] | blog (staff-answered) |

### 5.2 Implications for TruePoint

- **RC-1 / G-B1 (G01):** the decided model (members see own jobs; org admins/owners see all with creator attribution) is literally HubSpot's export-log rule [7] + Salesforce's creator-or-permission abort rule [56]. Cite these two as the doc-10 pattern anchors; apply uniformly to import + reveal + enrichment lists + RecentImportsCard (program decision 3).
- **Split the verbs:** see-the-row (broadest) / cancel (owner ∪ elevated [56]) / download artifacts (tightest — importer-or-super-admin [6]). Job **metadata ≠ job artifacts**; the rejected-rows artifact is the direct analog of HubSpot's guarded files and takes the tightest gate + download auditing [7].
- **G6 (G04):** wiring a "my imports" list endpoint is market-mandatory — attribution is a rendered "Created by" column on a shared list [6][54]; `created_by_user_id`/`imported_by_user_id` exist unused, which is exactly the gap.
- **"Import at all" needs its own org-role-level grant** [17][117][79], distinct from see-all-jobs; this is an `apps/web` org-role concern — staff `data:*` caps are the wrong tool (two-surface rule).
- **Per-job share flag has no market precedent** [16][117] — keep it deferred, no apology needed. Approval ladders [17] = future enhancement (doc 14). Job-list scoping must not scope the *records* the import created [119]. **G8 (G26):** admin drilldown + artifact access from an admin surface has precedent in Outreach [115].

---

## §6 Bulk architecture & job lifecycle (R6)

Queue/background-job practice at survey level is in **DBM-02 §4.17–4.19**; this section pins the
durable-job-state, cancellation, error-artifact, limits, and delta-import contracts.

### 6.1 Findings

| Claim | Platform | Cite | Conf |
|---|---|---|---|
| Ingest job states: `Open → UploadComplete → InProgress → {JobComplete \| Failed \| Aborted}`; linear, 3 terminals; `Aborted` reachable from any pre-terminal state | Salesforce Bulk API 2.0 | [57] | doc |
| Import states: `STARTED / DEFERRED / PROCESSING → {DONE \| FAILED \| CANCELED}`; `DEFERRED` = the 3-concurrent cap made **visible as a state** | HubSpot | [18] | doc |
| Queue-native state is ephemeral by design: BullMQ events ride a trimmed Redis stream (~10k events default); Sidekiq batch data "lingers in Redis for 24 hours" then vanishes — every platform layers a durable DB job record above the queue | BullMQ / Sidekiq | [138][142] | doc |
| "Done" is a job-level verdict independent of row failures (`JobComplete`/`DONE` can hide thousands of failed rows); partial success is a property of the **results resources**, not an extra state | SF / HubSpot | [57][18] | doc |
| Failed-results = **CSV echoing the user's original columns** + appended `sf__Error` (+ `sf__Id`); parallel `successfulResults`; third resource `unprocessedrecords` distinguishes failed (attempted, errored) from unprocessed (never attempted) | Salesforce | [58][59][60] | doc |
| Stable machine-readable error-code vocabulary (50+: `DUPLICATE_UNIQUE_PROPERTY_VALUE`, `COULD_NOT_PARSE_DATE`, `CREATE_ONLY_IMPORT`, …); errors aggregated by type with **impact counts**; sensitive values replaced with `_REDACTED_` in error screens and files | HubSpot | [5][18] | doc |
| Cancel = stop-remainder, never rollback: "If changes to data have been committed, they aren't rolled back"; remainder exposed via `unprocessedrecords`; HubSpot cancel makes no rollback statement; undo is a separate provenance-driven verb ("view imported records → delete") | SF / HubSpot | [61][62][60][19][6][28] | doc / blog (undo workflow) |
| Limits published in three layers: per-file (HubSpot 1,048,576 rows / 512 MB whichever first → 429; Salesforce 150 MB), per-day rolling quota (80M / 100M rows/24h), concurrency (HubSpot 3 → DEFERRED; Salesforce 25) | SF / HubSpot | [18][63][64] | doc |
| Internal chunking = 10,000-row batches; ≤10 min per batch; ≤10 retries then the whole job fails | Salesforce | [63][77] | doc / blog (retry count) |
| File-based delta = **upsert on a declared unique key with explicit per-import CREATE/UPDATE/UPSERT mode** (HubSpot `importOperations` + mode-violation error codes; Salesforce `operation: upsert` + `externalIdFieldName`); no platform exposes content hashing | SF / HubSpot | [18][65] | doc |
| Sync engines: per-record **cursors** beat modified-since timestamps; deletes are invisible to delta → Merge forces a full re-sync every 3 days; explicit merge strategies `override` vs `ignore_if_modified_after` | Nango / Merge | [135][131][136][129] | doc |
| Progress = durable counters on the job row (`numberRecordsProcessed`/`numberRecordsFailed`) consumed by indefinite **polling** (~30 s guidance); webhooks/push only as optimization with polling as the documented safety net; no import-progress SSE at any public API | SF / Merge / HubSpot | [56][54][78][129][130][18] | doc / blog (cadence) |
| CSV streams row-by-row (PapaParse `step`/`chunk`, pause/abort, typed parse-error shape); **XLSX cannot be stream-read** (zip central directory at EOF; SheetJS buffers whole files; streaming exists only for write) | PapaParse / SheetJS | [143][144][145] | doc |
| BullMQ `addBulk` is atomic but degrades above ~1k jobs/call; no first-class cancel of an `active` job (cooperative flag check) | BullMQ | [139][140][141] | doc / blog |

### 6.2 Comparison matrix — job state vocabularies (Salesforce Bulk API 2.0 as reference)

| Phase | Salesforce Bulk 2.0 [57] | HubSpot Imports [18] | BullMQ [137] | Sidekiq Pro [142] | TruePoint target (doc 08) |
|---|---|---|---|---|---|
| Accepting data | `Open` | (upload in create call) | — | — | created/uploading |
| Queued | `UploadComplete` | `STARTED`, `DEFERRED` (visible backpressure) | `wait`/`prioritized`/`delayed` | batch open | queued (+ visible deferred) |
| Running | `InProgress` | `PROCESSING` | `active` | jobs pending | processing |
| Success | `JobComplete` (even with row failures) | `DONE` | `completed` | `success` callback | complete **/ partial** (keep — stronger than both) |
| Systemic failure | `Failed` | `FAILED` | `failed` | `death` callback | failed |
| User-cancelled | `Aborted` | `CANCELED` | (remove; no state) | — | cancelled |

### 6.3 Implications for TruePoint

- **G-A5 (G03):** the Redis-only sync path is the exact anti-pattern the queue vendors themselves document as ephemeral [138][142]; unifying all imports on the durable `import_jobs` trio is industry-standard, not over-build. Progress = durable counters polled indefinitely (never a ×80 give-up) [56][129]; SSE/realtime pushes ticks as garnish, completion also flows via the outbox (doc 09).
- **State machine (doc 08):** 6–7 states, 3–4 terminals; keep shipped `partial` (ahead of SF/HubSpot [57][18]); copy `DEFERRED` as a visible backpressure state [18].
- **Cancel contract:** stop-remainder, never rollback — say so verbatim in UI/API [61]; report failed vs unprocessed distinctly [60]; undo = separate provenance-driven delete via `source_import_id` [6][28].
- **Error artifacts:** echo original columns + typed error codes + errors-by-type impact table + **`_REDACTED_` PII redaction** [58][5] — the redaction rule is mandatory given TruePoint's never-log-PII mandate; audit the existing rejected-rows artifact for it (doc 13, interacts with G-A2/G-A3 = G07/G08).
- **G9 (G25) / doc 12:** publish the three limit numbers (rows AND bytes per file, per-workspace daily quota, concurrency cap) as product contract with early rejection [18][63][64]; pin chunk-size + bounded per-chunk retry → job escalation policy explicitly (doc 09) [63][77]. **G-A4 (G09):** anchor COPY-spike targets to the 10k-row internal batch precedent.
- **Incremental imports** = upsert-on-declared-unique-key + per-import mode [18][65] on the already-shipped uniques; hash-skip is an internal merge-core optimization at most. Scheduled/CRM-pull extensions: cursors > timestamps, periodic full re-sync for deletes, conflict strategy defers to `field_provenance` winner-map + `pin` [135][131][136]. **XLSX gets a lower size ceiling or an up-front convert-to-CSV step** [144][143].

---

## §7 Canonical standards

The normative references design docs 04/05/08/09 may cite directly (still via this register):

- **E.164 / libphonenumber** [125][126][124]: E.164 = country code + subscriber number, ≤15
  digits, no formatting; the canonical storage/dedup key. Store dual (raw-as-entered + derived
  E.164); extension always **outside** the E.164 core (separate column or `;ext=` tel URI
  [122]); default-region parameter required for national-format parsing at import [12].
  Line-type = libphonenumber's 12-value offline enum ∪ Twilio's carrier-live 12-value enum
  (adds fixedVoip/nonFixedVoip); offline typing is inherently ambiguous for US numbers
  (`FIXED_LINE_OR_MOBILE`) [125] — store `line_type` + how-determined provenance.
- **RFC 6350 (vCard 4.0)** [122]: multi-value `TEL`/`EMAIL` with TYPE params; `PREF` = integer
  1–100, lower preferred — primary as *ranking*, not boolean.
- **RFC 9553 (JSContact)** [123]: the best type model — per-value entries in a **map with
  normatively stable keys** (patch/sync safety), and three orthogonal axes: `features`
  (capability), `contexts` (usage), `pref` (preference). TruePoint child-row UUIDs supply
  stable identity for free; merge executors must re-point/tombstone by id, never rewrite
  in place.
- **Salesforce Bulk API 2.0 job model** [57][58][59][60][61][63]: the reference durable-job
  contract — linear state enum with 3 terminals; durable counters on the job resource;
  three result resources (successful / failed / **unprocessed**); abort = stop-remainder with
  committed changes never rolled back; limits published per-file/per-day/concurrency;
  internal 10k-row chunking with bounded retry then job failure.

## §8 Contradictions & confidence caveats

1. **Salesforce help.salesforce.com is JS-walled; Apollo/Salesloft KBs 403.** All Salesforce
   claims here rest on developer.salesforce.com or Trailhead (doc) or are flagged; Apollo rows
   are official-KB search snippets (doc(snippet)) or blog; **every Salesloft row is effectively
   blog-observed and must not load-bear in design docs** [118][119][120][121].
2. **HubSpot "import list shows all users' imports" is documented-inferred** [6] — the
   attribution column is documented; org-wide listing is inferred (reinforced by the
   creator-or-super-admin download restriction, which only makes sense if non-owners see the
   row). Doc 10 should anchor on the *export-log* rule [7], which is explicit.
3. **HubSpot dedup is internally asymmetric** (import dedups on primary+secondary domains;
   UI-create on primary only; API-create not at all [8]) — cite the *import* behavior, not "HubSpot
   dedups on domain" generally.
4. **Merge "irreversible" has a Salesforce nuance:** losers go to the recycle bin for 15 days,
   but restores are husks — children stay re-pointed and overwritten values are gone [40]. Not a
   contradiction of "no unmerge"; don't cite it as one.
5. **`hs_calculated_phone_number` naming** is community-corroborated rather than KB-documented
   [24]; the KB-documented parts are E.164 validation + import-time default-country [12].
6. **Salesforce contact matching (fuzzy composite [36]) vs account matching (fuzzy name+geo
   [49])** are different standard rules — design docs must not conflate them.
7. **ContactPoint\* field lists** were confirmed via a third-party mirror of official object docs
   [66][67] because the official pages render client-side; field names cross-check against the
   official URLs [41][42].
8. **Clay limits are community-thread level** [91]; Apollo's weekly-cap error text is blog-level
   [83] — treat exact numbers for both as indicative, not contractual.
9. **Salesforce ~10-retry-per-chunk** count is blog-corroborated [77] atop the documented
   bounded-retry-then-fail behavior [63].

## §9 Non-goals

This register covers **product mechanics only**. It deliberately excludes: vendor pricing,
plan/tier recommendations, vendor selection or procurement guidance, and performance
benchmarking of the surveyed platforms. Tier-gating is mentioned only where it changes the
mechanic itself (e.g., Apollo permission granularity being plan-gated [84]).

---

## Appendix — Citation register

All accessed **2026-07-02**. Confidence: **doc** / **doc(snippet)** / **blog** as defined in the header.

### HubSpot — official
- [1] https://knowledge.hubspot.com/import-and-export/import-objects — HubSpot — doc
- [2] https://knowledge.hubspot.com/import-and-export/understand-the-import-tool — HubSpot — doc
- [3] https://knowledge.hubspot.com/import-and-export/set-up-your-import-file — HubSpot — doc
- [4] https://knowledge.hubspot.com/import-and-export/repeat-a-past-import — HubSpot — doc
- [5] https://knowledge.hubspot.com/import-and-export/troubleshoot-import-errors — HubSpot — doc
- [6] https://knowledge.hubspot.com/import-and-export/view-and-analyze-previous-imports — HubSpot — doc
- [7] https://knowledge.hubspot.com/import-and-export/view-a-log-of-your-users-exports-in-your-account — HubSpot — doc
- [8] https://knowledge.hubspot.com/records/deduplication-of-records — HubSpot — doc
- [9] https://knowledge.hubspot.com/records/merge-records — HubSpot — doc
- [10] https://knowledge.hubspot.com/records/add-multiple-email-addresses-to-a-contact — HubSpot — doc
- [11] https://knowledge.hubspot.com/properties/hubspots-default-contact-properties — HubSpot — doc
- [12] https://knowledge.hubspot.com/properties/phone-number-property-validation — HubSpot — doc
- [13] https://knowledge.hubspot.com/calling/make-calls-in-the-hubspot-browser — HubSpot — doc
- [14] https://knowledge.hubspot.com/records/add-a-parent-or-child-company — HubSpot — doc
- [15] https://knowledge.hubspot.com/records/add-multiple-domain-names-to-a-company-record — HubSpot — doc
- [16] https://knowledge.hubspot.com/account/partition-your-hubspot-assets — HubSpot — doc
- [17] https://knowledge.hubspot.com/user-management/hubspot-user-permissions-guide — HubSpot — doc
- [18] https://developers.hubspot.com/docs/api-reference/legacy/crm/imports/guide — HubSpot — doc
- [19] https://developers.hubspot.com/docs/api-reference/latest/crm/imports/cancel-import — HubSpot — doc
- [20] https://legacydocs.hubspot.com/docs/methods/secondary-email-overview — HubSpot — doc (legacy)

### HubSpot — community/blog
- [21] https://community.hubspot.com/t5/HubSpot-Ideas/Create-an-import-mapping-template/idi-p/1196587 — HubSpot — blog
- [22] https://community.hubspot.com/t5/APIs-Integrations/How-do-you-set-secondary-email-addresses-on-Contacts/td-p/1068269 — HubSpot — blog
- [23] https://community.hubspot.com/t5/APIs-Integrations/Search-Contacts-for-Secondary-Mail/td-p/358756 — HubSpot — blog
- [24] https://community.hubspot.com/t5/APIs-Integrations/Where-is-the-country-code-of-phone-numbers-in-the-API/m-p/1020664 — HubSpot — blog
- [25] https://community.hubspot.com/t5/Marketing-Integrations/How-to-use-Primary-and-Secondary-emails-when-syncing-with/m-p/334978 — HubSpot — blog
- [26] https://community.hubspot.com/t5/CRM/Using-import-to-add-additional-domains-to-a-company/m-p/439828 — HubSpot — blog
- [27] https://community.hubspot.com/t5/Account-Settings/View-users-import-history-at-the-users-tab/m-p/1120472 — HubSpot — blog (staff-answered)
- [28] https://community.hubspot.com/t5/CRM/Data-Import/m-p/1007494 — HubSpot — blog
- [29] https://blog.insycle.com/problems-hubspot-child-parent-companies — HubSpot (3rd-party) — blog

### Salesforce — official
- [30] https://trailhead.salesforce.com/content/learn/modules/lex_implementation_data_management/lex_implementation_data_import — Salesforce — doc
- [31] https://help.salesforce.com/s/articleView?id=sf.essentials_data_import_matching.htm — Salesforce — doc
- [32] https://developer.salesforce.com/docs/atlas.en-us.dataLoader.meta/dataLoader/defining_field_mappings.htm — Salesforce — doc
- [33] https://developer.salesforce.com/docs/atlas.en-us.dataLoader.meta/dataLoader/command_line_create_mapping_file.htm — Salesforce — doc
- [34] https://help.salesforce.com/s/articleView?id=sales.duplicate_rules_overview.htm — Salesforce — doc
- [35] https://trailhead.salesforce.com/content/learn/modules/sales_admin_duplicate_management/sales_admin_duplicate_management_unit_2 — Salesforce — doc
- [36] https://help.salesforce.com/s/articleView?id=sf.duplicate_rules_standard_contact_rule.htm — Salesforce — doc(snippet)
- [37] https://help.salesforce.com/s/articleView?id=sf.matching_rules_standard_rules.htm — Salesforce — doc(snippet)
- [38] https://help.salesforce.com/s/articleView?id=sf.faq_import_general_update_with_import_wizard.htm — Salesforce — doc(snippet)
- [39] https://help.salesforce.com/s/articleView?id=000385322 — Salesforce — doc(snippet)
- [40] https://help.salesforce.com/s/articleView?id=000386067 — Salesforce — doc
- [41] https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_contactpointphone.htm — Salesforce — doc
- [42] https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_contactpointemail.htm — Salesforce — doc
- [43] https://developer.salesforce.com/docs/data/data-cloud-dmo-mapping/guide/c360dm-contact-point-phone-dmo.html — Salesforce — doc
- [44] https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_contact.htm — Salesforce — doc
- [45] https://help.salesforce.com/s/articleView?id=sf.c360_a_contact_points.htm — Salesforce — doc(snippet; title/abstract only)
- [46] https://help.salesforce.com/s/articleView?id=sales.account_parent.htm — Salesforce — doc(snippet)
- [47] https://help.salesforce.com/s/articleView?id=sf.account_parent_classic.htm — Salesforce — doc(snippet)
- [48] https://help.salesforce.com/s/articleView?id=000385626 — Salesforce — doc(snippet)
- [49] https://help.salesforce.com/s/articleView?id=sf.matching_rules_standard_account_rule.htm — Salesforce — doc(snippet)
- [50] https://help.salesforce.com/s/articleView?id=sales.matching_rule_matching_criteria.htm — Salesforce — doc(snippet)
- [51] https://help.salesforce.com/s/articleView?id=sf.matching_rules_considerations.htm — Salesforce — doc(snippet)
- [52] https://help.salesforce.com/s/articleView?id=sf.admin_sharing.htm — Salesforce — doc
- [53] https://trailhead.salesforce.com/content/learn/modules/data_security/data_security_roles — Salesforce — doc
- [54] https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/asynch_api_jobs_monitor.htm — Salesforce — doc
- [55] https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/get_all_jobs.htm — Salesforce — doc
- [56] https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/get_job_info.htm — Salesforce — doc
- [57] https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/bulk_api_2_job_states.htm — Salesforce — doc
- [58] https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/get_job_failed_results.htm — Salesforce — doc
- [59] https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/bulk_api_2_0_ingest_and_job_lifecycle.htm — Salesforce — doc
- [60] https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/get_job_unprocessed_results.htm — Salesforce — doc
- [61] https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/asynch_api_jobs_abort.htm — Salesforce — doc
- [62] https://help.salesforce.com/s/articleView?id=000382516 — Salesforce — doc(snippet)
- [63] https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/asynch_api_concepts_limits.htm — Salesforce — doc
- [64] https://developer.salesforce.com/docs/atlas.en-us.salesforce_app_limits_cheatsheet.meta/salesforce_app_limits_cheatsheet/salesforce_app_limits_platform_bulkapi.htm — Salesforce — doc
- [65] https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/create_job.htm — Salesforce — doc
- [66] https://soft-builder.com/en/docs/SamplesDocs/Salesforce_Health_Cloud_Documentation/objects/o233.html — Salesforce (mirror of official object ref, ContactPointPhone) — doc (via mirror)
- [67] https://soft-builder.com/en/docs/SamplesDocs/Salesforce_Health_Cloud_Documentation/objects/o232.html — Salesforce (mirror, ContactPointEmail) — doc (via mirror)

### Salesforce — blog
- [68] https://www.salesforceben.com/introduction-to-the-data-import-wizard-for-salesforce/ — Salesforce — blog
- [69] https://skyvia.com/blog/salesforce-data-import-wizard-vs-data-loader/ — Salesforce — blog
- [70] https://www.salesforceben.com/merge-duplicate-records-in-salesforce-lightning/ — Salesforce — blog
- [71] https://datagroomr.com/merging-duplicate-records-in-salesforce/ — Salesforce — blog
- [72] https://no-duplicates.com/blog/how-to-merge-duplicate-records-in-salesforce — Salesforce — blog
- [73] https://www.plauti.com/support/dc-troubleshooting/how-to-solve-the-circular_dependency-error — Salesforce — blog
- [74] https://www.salesforceben.com/how-to-build-a-salesforce-account-hierarchy/ — Salesforce — blog
- [75] https://www.passagetechnology.com/lookup-helper-use-cases/ultimate-parent-account — Salesforce — blog
- [76] https://sfdcian.com/user-profile-permission-explanation/ — Salesforce — blog
- [77] https://www.apexhours.com/salesforce-bulk-api-2-0/ — Salesforce — blog
- [78] https://salesforcetrail.com/salesforce-bulk-api-2-0-complete-guide/ — Salesforce — blog

### Apollo
- [79] https://knowledge.apollo.io/hc/en-us/articles/4409161532045-Import-a-CSV-of-Contacts — Apollo — doc(snippet; KB 403s)
- [80] https://knowledge.apollo.io/hc/en-us/articles/4409154067981-Import-a-CSV-of-Accounts — Apollo — doc(snippet)
- [81] https://knowledge.apollo.io/hc/en-us/articles/4413326420621-Merge-Duplicate-Records-to-Consolidate-Your-Data — Apollo — doc(snippet)
- [82] https://knowledge.apollo.io/hc/en-us/articles/7628885806093-Map-a-Contact-to-the-Correct-Duplicate-Account — Apollo — doc(snippet)
- [83] https://aeroleads.com/blog/import-contacts-into-apollo-io-from-csv-file-without-errors/ — Apollo — blog
- [84] https://www.stitchflow.com/user-management/apollo/manual — Apollo — blog

### Attio
- [85] https://attio.com/help/reference/imports-exports/csv-imports/import-data-into-attio-via-csv — Attio — doc
- [86] https://attio.com/help/reference/imports-exports/csv-imports/troubleshooting-csv-imports — Attio — doc
- [87] https://attio.com/help/reference/managing-your-data/records/merge-and-delete-records — Attio — doc
- [88] https://attio.com/apps/check-for-duplicates — Attio — doc (marketplace listing)
- [89] https://docs.attio.com/rest-api/webhook-reference/record/merged — Attio — doc

### Clay / Folk
- [90] https://www.university.clay.com/docs/csv-import-overview — Clay — doc
- [91] https://community.clay.com/x/support/10kg911pxtx5/ (community support threads; URL truncated in source) — Clay — blog
- [92] https://help.folk.app/en/articles/5865891-import-contacts-from-a-file — Folk — doc

### ZoomInfo
- [93] https://help.zoominfo.com/18424-salesforce/deduping — ZoomInfo — doc(snippet)
- [94] https://help.zoominfo.com/s/article/Salesforce-Custom-Duplicate-Check — ZoomInfo — doc(snippet; 401s unauthenticated)
- [95] https://help.zoominfo.com/48500-using-zoominfo-with-connected-systems/336606-exporting-from-zoominfo-reachout-to-salesforce — ZoomInfo — doc(snippet)
- [96] https://help.zoominfo.com/s/article/How-to-Create-a-Deduplication-Task — ZoomInfo — doc(snippet)
- [97] https://learn.microsoft.com/en-us/dynamics365/sales/configure-export-preferences-zoominfo — ZoomInfo (Microsoft) — doc
- [98] https://pipeline.zoominfo.com/operations/corporate-hierarchy-data — ZoomInfo — blog (vendor)
- [99] https://pipeline.zoominfo.com/sales/salesforce-duns-number — ZoomInfo — blog (vendor)
- [100] https://pipeline.zoominfo.com/sales/corporate-family-tree-hierarchy-data-advantage — ZoomInfo — blog (vendor)
- [101] https://cloud.google.com/blog/products/data-analytics/zoominfo-data-cubes-available-via-google-analytics-hub — ZoomInfo (Google) — blog
- [102] https://www.toplineresults.com/2025/02/how-to-avoid-duplicates-when-importing-zoominfo-data/ — ZoomInfo — blog
- [103] https://www.workato.com/integrations/dun-and-bradstreet~zoom_info — ZoomInfo/D&B — blog

### D&B / Crunchbase / Clearbit
- [104] https://docs.dnb.com/direct/2.0/en-US/linkage/latest/orderproduct/linkage-rest-API — D&B — doc(snippet; 403 on fetch)
- [105] https://www.dnb.com.hk/resources_center/files/DNB_Master_Data_Hierarchies-Whitepaper.pdf — D&B — doc (whitepaper)
- [106] https://docs.dnb.com/onboard/en-GB/Business/Reports/global-family-tree-report — D&B — doc(snippet)
- [107] https://na3.dnbi.com/help/dnbi_help_CorporateLinkagetab.html — D&B — doc
- [108] https://docs.reltio.com/ (D&B enrichment: hierarchies-and-relationships; full path truncated in source) — D&B (Reltio) — doc
- [109] https://support.crunchbase.com/hc/en-us/articles/360022419013-Adding-a-Sub-Organization — Crunchbase — doc(snippet; 403)
- [110] https://ar5iv.labs.arxiv.org/html/1907.08671 — Crunchbase (academic) — blog-grade
- [111] https://data.crunchbase.com/docs/organizationsummary — Crunchbase — doc
- [112] https://clearbit.com/blog/api-updates — Clearbit — doc (vendor changelog)
- [113] https://clearbit.com/blog/company-name-to-domain-api — Clearbit — doc (vendor)
- [114] https://help.clearbit.com/hc/en-us/articles/8502992633111 — Clearbit — doc

### Outreach / Salesloft
- [115] https://support.outreach.io/hc/en-us/articles/32643378497307-How-to-View-a-List-of-Records-via-Bulk-Actions-and-Import-Logs — Outreach — doc
- [116] https://support.outreach.io/hc/en-us/articles/221467927-How-To-Bulk-Create-Prospects-and-Accounts-in-Outreach-via-CSV-File — Outreach — doc
- [117] https://support.outreach.io/hc/en-us/articles/115004080054-Outreach-Governance-Profile-Settings-Overview — Outreach — doc
- [118] https://help.salesloft.com/s/article/View-Your-Import-History — Salesloft — blog (JS-walled; snippet only)
- [119] https://help.salesloft.com/s/article/Import-People-from-a-CSV — Salesloft — blog (snippet only)
- [120] https://help.salesloft.com/s/article/Complete-Your-Import — Salesloft — blog (snippet only)
- [121] https://help.salesloft.com/s/article/Roles-and-Permissions — Salesloft — blog (snippet only)

### Standards, unified APIs, libraries
- [122] https://www.rfc-editor.org/rfc/rfc6350.html — vCard 4.0 (IETF) — doc
- [123] https://www.rfc-editor.org/rfc/rfc9553.html — JSContact (IETF) — doc
- [124] https://www.twilio.com/docs/lookup/v2-api/line-type-intelligence — Twilio — doc
- [125] https://github.com/google/libphonenumber — Google libphonenumber — doc
- [126] https://pub.dev/documentation/libphonenumber_platform_interface/latest/libphonenumber_platform_interface/PhoneNumberType.html — libphonenumber (enum mirror) — doc
- [127] https://docs.merge.dev/crm/contacts/ — Merge.dev — doc
- [128] https://docs.merge.dev/ats/candidates/ — Merge.dev — doc
- [129] https://docs.merge.dev/basics/syncing-data/ — Merge.dev — doc
- [130] https://docs.merge.dev/merge-unified/reading-data/syncing-best-practices — Merge.dev — doc
- [131] https://help.merge.dev/en/articles/5392795-deleted-data-detection — Merge.dev — doc
- [132] https://developers.apideck.com/apis/crm/reference/contacts — Apideck — doc
- [133] https://nango.dev/docs/guides/platform/unified-apis — Nango — doc
- [134] https://nango.dev/blog/best-practices-build-unified-api — Nango — blog (vendor)
- [135] https://docs.nango.dev/guides/syncs/use-a-sync — Nango — doc
- [136] https://nango.dev/docs/implementation-guides/use-cases/syncs/realtime-syncs — Nango — doc
- [137] https://docs.bullmq.io/guide/jobs/getters — BullMQ — doc
- [138] https://docs.bullmq.io/guide/events — BullMQ — doc
- [139] https://docs.bullmq.io/guide/queues/adding-bulks — BullMQ — doc
- [140] https://github.com/taskforcesh/bullmq/issues/1670 — BullMQ — blog (issue thread)
- [141] https://docs.bullmq.io/ — BullMQ — doc (absence-of-feature claims: blog-grade)
- [142] https://github.com/sidekiq/sidekiq/wiki/Batches — Sidekiq Pro — doc
- [143] https://www.papaparse.com/docs — PapaParse — doc
- [144] https://docs.sheetjs.com/docs/demos/bigdata/stream/ — SheetJS — doc
- [145] https://git.sheetjs.com/sheetjs/sheetjs/issues/61 — SheetJS — blog (issue thread)
