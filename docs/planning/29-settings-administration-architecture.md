# 29 — Settings & Administration Architecture

> Companion to the enterprise audit ([28](./28-enterprise-readiness-audit.md)): the **complete settings
> catalog** the platform should expose — every setting with its description, default, allowed values, role
> access, backend impact, frontend behavior, and audit requirement — plus the **administration role
> architecture** and the **approval-workflow matrix**. It extends (never contradicts)
> [12 — Settings](./12-settings.md): settings already planned there are cited; settings this audit adds are
> marked **✚**. This is a recommendation catalog, not a locked decision — adoption is itemized per gap ID
> in [28 §12](./28-enterprise-readiness-audit.md).

## 1. Settings model & governance

- **Registry, not sprawl (✚, G-SET-1).** Every setting is a row in a typed **settings registry**
  (key, type, scope, default, allowed values, `editableBy`, `lockable`, plan tier, since-milestone),
  defined in `packages/types`; storage stays in the owning tables/jsonb ([03](./03-database-design.md))
  but the registry is the single catalog the UI, API, and docs render from.
- **Scopes & precedence.** `platform → tenant → workspace → team → user`. Two resolution classes:
  **security-class** settings resolve **strictest-wins** (the [ADR-0018](./decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md)
  pattern — a child may only tighten); **preference-class** settings resolve **nearest-wins** (child
  overrides parent unless the parent sets `locked`).
- **Effective-value API (✚).** `GET /settings/effective?scope=…` returns the resolved value + the scope it
  came from + whether it is locked — the UI never re-implements precedence.
- **Audit (✚, G-CMP-1/G-SET-1).** Every settings mutation writes a **`settings.update`** audit row
  (key, scope, before → after, actor). In the tables below the **Audit** column says `std` for exactly
  this; rows needing more name the extra action(s).
- **Role legend** (administration model in §18): `TO` tenant owner · `BA` billing admin (✚) ·
  `SA` security admin (✚) · `CA` compliance admin (✚) · `WA` workspace owner/admin · `TM` team manager ·
  `TL` team lead · `U` member (self-service) · `staff` platform staff ([13](./13-platform-admin.md)).
  Until G-AUTH-10 lands, `BA`/`SA`/`CA` collapse onto `TO`.

## 2. User settings (scope: user)

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| Profile (name, avatar) | identity display ([12 §2](./12-settings.md)) | — | text/image | U | `users` row | header/user row | std |
| Timezone | timestamps + scheduling display | browser-detected | IANA tz | U | render + send-window math | all dates localized | std |
| Locale (✚ G-UX-1) | UI language + formats | `en-US` | supported locales | U | i18n catalog selection | full UI relocalizes | std |
| Theme (✚ G-UX-4) | light/dark/system | `light` | light·dark·system | U | none (client token swap) | instant theme swap | std |
| Table density | comfortable/compact ([04 §8](./04-ui-ux-design.md)) | comfortable | 2 values | U | persisted pref | grid row height | — |
| Default workspace/team (✚) | landing context after login | last-used | accessible ids | U | session bootstrap | login lands in context | std |
| Keyboard shortcuts (✚ G-UX-5) | remap bindings | platform defaults | binding map | U | pref blob | `?` overlay reflects | — |
| MFA methods / passkeys / devices / sessions | security self-service ([17 §10](./17-authentication.md)) | — | per 17 | U | auth-origin tables | Account Security pages | auth events |
| Sending identity | connect mailbox/LinkedIn, signature, display name ([12 §2](./12-settings.md), M9) | none | OAuth connections | U (policy-gated) | `sending_identities` (+ read scopes per G-INT-1) | Sequences/Inbox pickers | std + `oauth.link` |
| Personal access tokens | API tokens if tenant allows ([12 §2](./12-settings.md)) | off | scoped tokens | U (gated by SA policy) | hashed tokens | developer panel | `apikey.use` |
| AI assist opt-out (✚) | disable AI features for this user | enabled | on·off | U | `AiPort` guard per user | AI affordances hidden | std |
| Notification prefs | → §15 matrix | — | — | U | — | — | std |

## 3. Workspace settings (scope: workspace; editor `WA` unless noted)

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| General (name, slug, region, tz, branding) | identity ([12 §3](./12-settings.md)) | — | text/region | WA | `workspaces` | shell labels | std |
| Default record visibility | new records' `record_visibility` ([12 §3](./12-settings.md), H18) | `workspace` | workspace·team·owner | WA | overlay row default | create forms preselect | std |
| ✚ Import conflict policy (G-IMP-5) | matched-duplicate field handling on import/enrich (the per-import override + workspace default; full design §14a) | `fill_empty_only` | skip_existing·overwrite·fill_empty_only·route_to_review | WA | import/enrich upsert branch ([03](./03-database-design.md) owns the `ON CONFLICT` SQL) | import wizard shows + overrides policy | std |
| ✚ Auto-enrich policy (G-ENR-1) | when enrichment fires + field allowlist + monthly budget | off | triggers (on_create·on_reveal·scheduled), field list, budget int | WA | enqueue rules on events; budget check | Data Health shows policy + burn | std |
| ✚ Provider preferences (G-ENR-5) | pin/exclude providers in the waterfall | platform order | ordered subset | WA | waterfall ordering bound by `provider_configs` | enrichment panel note | std |
| ICP & scoring weights | score configuration ([12 §3](./12-settings.md), [ADR-0008](./decisions/ADR-0008-lead-scoring-model.md)) | platform template | weight set | WA | re-score job | score breakdown reflects | std |
| ✚ Per-team scoring profiles (G-SCR-4) | allow team-level ICP overrides | off | on·off | WA | scoring reads team profile | team settings gain ICP tab | std |
| ✚ Custom fields (G-REV-5) | define typed fields on contacts/accounts | none | type ∈ text·number·date·enum·multi·user·url; validation; cap per plan | WA | `custom_field_definitions/values`; index/search/CRM-map | builder UI; fields appear in forms/grid/filters | std |
| ✚ Custom stages (G-REV-7) | stage layer mapping onto canonical `outreach_status` | canonical set | named stages → status map | WA | stage table; reports group by stage | pipeline/board views | std |
| ✚ Tags governance (G-REV-6) | who may create tags; tag list | members may create | roles; tag CRUD | WA | `tags` tables | tag pickers, bulk tag | std |
| ✚ Trash retention (G-REV-4) | restore window for deleted records | 30 days | 7–90 days | WA | purge job schedule | Trash panel countdown | std |
| ✚ Required fields on create (§6) | enforce completeness | none | field set | WA | validation in `types` | create forms mark required | std |
| Import defaults | default mapping template + default conflict policy ([12 §3](./12-settings.md)) | — | per §14/§14a | WA | import pipeline ([30](./30-bulk-import-export-pipeline.md)) | wizard prefill | std |
| Suppression / DNC (workspace scope) | workspace DNC list ([08 §3](./08-compliance.md)) | empty | entries + CSV | WA·CA | `suppression_list` | compliance panel | `suppression.add/remove` |
| Sending & deliverability | → §7 | — | — | WA | — | — | std |
| Teams & departments | create teams, personas, budgets ([12 §3](./12-settings.md)) | — | per §4 | WA | `teams`/budgets | team switcher | std |
| Automation | → §10 | — | — | WA·TM | — | — | std |
| AI assistant | → §11 | — | — | WA | — | — | std |
| Data freshness & retention | re-verify cadence + purge policy ([12 §3](./12-settings.md), [22](./22-data-quality-freshness-lifecycle.md)) | platform SLAs | per-field cadences | WA·CA | `data_quality_rules`/`verification_jobs` | Data Health shows SLAs | std |
| Export policies | caps/frequency/approval ([26 §8](./26-integrations-data-delivery.md)) | plan defaults | per §14 | WA | export guard | export center notices | std |
| ✚ Bulk-reveal / export approval thresholds (G-REV-1, G-IMP-7) | per-user daily reveal cap + the row threshold above which bulk reveal / import / export needs approval (full design §14a; matrix §19) | off | caps int; thresholds int | WA·BA | reveal/import/export guard pre-tx ([30](./30-bulk-import-export-pipeline.md), [ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md)) | bulk bar shows cap/approval | std + `reveal` meta |
| ✚ Workspace archive (G-WS-1) | archive → read-only → purge lifecycle | active | active·archived | WA (TO confirm) | RLS read-only mode; purge timer | banner + restore | std |
| ✚ Quota meters (G-WS-4) | contact/storage usage vs plan caps | — | read-only | view: all | counters | usage bars + warnings | — |

## 4. Team / department settings (scope: team; editor `TM` within `WA` bounds)

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| Team identity | name, `department_type`, parent ([25 §2](./25-departments-teams-workspaces.md)) | — | enum + text | WA | `teams` | team switcher | std |
| Persona defaults | home dashboard, default views/segments, report pack ([25 §3](./25-departments-teams-workspaces.md)) | per `department_type` seed | view/segment ids | TM | persona resolution | destinations re-skin | std |
| Credit budget | monthly slice + `hard_cap` ([25 §5](./25-departments-teams-workspaces.md)) | none | int + bool | TO·BA | in-tx budget check (H2/H18) | budget bar; block at cap | `credit.adjust` on change |
| Automation policy | allowed triggers/actions per team ([27 §7](./27-workflow-automation-engine.md)) | workspace default | enum subsets | WA | rule validation | builder hides disallowed | std |
| AI budget + allowed tasks | per-team AI bounds ([23 §7](./23-ai-intelligence-layer.md)) | workspace default | int + task subset | WA | `AiPort` budget guard | AI panels show budget | std |
| Export caps | per-team export bounds ([26 §8](./26-integrations-data-delivery.md)) | workspace default | ints | WA | export guard | export center | std |
| ✚ Capacity calendar (G-DEP-2) | working hours, holidays, member OOO | none | calendar | TM | routing/SLA/send-window inputs | OOO badges; routing skips | std |
| ✚ Routing membership (G-INB-1) | who is in assignment rotation + weights | all members | member set + weights | TM | routing engine | inbox assignment | std |
| ✚ Team-created record visibility | default `record_visibility` for this team's records | workspace default | workspace·team·owner | TM | row default | create forms | std |

## 5. Sequence (campaign) settings (per sequence; workspace defaults under §3)

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| Send schedule & throttle | dispatch pacing ([11 §4.3](./11-information-architecture.md)) | workspace default | rate/day, ramp | U (owner)·TM | dispatch scheduler | schedule panel | std |
| ✚ Send window (G-OUT-2) | recipient-local windows + quiet hours + holiday calendar | 9–17 recipient-local, Mon–Fri | windows; calendar ref | U·TM | scheduler computes per-recipient | step preview shows window | std |
| ✚ Exit & goal rules (G-OUT-3) | auto-exit on reply/meeting/owner-change; goal metric | exit on reply | rule set | U·TM | enrollment state machine | funnel shows goal | std |
| ✚ A/B variants (G-OUT-1) | per-step variants + split + auto-promote policy | off | % split; promote manual·auto | U·TM | variant assignment + stats | variant editor + stats | std |
| ✚ Tracking (G-OUT-4) | open/click tracking on/off; tracking domain | on (US) · **off (EU)** pending G-CMP-8 | on·off per type | WA default, sequence override (tighten-only) | pixel/redirect injection | per-step tracking badges | std |
| Unsubscribe footer | physical address + unsubscribe ([08 §6](./08-compliance.md)) | workspace value | text | WA only | send-tx blocks if missing | template lint | std |
| ✚ Approval to activate (G-OUT-7) | compliance/brand review gate | off | off·required | WA·CA | activation blocked until approved | "pending review" state | std + approval record |
| Sending identity binding | which identity sends ([11 §4.3](./11-information-architecture.md)) | enroller's identity | identity ids | U | dispatch from identity | picker | std |
| AI drafting | allow AI step drafts (review-locked, [23 §3](./23-ai-intelligence-layer.md)) | per §11 | on·off | WA | `AiPort` gate | draft button visibility | std |

## 6. Contact & account record-model settings (scope: workspace — the G-REV cluster)

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| ✚ Custom field definitions | §3 row (G-REV-5) — listed here as the record-model home | none | typed defs | WA | values + search index + mappings | forms/grid/filters/exports | std |
| ✚ Stage layer | custom stages → canonical map (G-REV-7) | canonical | stage defs | WA | stage table; automation conditions | boards/reports | std |
| ✚ Duplicate sensitivity (G-ENR-6) | fuzzy-match threshold routing pairs to the merge queue | medium | off·low·med·high | WA | candidate generation job | merge-review queue volume | std |
| ✚ Outcome taxonomies (G-ACT-2) | per-`activity_type` outcome sets | platform set | named sets | WA | `activities.outcome` validation | log-activity forms | std |
| ✚ Auto-assignment rules (G-DEP-1) | territory/round-robin owner assignment on create/import/reveal | off | rule refs (→ §10) | WA·TM | automation actions | owner chip auto-set | std + `automation_runs` |
| ✚ Record-edit locking | optimistic-lock behavior (G-REV-2) | on | on·off | staff (platform) | `version` CAS | 409 merge dialog | — |

## 7. Email & deliverability settings (scope: workspace; editor `WA`)

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| Sending domains | domains + DKIM/SPF/DMARC ([12 §3](./12-settings.md)) | none | verified domains | WA | SES identities; DNS checks | status badges | std |
| ✚ Tracking domain (G-OUT-4) | CNAME for open/click links | platform domain | customer CNAME | WA | redirect service binding | setup wizard + check | std |
| Warm-up | ramp schedule per domain ([08 §6](./08-compliance.md)) | on for new domains | schedule presets | WA | send-rate governor | warm-up progress | std |
| Daily send limits | per-domain/mailbox caps ([12 §3](./12-settings.md)) | provider-safe default | ints | WA | dispatch governor | limit meters | std |
| Reputation thresholds | bounce/complaint % that throttle/pause ([08 §6](./08-compliance.md)) | platform defaults | tighten-only | WA (floor: platform) | auto-throttle/pause | deliverability cockpit | std + pause event |
| ✚ Inbox-placement tests (G-OUT-5) | scheduled seed-list placement checks | off | cadence | WA | placement job + report | placement score panel | std |
| ✚ From/reply-to policy | naming conventions, default reply-to | sender identity | patterns | WA | template resolution | compose preview | std |

## 8. Inbox settings (scope: workspace/team)

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| ✚ Assignment routing (G-INB-1) | how new replies assign | manual | manual·round_robin·least_loaded | TM | routing engine on `reply_received` | auto-assigned threads | std |
| ✚ Reply SLA (G-INB-3) | time-to-first-response target + breach alerts | none | duration + alert rule | TM | SLA timers; escalation (§15) | SLA badges/timers | std |
| ✚ Auto-classification (G-INB-2) | AI reply-intent labeling + confidence floor for auto-actions | suggest-only | off·suggest·auto ≥ threshold | WA | `classify_reply` task; automation gate | intent chips on threads | std + `ai_requests` |
| ✚ OOO reroute | reassign an OOO member's threads | off | on·off (uses §4 calendar) | TM | routing skip | banner on reroute | std |
| ✚ Macros / snippets (G-INB-4) | quick-reply snippet library | none | snippet CRUD | TM·U | snippet store | `/` insert menu | std |

## 9. Calling & dialer settings (conditional — exists only if G-TEL-1 chooses to build; all ✚/proposed)

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| Numbers & caller ID | provision/rotate numbers per team/user | none | CPaaS numbers | WA·BA | `CallPort` provisioning; spam-likely monitoring | dialer picker | std |
| Dial mode | click-to-call vs power dialing | click | click·power | TM | dialer session engine | dialer UI mode | std |
| Recording & consent | record on/off; consent mode auto by jurisdiction (two-party states) | off | off·on_with_consent | CA floor, WA within | consent prompt + storage (encrypted, retention class) | consent banner; recording dot | dedicated `call.record` events |
| Quiet hours / TCPA | per-jurisdiction calling windows + DNC-registry check | enforced (non-configurable floor) | tighten-only | CA | pre-dial gate next to suppression (H5 pattern) | blocked-call notices | `reveal.blocked`-style audit |
| Voicemail drops | pre-recorded library | none | clips | TM | drop playback | one-click drop | std |
| Max attempts / cadence caps | per-contact attempt ceilings | platform default | ints | TM | dial gate | attempt counter | std |
| Coaching | listen/whisper/barge by role | managers only | role map | WA | live-audio permissions | coaching controls | dedicated audit |
| Transcription & AI summary | post-call transcript + summary (HITL rules per [23](./23-ai-intelligence-layer.md)) | off | on·off | WA | transcribe task + `ai_requests` | call detail transcript | std + `ai_requests` |

## 10. Automation settings (scope: workspace/team — [27](./27-workflow-automation-engine.md))

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| Rule enable / dry-run | per-rule state ([27 §2](./27-workflow-automation-engine.md)) | dry-run | off·dry_run·live | TM·WA | engine evaluation | run-history labels | std + `automation_runs` |
| ✚ Error policy (G-AUT-3) | retry/skip/disable-after-N + owner notify | retry 3 → disable + notify | policy enum | TM | consumer behavior | rule health badge | std |
| ✚ Rate budget (§4 of 28) | max actions/day per rule | platform default | int | WA | throttle | budget meter | std |
| ✚ Activation approval (G-AUT-5) | require approval before live | off | off·required | WA·CA | approval gate | "pending approval" | std + approval record |
| Allowed triggers/actions | per-team bounds ([27 §7](./27-workflow-automation-engine.md)) | all allowed | enum subsets | WA | rule validation | builder filtering | std |
| ✚ Workspace kill switch | pause all automations (incident brake) | off | on·off | WA | engine global gate | banner on all rules | std |

## 11. AI settings (scope: tenant/workspace/team/user — [23](./23-ai-intelligence-layer.md))

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| ✚ Tenant AI policy (G-AI-3) | org-wide enable + allowed `ai_task_type` set + residency acknowledgment | enabled, all tasks | task subset | TO·CA | `AiPort` tenant gate | AI hidden if disabled | std |
| Workspace AI enable + guardrails | feature toggles ([12 §3](./12-settings.md)) | per tenant | task subset | WA | `AiPort` workspace gate | per-surface affordances | std |
| BYO model key | customer Anthropic key ([12 §3](./12-settings.md)) | off | encrypted key | WA | adapter routing + cost attribution | billing note | std |
| Team AI budget | → §4 row | — | — | — | — | — | — |
| ✚ Auto-action confidence floor | min confidence for AI-triggered automation (ties §8) | high | 0–1 | WA | automation gate | shown on AI rules | std |
| ✚ User opt-out | → §2 row | — | — | — | — | — | — |
| Review-before-send | human review on AI sends/persists (H19) | **locked on** | not configurable | — | hard guard | review modal | `ai_requests` |
| ✚ Feedback capture (G-AI-2) | collect accept/edit/reject telemetry into evals | on | on·off | WA | `ai_evals` feed | rating affordances | std |

## 12. Compliance & data-retention settings (scope: tenant unless noted — [08](./08-compliance.md))

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| Suppression lists | global/tenant/workspace entries ([12 §4](./12-settings.md)) | — | entries + CSV | CA (tenant) · WA·CA (ws) | in-tx gates (H5) | compliance panel | `suppression.add/remove` |
| ✚ Suppression-removal approval | removing an entry needs a second approver | on (tenant scope) | on·off | CA | removal gated | approval flow | `suppression.remove` + approval |
| DSAR intake | public intake + status ([08 §4](./08-compliance.md)) | on | branding, contact | CA | `dsar_requests` | intake page | `dsar.*` |
| ✚ DSAR verification ladder (G-CMP-4) | evidence required per request type | email-proof | ladder steps | CA | verification workflow | intake steps | `dsar.*` |
| Retention windows | per data-class retention ([12 §4](./12-settings.md), [08 §7](./08-compliance.md)) | platform schedule | bounded windows | CA (floor: legal minimums) | partition aging/purge jobs | retention table UI | std |
| ✚ Legal holds (G-CMP-3) | hold scopes overriding purge | none | scope refs | CA | purge/DSAR conflict logic | hold badges | dedicated `legal_hold.*` |
| ✚ Consent templates (G-CMP-7) | per-jurisdiction lawful-basis/consent text + validity | platform defaults | templates | CA | `consent_records` defaults; expiry report | consent panel | `consent.*` |
| ✚ Tracking consent policy (G-CMP-8) | open/click tracking per jurisdiction | EU off | per-jurisdiction map | CA | tracking injection gate (→ §5) | sequence tracking notice | std |
| Data residency | tenant region ([12 §4](./12-settings.md), Enterprise) | US | available regions | TO | region routing ([08 §8](./08-compliance.md)) | residency banner | std |
| Co-op contribution | opt-in to the data co-op ([21 §7](./21-data-acquisition-sourcing.md)) | **off** | on·off + disclosure ack | TO·CA | master-graph contribution flow | disclosure dialog | std |
| Trust Center | DPA/certs/sub-processors view ([12 §4](./12-settings.md)) | on | — | view: all | — | trust pages | — |
| Audit-log viewer + export | tenant audit access ([12 §4](./12-settings.md)) | on | filters; export | TO·CA·SA | partition reads; export job | audit browser | `export` |

## 13. Security settings (scope: tenant/workspace — [17](./17-authentication.md), [12 §4](./12-settings.md))

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| MFA enforcement | off/optional/required (strictest-wins) | optional | 3 values | SA·WA (tighten) | auth-policy resolution | login step-up | std |
| Allowed login methods | password/oauth/magic/sso/passkey set | all | subset | SA | identifier-step routing | method buttons | std |
| Enforce SSO | SSO-only login | off | on·off | SA | non-SSO blocked | SSO handoff | std |
| IP allowlist | CIDR restriction | none | CIDR[] | SA·WA (tighten) | session/policy check | denied-IP page | std |
| Session timeout / cap | lifetime + concurrent cap | platform default | bounded | SA·WA (tighten) | refresh-family TTL | re-auth prompts | std |
| ✚ Managed-device requirement | block untrusted devices (Enterprise) | off | on·off | SA | trusted-device gate | enrollment prompt | std |
| Personal-token policy | allow user PATs ([12 §7](./12-settings.md) open) | off | on·off + scopes | SA | PAT issuance gate | §2 row appears | std |
| ✚ API-key rotation policy | max key age + expiry warnings | none | days | SA | key expiry job | rotation reminders | std |
| ✚ SIEM streaming (G-AUTH-9) | push audit/auth events to customer SIEM | off | endpoint + format | SA | event-backbone sink | delivery health | std |
| ✚ Security-alert routing (G-AUTH-8) | who receives risk events | tenant owners | role/user set | SA | notification routing | §15 matrix row | std |
| ✚ Webhook/egress allowlist (G-SEC-5) | allowed outbound destinations | any (warn) | domain allowlist | SA | webhook/reverse-ETL guard | blocked-destination errors | std |

## 14. Import & export settings (scope: workspace — [05 §3/§12](./05-features-modules.md), [26 §8](./26-integrations-data-delivery.md))

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| Mapping templates (✚ G-IMP-3) | saved per-source column maps, stored + replayed per source (full design §14a; AI auto-map suggestion lives in [23](./23-ai-intelligence-layer.md)) | none | templates | WA·U | import pipeline prefill ([30](./30-bulk-import-export-pipeline.md)) | wizard template picker | std |
| Conflict policy | → §3 row + §14a (G-IMP-5) | — | — | — | — | — | — |
| ✚ Scheduled imports (G-IMP-4) | recurring S3/SFTP/Sheets ingestion | off | source + cadence | WA | scheduled import jobs | import history labels | std |
| ✚ Import limits & preview | max file size + max row count (plan caps in [12 §6a](./12-settings.md)) + mandatory preview over N rows | preview ≥ 10K rows | ints | plan/WA | staging pass (G-IMP-1, [30](./30-bulk-import-export-pipeline.md)) | preview + error file | std |
| ✚ Import approval (G-IMP-7) | approval over N rows (threshold numbers in [12 §6a](./12-settings.md)) | off | threshold | WA | approval gate ([ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md)) | pending state | std + approval |
| Export caps & approvals | row caps + frequency + approval ([26 §8](./26-integrations-data-delivery.md); plan numbers in [12 §6a](./12-settings.md)) | plan defaults | ints + threshold | WA | export guard | export center notices | `export` |
| ✚ Export watermarking (G-INT-7) | trace columns/metadata on exports | off | on·off | SA·WA | export pipeline | noted on download | `export` |
| ✚ Export destination rules | restrict reverse-ETL/webhook targets (ties §13 allowlist) | any | allowlist | SA | delivery guard | destination errors | std |

### 14a. Bulk import/export controls — deep dive (✚ G-IMP-5, G-IMP-3, G-IMP-7, G-REV-1)

The three governance settings above are summary rows; this section is the buildable design they point to.
All of them operate on the **staging → preview → commit** pipeline ([30](./30-bulk-import-export-pipeline.md),
[ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md)) — settings here decide *policy*; the
job mechanics, chunking, and the actual `ON CONFLICT` upsert SQL live elsewhere ([03](./03-database-design.md)
owns the conflict SQL; [23](./23-ai-intelligence-layer.md) owns AI auto-mapping).

**Conflict policy (G-IMP-5).** Resolves what happens to a **matched duplicate** (same blind-index match key,
[03 §11](./03-database-design.md)) when an incoming row collides with an existing field value. One enum, set
per import (overriding the workspace default in §3 / [12 §3](./12-settings.md)):

| Policy value | Field-level behavior on a match | Use it for |
|---|---|---|
| `skip_existing` | leave the matched record untouched; only **insert net-new** rows | append-only loads where the CRM is the source of truth |
| `overwrite` | incoming non-empty value **replaces** the existing value | the file is the authoritative refresh |
| `fill_empty_only` *(default)* | write **only** where the existing field is null/blank; never clobber a value | safe enrichment-style top-ups — the conservative default |
| `route_to_review` | **don't auto-apply** conflicting fields; stage each conflict as a pending diff in the **review queue** (below) | high-trust datasets where a human decides field by field |

`route_to_review` is per-field within a row: non-conflicting fields commit immediately under
`fill_empty_only` semantics, and only the *contested* fields are held — so a partial commit is normal.

**Review queue (the `route_to_review` branch).** A workspace-scoped queue of pending field-level conflicts
produced by `route_to_review` imports (and reused by the G-ENR-6 / §6 fuzzy-merge candidates so there is one
reviewer surface, not two):

- **Item shape.** `{ import_batch_id, record_id, source_import_id, field, existing_value, incoming_value,
  match_confidence, status ∈ pending·accepted·rejected·superseded }`, provenance carried from
  `source_imports` ([03 §11](./03-database-design.md)).
- **Actions.** Per item or bulk: **accept incoming** (apply the new value), **keep existing** (reject),
  or **accept-all-from-this-source**. Each decision is an upsert through the same conflict path
  ([03](./03-database-design.md) SQL) so audit/provenance stay uniform.
- **Workflow.** Resolver role `WA` (or `TM`/`U` if the workspace delegates queue triage); **SLA + aging**
  surfaces via the notification matrix (§15, `imports` class); unresolved items expire to `superseded`
  on the next authoritative load of the same field and are logged, never silently dropped.
- **Audit.** Each resolution writes `settings.update`-class provenance plus the per-record change; the batch
  links its review outcomes for import-undo (G-IMP-2, [30](./30-bulk-import-export-pipeline.md)).

**Bulk-reveal / import / export approval thresholds (G-REV-1, G-IMP-7).** A single row-count threshold model,
reused across the three bulk verbs; the **numbers per plan** are published in [12 §6a](./12-settings.md), the
**approval routing** is the matrix in §19:

- **Reveal** — per-user daily cap + a per-action threshold above which a reveal needs `WA`/`BA` sign-off
  (the preventive control for insider scraping, G-REV-1).
- **Import** — over the plan/workspace row threshold the staged job parks in `pending_approval` before commit
  (G-IMP-7); approver `WA`.
- **Export** — over the cap the export job parks for `WA` approval ([26 §8](./26-integrations-data-delivery.md)).

All three resolve through the **effective-value API** (§1) so a tenant floor can tighten a workspace setting,
and all write an approval record into the §19 matrix outcome.

**Saved column-mapping templates (G-IMP-3 — persistence half).** Mapping (source header → canonical/custom
field) is the #1 import failure point, so we **store and replay** it rather than re-deriving each run:

- **Store.** A template is `{ id, workspace_id, source_name (apollo|zoominfo|linkedin|sales_navigator|
  hubspot|salesforce|clearbit|manual, matching `source_imports.source_name` in [03 §11](./03-database-design.md)),
  name, version, column_map (header → field, including custom fields per §6 / G-REV-5), default_conflict_policy,
  created_by, scope ∈ workspace·user }`. Editing bumps `version` (prior versions retained for reproducibility +
  import-undo).
- **Replay.** On a new import the wizard **auto-selects the template matching the detected source** and
  prefills the mapping + its default conflict policy; the user can override per run without mutating the saved
  template. A workspace **default template** (§3 "Import defaults", [12 §3](./12-settings.md)) is applied when
  no source-specific template matches.
- **Boundary.** Persistence + replay live here; the **AI auto-map *suggestion*** that proposes a mapping for an
  unrecognized header (Claude `extract_fields`, with confidence) lives in [23](./23-ai-intelligence-layer.md) —
  this setting consumes an accepted suggestion *as* a new/updated template, it does not generate one.

## 15. Notification settings (scope: user + team defaults — G-NTF-1)

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| ✚ Event→channel matrix | per event class (replies, tasks, low credits, imports, DSAR, budget, deliverability, security, automation failures, AI reviews): in-app/email/Slack/none | sensible per class | matrix | U (within team defaults) | notification router | settings grid | std |
| ✚ Digest & quiet hours | batch non-urgent into digests; suppress during quiet hours | daily digest, 19:00–08:00 quiet | cadence + window | U | digest engine (coalescing) | digest preview | std |
| ✚ Low-credit / budget thresholds | when balance/budget warnings fire | 20% remaining | %·absolute | BA·TM | threshold checks | credit-pill warning point | std |
| ✚ Escalation (G-NTF-2) | unacked critical → escalate to manager after N | off | rule | TM | escalation timer | escalation banners | std |
| ✚ Slack/Teams routing | bind event classes to channels ([26 §7](./26-integrations-data-delivery.md)) | none | channel map | WA | Slack app delivery | channel pickers | std |

## 16. Reporting settings (scope: workspace/team)

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| ✚ Report defaults | default date range, tz, fiscal-year start | last 30d | ranges | WA | query defaults | dashboards prefill | std |
| ✚ Scheduled deliveries (G-RPT-2) | dashboard snapshots → email/Slack on cron | none | schedule + recipients | TM·WA | render + delivery jobs | "scheduled" badges | std + `export` |
| ✚ Custom-report sharing | who may build/share custom reports (G-RPT-1) | managers+ | role floor | WA | builder permissions | builder visibility | std |
| ✚ Rollup visibility | who sees team rollups / per-member stats ([25 §6](./25-departments-teams-workspaces.md)) | managers | role floor | WA | report filters | manager-only packs | std |
| ✚ SLA report access (G-RPT-6) | customer uptime/SLA page (Enterprise) | on (Ent) | — | view: TO | SLO read model | trust/SLA page | — |

## 17. Integration settings (scope: workspace; developer items tenant — [12 §5](./12-settings.md), [26](./26-integrations-data-delivery.md))

| Setting | What it does | Default | Values | Edit | Backend impact | Frontend behavior | Audit |
|---|---|---|---|---|---|---|---|
| CRM connections | OAuth connect + status ([05 §14](./05-features-modules.md)) | none | providers | WA | `integrations` tokens | connection cards | std + `oauth.link` |
| ✚ Field mapping + direction (G-INT-3) | per-field map, per-direction rules, conflict policy, **dry-run diff**, version history | template | mapping doc | WA | sync engine config | mapping editor | std |
| ✚ Sync frequency & scope | cadence + object/list scope | 15 min | bounded cadences | WA | sync scheduler | next-sync display | std |
| ✚ Sandbox mode (G-WS-7) | point a connection at a CRM sandbox | off | on·off | WA | sandbox credentials | sandbox badge | std |
| Webhooks | subscriptions, signing secrets, delivery log ([12 §5](./12-settings.md)) | none | event subset | tenant admin | webhook delivery (+ ✚ replay/self-test G-INT-5) | delivery log + test-fire | std |
| Reverse-ETL destinations | warehouse targets ([26 §5](./26-integrations-data-delivery.md)) | none | Snowflake/BQ/Redshift | WA (within §13 allowlist) | scheduled pushes | destination health | std |
| Chrome extension | enable + budget binding ([26 §6](./26-integrations-data-delivery.md)) | off | on·off | WA | extension auth scope | extension state | std |
| SMS channel | provider + consent config ([26 §7](./26-integrations-data-delivery.md)) | off | provider creds | WA·CA | TCPA consent gate | channel availability | std |
| BYO enrichment keys | → §3 provider rows (G-ENR-2) | none | encrypted keys | WA | adapter routing | key health | std |
| ✚ iPaaS (Zapier/Make) (G-INT-6) | enable triggers/actions via public API | off | on·off | tenant admin | API app grants | listing links | std |

## 18. Administration architecture (roles)

Maps the audit's required roles onto the corpus model: staff roles ([13 §2](./13-platform-admin.md)),
tenant capability ([H8]), workspace roles, team roles ([25 §2](./25-departments-teams-workspaces.md)) —
plus the **✚ granular org roles** (G-AUTH-10). "Settings" columns cite this doc's sections.

| Role (audit name → corpus) | Responsibilities | Key permissions | Accessible settings | Restricted from | Approval participation |
|---|---|---|---|---|---|
| **Platform Admin** → staff `super_admin`/`support`/`billing_ops`/`compliance_officer`/`read_only` | operate the platform: tenants, billing ops, abuse, DQ, system health ([13 §3](./13-platform-admin.md)) | cross-tenant under the privileged role; JIT-elevated sensitive actions | platform-scope config (`provider_configs`, flags, plans) | customer-tenant settings (never edits §2–§17 directly); all access audited to `platform_audit_log` | approver+requester in staff JIT; ✚ four-eyes for impersonation/GDPR-delete/large grants (G-PAD-1) |
| **Tenant Owner** → `tenant_members.is_tenant_owner` (✚ org-role `owner`) | the org: plan, billing, workspaces, members, security/compliance posture | billing/checkout, plan, workspace create/archive, org members, SSO/SCIM, residency | §3 (create), §11 tenant, §12, §13, [12 §4](./12-settings.md) | platform scope; other tenants | final approver for archive/purge, residency, retention |
| ✚ **Billing Admin** (`BA`, G-AUTH-10) | spend: credits, budgets, invoices, procurement | top-ups, budget allocation, caps, invoices | billing rows of §3/§4/§15; [12 §4](./12-settings.md) Billing | security/compliance settings; member admin | approver for budget changes + large-spend actions |
| ✚ **Security Admin** (`SA`) | authn/authz posture, keys, SIEM | auth policies, allowlists, tokens, SIEM, egress rules | §13; security rows of §14/§17 | billing; compliance records | approver for policy relaxation (strictest-wins floor still applies) |
| ✚ **Compliance Admin** (`CA`) | suppression, DSAR, consent, retention, holds | all §12 powers; sequence/tracking compliance floors | §12; compliance rows of §5/§9 | billing; engineering settings | approver for suppression removal, sequence activation (when gated), retention changes |
| **Workspace Admin** → workspace `owner`/`admin` | one workspace: members, data model, sending, integrations, automations | invite/role/remove; §3 powers; suppression (ws scope) | §3–§8, §10, §11 (ws), §14, §16, §17 | tenant scope (billing/SSO/residency); other workspaces | approver for ws-scope thresholds (imports, exports, bulk reveals) |
| **Team Admin / Manager** → team `manager` | a department: persona, budgets-in-bounds, routing, plays, coaching | team settings; rollup reports; reassign records | §4, §8, §10 (team), §15 team defaults, §16 schedules | workspace-wide settings; other teams' budgets | requester for budget raises; approver for team-scope automation activation |
| **Supervisor** → team `lead` | day-to-day quality: queues, SLAs, reviews | inbox routing tweaks, review AI drafts, view team stats | §8 (within bounds) | budgets, automation policy | reviewer in content/draft approvals |
| **Agent** → workspace `member` (+ team `member`) | the work: search, reveal (spends credits), enroll, send, log | revealed-data CRUD on visible records; own views/lists | §2; own sequence settings (§5) within team bounds | all admin scopes; suppression edit; settings of others | requester (bulk reveal/export over threshold) |
| **Viewer** → workspace/team `viewer` | read-only: coaching, auditing, exec visibility | search + view revealed; no reveal/send/export ([05 §1](./05-features-modules.md)) | §2 only | every mutating setting | — |

**✚ Custom roles** (Enterprise, post-G-AUTH-10): permission-set builder over the same capability atoms,
constrained so no custom role can exceed its scope's ceiling or relax a strictest-wins floor.

## 19. Approval-workflow matrix (✚ unless cited)

| Action | Trigger threshold | Requester | Approver | Record |
|---|---|---|---|---|
| Large export | over cap ([26 §8](./26-integrations-data-delivery.md)) | Agent+ | WA | `export` audit + approval id |
| Bulk reveal | over G-REV-1 threshold | Agent | WA·BA | `reveal` metadata + approval id |
| Large import | over §14 threshold | Agent+ | WA | std + approval id |
| Suppression removal | any (tenant/global scope) | CA·WA | second CA (four-eyes) | `suppression.remove` + approval |
| Sequence activation | when §5 gate on | sequence owner | CA (or designated reviewer) | std + approval |
| Automation activation | when §10 gate on | TM | WA·CA | `automation_runs` + approval |
| Team budget change / transfer | any change | TM | BA·TO | `credit.adjust` |
| Retention-window change | any change | CA | TO (+ counsel note) | std |
| Workspace archive/purge | purge step | WA | TO | std |
| Staff: impersonation (full), GDPR delete, credit grant > threshold | per [13 §2](./13-platform-admin.md) + G-PAD-1 | staff | second staff (JIT, four-eyes) | `platform_audit_log` |

## Links
- **Links to:** [28](./28-enterprise-readiness-audit.md) (gap IDs), [12](./12-settings.md) (the planned
  settings this catalog extends), [13](./13-platform-admin.md), [17](./17-authentication.md),
  [25](./25-departments-teams-workspaces.md), [27](./27-workflow-automation-engine.md),
  [23](./23-ai-intelligence-layer.md), [22](./22-data-quality-freshness-lifecycle.md),
  [26](./26-integrations-data-delivery.md), [08](./08-compliance.md),
  [ADR-0018](./decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md) (strictest-wins pattern),
  [ADR-0022](./decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md).
- **Linked from:** [README](./README.md) (index), [28](./28-enterprise-readiness-audit.md).

## Open questions

1. **Registry storage** — typed registry table vs generated catalog from `packages/types` constants
   (leaning: constants as source of truth, registry materialized for the UI).
2. **Which ✚ settings ship at each milestone** — adoption is gap-by-gap per
   [28 §12](./28-enterprise-readiness-audit.md); the settings here should land *with* their feature.
3. **Org-role granularity** (G-AUTH-10) — fixed four roles (owner/billing/security/compliance) vs
   capability sets from day one.
4. **§9 telephony settings** are contingent on the G-TEL-1 decision and stay dormant until it is made.
