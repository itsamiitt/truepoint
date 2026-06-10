# LeadWolf Planning — Wiring Map

> The source of truth for **what is connected to what** in `docs/planning/`. `plan-weaver` reads this
> before any change to compute the impact set. If the live docs have structurally drifted from this
> map, trust the live docs and update this file as part of the change.
>
> **Model (since 2026-05-29):** per-workspace multi-tenant CRM ([ADR-0006]) on an AWS-native
> self-hosted stack ([ADR-0010]). The earlier global-golden-DB / three-layer / ledger design is
> superseded — see the ADR registry (§6).
>
> **Extended 2026-06-10:** docs **18–27** + **`departments/`** and **ADR-0022–0027** add scale/SRE,
> event/real-time, data acquisition & freshness, AI, advanced-search UX, departments/teams, integrations,
> and automation. Docs **28–29** are an **enterprise-readiness audit overlay** (findings + settings/admin
> catalog — recommendations only, no locked decisions; gap IDs `G-…`, drift findings `F-…` in 28 §11).
>
> Shorthand: `NN` = `docs/planning/NN-*.md`; `ADR-N` = `docs/planning/decisions/ADR-000N-*.md`.

## 1. Files

| Ref | Path |
|---|---|
| README | `docs/planning/README.md` |
| 00 | `docs/planning/00-overview.md` |
| 01 | `docs/planning/01-tech-stack.md` |
| 02 | `docs/planning/02-architecture.md` |
| 03 | `docs/planning/03-database-design.md` |
| 04 | `docs/planning/04-ui-ux-design.md` |
| 05 | `docs/planning/05-features-modules.md` |
| 06 | `docs/planning/06-enrichment-engine.md` |
| 07 | `docs/planning/07-billing-credits.md` |
| 08 | `docs/planning/08-compliance.md` |
| 09 | `docs/planning/09-api-design.md` |
| 10 | `docs/planning/10-roadmap.md` |
| 11 | `docs/planning/11-information-architecture.md` |
| 12 | `docs/planning/12-settings.md` |
| 13 | `docs/planning/13-platform-admin.md` |
| 14 | `docs/planning/14-phase-1-execution.md` |
| 15 | `docs/planning/15-gap-remediation.md` |
| 16 | `docs/planning/16-code-organization.md` |
| 17 | `docs/planning/17-authentication.md` |
| 18 | `docs/planning/18-scalability-performance.md` |
| 19 | `docs/planning/19-observability-reliability.md` |
| 20 | `docs/planning/20-event-driven-realtime-backbone.md` |
| 21 | `docs/planning/21-data-acquisition-sourcing.md` |
| 22 | `docs/planning/22-data-quality-freshness-lifecycle.md` |
| 23 | `docs/planning/23-ai-intelligence-layer.md` |
| 24 | `docs/planning/24-advanced-search-exploration-ux.md` |
| 25 | `docs/planning/25-departments-teams-workspaces.md` |
| 26 | `docs/planning/26-integrations-data-delivery.md` |
| 27 | `docs/planning/27-workflow-automation-engine.md` |
| 28 | `docs/planning/28-enterprise-readiness-audit.md` *(audit overlay — findings/recommendations, no decisions)* |
| 29 | `docs/planning/29-settings-administration-architecture.md` *(audit companion — settings + admin catalog)* |
| departments | `docs/planning/departments/` (README + 11 modules) |
| brand | `docs/planning/brand-identity.md` |
| ADR-1 | `decisions/ADR-0001-orm-drizzle.md` |
| ADR-2 | `decisions/ADR-0002-search-postgres-then-engine.md` |
| ADR-3 | `decisions/ADR-0003-three-layer-data-model.md` *(superseded)* |
| ADR-4 | `decisions/ADR-0004-credit-ledger-idempotency.md` *(superseded)* |
| ADR-5 | `decisions/ADR-0005-multi-tenancy-and-global-contact-db.md` *(superseded)* |
| ADR-6 | `decisions/ADR-0006-per-workspace-multitenant-model.md` |
| ADR-7 | `decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md` |
| ADR-8 | `decisions/ADR-0008-lead-scoring-model.md` |
| ADR-9 | `decisions/ADR-0009-outreach-engine-enroll-and-send.md` |
| ADR-10 | `decisions/ADR-0010-aws-native-self-hosted-stack.md` |
| ADR-11 | `decisions/ADR-0011-platform-admin-and-privileged-access.md` |
| ADR-12 | `decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md` |
| ADR-13 | `decisions/ADR-0013-charge-for-verified-data-credit-back.md` |
| ADR-14 | `decisions/ADR-0014-trust-and-certification-program.md` |
| ADR-15 | `decisions/ADR-0015-entity-resolution-dedup-engine.md` |
| ADR-16 | `decisions/ADR-0016-dedicated-auth-origin-and-cross-domain-token-exchange.md` |
| ADR-17 | `decisions/ADR-0017-progressive-identifier-first-login-and-domain-tenant-routing.md` |
| ADR-18 | `decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md` |
| ADR-19 | `decisions/ADR-0019-global-identity-and-tenant-membership.md` |
| ADR-20 | `decisions/ADR-0020-existence-revealing-identifier-first-and-registration.md` |
| ADR-21 | `decisions/ADR-0021-global-master-graph-and-overlay.md` |
| ADR-22 | `decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md` |
| ADR-23 | `decisions/ADR-0023-ai-provider-and-intelligence-architecture.md` |
| ADR-24 | `decisions/ADR-0024-performance-slos-and-capacity-model.md` |
| ADR-25 | `decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md` |
| ADR-26 | `decisions/ADR-0026-workflow-automation-engine.md` |
| ADR-27 | `decisions/ADR-0027-real-time-delivery-and-event-backbone.md` |
| ADR-28 | `decisions/ADR-0028-record-customization-layer.md` |
| ADR-29 | `decisions/ADR-0029-credit-ledger-and-lease-decrement.md` |
| ADR-30 | `decisions/ADR-0030-granular-tenant-org-roles.md` |
| (input) | `docs/planning/proposals/2026-05-29-multi-tenant-schema.md` (adopted) |

## 2. Adjacency list (doc → docs/ADRs it references)

`03` is the **hub**. `01`/`ADR-10` (stack) and `ADR-6` (tenancy/data model) are the other high-blast-radius nodes.

| Doc | References |
|---|---|
| README | 00–29, departments/, brand, decisions/ |
| 00 | 01, ADR-1..20, 04, 05, 06, 07, 08, 10, 11, 12, 13, 14, 16, 17 (decision log §7 + open Qs §8) |
| 01 | 03, 04, 10, 17, ADR-1, ADR-2, ADR-10, ADR-16 |
| 02 | 01, 03, 06, 08, 16, ADR-6, ADR-10, ADR-19 |
| 03 | 06, 07, 08, 17, ADR-1, ADR-2, ADR-6, ADR-7, ADR-8, ADR-9, ADR-10, ADR-16, ADR-17, ADR-18, ADR-19, ADR-20, ADR-21 |
| 04 | (self-contained; others reference it for design tokens) + workspace switcher → 02/05 |
| 05 | 03, 04, 06, 07, 08, 09, 10, 17, ADR-6, ADR-8, ADR-9, ADR-16, ADR-17, ADR-18, ADR-19, ADR-20 |
| 06 | 03, 07, 08, ADR-8 |
| 07 | 03, 06, 08, 09, ADR-7 |
| 08 | 03, 06, 07, 09, 17, ADR-6, ADR-9 |
| 09 | 03, 07, 08, 17, ADR-10, ADR-16, ADR-17, ADR-18, ADR-19, ADR-20 |
| 10 | 01, 03, 05, 06, 07, 08, 09, 17, ADR-2, ADR-6, ADR-7, ADR-8, ADR-9, ADR-10, ADR-16, ADR-17, ADR-18 (risk register) |
| ADR-6 | 02, 03 (supersedes ADR-3, ADR-5; user scoping amended by ADR-19) |
| ADR-7 | 07, 03 (supersedes ADR-4) |
| ADR-8 | 03, 06 |
| ADR-9 | 05, 09, 08 |
| ADR-10 | 01, 02 (auth transport amended by ADR-16) |
| ADR-11 | 13, 02, 03 |
| ADR-12 | 07, 00 |
| ADR-13 | 07, 06, 03 |
| ADR-14 | 08, 10 |
| ADR-15 | 03, 06 |
| ADR-16 | 17, 09, 01 (amends ADR-10 auth transport) |
| ADR-17 | 17, 03, 12 (no-enumeration amended by ADR-20) |
| ADR-18 | 17, 12, 03 |
| ADR-19 | 17, 03, 02, 05 (amends ADR-6 user scoping) |
| ADR-20 | 17, 03, 09, 12 (amends ADR-17 no-enumeration) |
| ADR-21 | 02, 03, 06, 08, 09, 10 (two-layer master graph + overlay; reopens ADR-6; revives ADR-3/5; amends ADR-2/15) |
| 11 | 02, 04, 05, 06, 07, 08, 09, 10, 12, 13, ADR-2, ADR-6, ADR-8, ADR-9, ADR-10 |
| 12 | 03, 07, 08, 09, 11, 17, ADR-6, ADR-16, ADR-17, ADR-18, ADR-19, ADR-20 |
| 13 | 01, 02, 03, 06, 08, 09, 10, ADR-10, ADR-11 |
| 14 | 01, 02, 03, 04, 05, 07, 08, 10, 16, brand, ADR-2, ADR-6, ADR-7, ADR-10 |
| 15 | 00, 03, 05, 06, 07, 08, 09, 10, 12, 13, ADR-12, ADR-13, ADR-14 (gap-remediation overlay; links out to ../market-analysis/) |
| 16 | 00, 01, 02, 11, 13, 14, ADR-2, ADR-6, ADR-10, ADR-11 (engineering-conventions overlay; details 02 §1 on-disk layout) |
| 17 | 03, 04, 05, 08, 09, 11, 12, 13, ADR-6, ADR-10, ADR-11, ADR-16, ADR-17, ADR-18, ADR-19, ADR-20 (auth/identity service on auth.truepoint.in) |
| brand | 04, 08, 11 |
| 18 | 01, 02, 03, 09, 10, 19, 20, ADR-24, ADR-10, ADR-21 |
| 19 | 01, 02, 10, 13, 18, 20, 23, ADR-10, ADR-24 |
| 20 | 02, 03, 09, 18, 19, 23, 26, 27, ADR-27, ADR-21 |
| 21 | 06, 03, 08, 22, 10, 13, ADR-21, ADR-15 |
| 22 | 06, 03, 08, 07, 13, 20, 21, 10, ADR-25, ADR-15 |
| 23 | 05, 06, 03, 08, 09, 16, 20, 27, 10, ADR-23, ADR-8 |
| 24 | 04, 05, 11, 09, 18, 20, 25, 27, 03, ADR-21 |
| 25 | 02, 03, 05, 07, 09, 11, 12, 24, 27, departments/, ADR-22 |
| 26 | 05, 09, 20, 24, 27, 12, 08, ADR-12 |
| 27 | 20, 03, 05, 22, 23, 24, 25, 26, 09, 12, 08, ADR-26 |
| 28 | 00–27, departments/, 29 (audit overlay; cites ADR-7/13/14/18/22–27; reports drift, edits nothing) |
| 29 | 28, 12, 13, 17, 22, 23, 25, 26, 27, 08, ADR-18, ADR-22 |
| departments/ | 25 (+ 24, 27, 23, 22, 08, 06, 07, 12, 17) |
| ADR-22 | 25, 03 (additive to ADR-6/ADR-19; no tenancy tier) |
| ADR-23 | 23, 05 (resolves 00 §8 Q8) |
| ADR-24 | 18, 02 |
| ADR-25 | 22, 06 |
| ADR-26 | 27, 05 |
| ADR-27 | 20, 02 |
| ADR-28 | 05, 03 (record customization; 28 G-REV cluster) |
| ADR-29 | 07, 03 (amends ADR-7 — executes its revisit path; 28 G-BIL-1/2) |
| ADR-30 | 03, 17, 12 (amends ADR-19 capability model; resolves drift F-4; 28 G-AUTH-10) |

**Bidirectional pairs:** 00↔ADRs; 03↔ADR-6/7/8/9/10; 05↔10 (matrix↔roadmap); 07↔08↔09 (reveal+send path); 11↔04 (IA↔nav); 11↔12↔13 (app surface); 13↔ADR-11; 10↔14 (roadmap↔execution); 02↔16, 14↔16 (architecture↔code-organization); 04↔brand (design↔brand); 07↔ADR-12/13, 08↔ADR-14, 06↔ADR-13, 03↔ADR-13 (remediation decisions); 10↔15, 05↔15 (gap remediation); 03↔ADR-15, 06↔ADR-15 (entity resolution); superseded↔superseding (ADR-3/5↔ADR-6, ADR-4↔ADR-7); 17↔03/05/09/12 (auth ↔ schema/features/API/settings); 00↔ADR-16/17/18; 03↔ADR-16; ADR-10↔ADR-16 (auth transport amended); 17↔ADR-19/20; ADR-6↔ADR-19 (user scoping amended); ADR-17↔ADR-20 (no-enumeration amended); 00↔ADR-19/20; **03/02/06/08↔ADR-21** (two-layer master graph + overlay), ADR-21↔ADR-2/6/15 (amends), ADR-21↔ADR-3/5 (revives as hybrid); 00↔ADR-21.
**New (2026-06-10):** 25↔departments/, 25↔03/05/07/11/12/24/27 (departments); 23↔05/06/08/09/16/20/27 (AI);
18↔02/10/19/20, 19↔18/20/13, 20↔02/03/09/18/26/27 (scale/SRE/events); 21↔06/08/22, 22↔06/03/07/08/21
(data acquisition/freshness); 24↔04/05/11 (search UX); 26↔05/09/27; 27↔20/22/23/24/25/26 (automation);
00↔ADR-22..27; 03↔ADR-22/25; 05↔ADR-23/26; 02↔ADR-24/27; 22↔ADR-25; 27↔ADR-26; 25↔ADR-22; 23↔ADR-23.
**Audit overlay (2026-06-10):** 28↔29 (audit ↔ settings catalog); README↔28/29 (index). 28/29 link *out*
to the whole corpus one-way — no reciprocal links required from 00–27 (overlay convention, like 14/15).
**Remediation Pass 1 (2026-06-10):** ADR-28/29/30 + tripod rows (00 §7); 05 §7↔03 §14↔10 M8 (record
customization); 07 §2↔03 §8↔10 M11/M12↔02 §3.1 (ledger + leases); H8 propagated to org_role across
03/02/05/09/12/17; audit-enum extension in 03 §7 + 08 §5; 08 §16 (breach notification) ↔ 19 §5; risk
register dups renumbered → #23/#24; 28 §11/§12 carry the fix/landing status.

> **Doc 14 (Phase 1 Execution)** is an execution *overlay*: it sequences the build of M0–M5 and must
> agree with 05 §21 / 10 (H10) but introduces no new milestone scope. **`brand-identity.md`** is the
> brand system, downstream of the 04 design tokens.

## 3. Wiring points (keep in lockstep)

| Wiring point | Location | Ties together |
|---|---|---|
| **Master decision log** | 00 §7 | One row per decision; columns Area / Decision / Why-ADR. |
| **Open-questions inventory** | 00 §8 (10), 03 §13 (6), 06 §11, 07 §11, 08 §13, 09 §11, 15 | Resolving one → mark resolved + update the dependent doc. |
| **Feature→milestone matrix** | 05 | Each module's milestone == its 10 definition (H10). |
| **Risk register** | 10 | Each risk's owner-milestone mitigation must appear in that milestone's DoD. |
| **README index + locked-decisions summary** | README | Update on doc add/rename + when locked decisions change. |
| **Stack table** | 01 §1 (canonical) ; mirrored rows in 00 §7 | Stack change → update 01 §1 AND 00 §7. |

## 4. Critical drift hazards (H1–H23) — "edit these together"

| ID | Concept | Locations that must stay consistent |
|---|---|---|
| **H1** | Reveal transaction (suppression-gated; tenant-counter charge; per-workspace first-reveal) | 03 §8/§10, 07 §3, 08 §3, 09 §3 |
| **H2** | Credit accounting (`tenants.reveal_credit_balance` counter, `CHECK>=0`, FOR UPDATE; reveal idempotency via unique `(workspace_id,contact_id,reveal_type)`) | 03 §8/§11, 07 §1/§2/§3, ADR-7, 10 (M3 DoD) |
| **H3** | `source_imports` is the provenance model (no field-level lineage/golden) | 03 §5, 06, 08 §4, ADR-6 |
| **H4** | Per-workspace dedup keys (email_blind_index / linkedin_public_id / sales_nav_lead_id) | 03 §5/§11, 06 (import) |
| **H5** | Suppression — gates reveal **and** send; scopes global/tenant/workspace | 03 §8, 08 §3, ADR-9 |
| **H6** | DSAR delete fan-out across per-workspace copies + source_imports + contact_reveals + activities | 08 §4, 03 §5 |
| **H7** | `email_status` enum (`unverified,valid,risky,invalid,catch_all,unknown`) | 03 §5, 06 §9, 07 §3/§11, 09 §3 |
| **H8** | Roles: workspace roles on `workspace_members` + the tenant-level capability on **`tenant_members.org_role`** (`owner|billing_admin|security_admin|compliance_admin|member` — ADR-30; membership moved off `users` by ADR-19; `is_tenant_owner` = compat alias for `owner`) | 03 §4, 02 §5, 05 §1, 09 §4, 12 §1, 17 §4 |
| **H16** | Global identity: `users` is global (email/username unique); membership in `tenant_members`; per-workspace **data** model unchanged | 03 §4/§9, 02 §4/§5, 05 §1/§2, 09 §4, 17 §4, ADR-19 |
| **H17** | Two-layer data: global master graph (Layer 0, system-owned, **not** RLS) + per-workspace overlay (Layer 1, RLS); reveal sources the master channel; global ER (blocking/LSH/Splink) | 03 §5/§9/§12, 02 §3.1/§3.3/§4/§6, 06 §1/§9, 09 §2/§3, 08 §1/§4, 00 §6/§7, ADR-21 |
| **H9** | RLS via `SET LOCAL app.current_workspace_id` + `app.current_tenant_id` (non-BYPASSRLS role, RDS Proxy GUC reset) | 03 §9, 02 §4, ADR-6, ADR-10 |
| **H10** | Milestone assignment of a feature | 05 (matrix) + 10 (M0–M… detail) |
| **H11** | Navigation model (6 destinations; **Credits not a tab**) | 04 §3 == 11 §2; 05 modules; 09 resources |
| **H12** | Platform privileged access (RLS-bypass role + `platform_audit_log` + impersonation) | 13, ADR-11, 03 §9, 08 |
| **H13** | Charge-by-verified-result + credit-back (charge set by `email_status`; bounce → `credit.adjust`) | 07 §3, 09 §3.2, 06 §9, 03 §8, 05 §7, 10 (M4/M9 DoD), 08 §5 (audit action), ADR-13 |
| **H14** | Auth origin + cross-domain token model (dedicated `auth.truepoint.in` IdP; PKCE code → in-memory access JWT + refresh cookie on auth origin; JWKS) | 17 §1/§3/§5, 09 §1/§4, 03 §4, 05 §1, 10 (M0/M2 + risk #17), ADR-16 |
| **H15** | Auth policy + MFA enforcement (tenant/workspace, strictest-wins; allowed methods, IP allowlist, session timeout) | 17 §4/§7, 12 §3/§4, 03 §4, ADR-18 |
| **H18** | Departments/teams: `teams`/`team_members`/`team_role`/`department_type` + record-visibility (`workspace/team/owner`) + per-team budgets; intra-workspace **authz** layered on workspace RLS (no new scope) | 03 §4/§5.2/§9, 25, 05 (matrix), 07 §5, 09 §4, 12 §3, ADR-22 |
| **H19** | AI human-in-the-loop + grounding + audit: AI reads revealed/owned + masked master only; review-before-send/persist; `ai_requests` audit; eval/safety harness | 23, 05 §16, 03 §14, 08 §10, 09 §10, 16 §11, ADR-23 |
| **H20** | Data freshness: `data_quality_score = round(100×(0.4·completeness+0.3·verification+0.3·freshness))` + per-field freshness SLAs + `freshness_status` + `verification_jobs` | 22 §2/§3, 06 §9, 03 §5.2/§14, 08 §7, 07 §5, 10 (M13), ADR-25 |
| **H21** | Automation engine: `automation_trigger`/`automation_action` enums + suppression-gated + idempotent + per-team policies + `automation_runs` | 27, 03 §14, 05 (matrix), 09 §10, 12 §3, 08 §11, ADR-26 |
| **H22** | Performance SLOs / error budgets (latency budgets, freshness SLOs, capacity, Citus cutover) | 18 §2/§8, 02 §9, 09, 19 §2, 10 (M12), ADR-24 |
| **H23** | Event backbone: transactional `outbox` + idempotent consumers + DLQ/backpressure + SSE/WebSocket; per-entity ordering | 20, 02 §3, 03 §12/§14, 09 §10, 18 §9, ADR-27 |

## 5. Shared-vocabulary index (definition → usages)

| Term | Definition | Usages |
|---|---|---|
| workspace roles (`owner/admin/member/viewer`) | 03 §4 (`workspace_members.role`) | 02 §5, 05 §1, 09 §4 |
| tenant org roles (`owner/billing_admin/security_admin/compliance_admin/member`) | 03 §4 (`tenant_members.org_role` — ADR-30; `is_tenant_owner` compat alias; membership moved off `users` by ADR-19) | 02 §5, 05 §1, 09 §4, 12 §1, 17 §4 |
| global identity + tenant membership (`users` global; `tenant_members`; `invitations`; `tenant_domains.join_policy`) | 03 §4 / ADR-19 | 02 §4/§5, 05 §1/§2, 09 §4, 12, 17 §4 |
| registration model (hybrid: verified-domain join / pending invite / new org; identifier reveals existence) | 17 §2 / ADR-20 | 03 §4, 05 §1, 09 §2, 12 §3/§4 |
| `email_status` enum | 03 §5 | 06 §9, 07 §3/§11, 09 §3 |
| `phone_status` | 03 §5 | 06 §7, 09 §3 |
| `reveal_type` (`email/phone/full_profile`) | 03 §5 (contact_reveals) | 07 §1/§3, 09 §3 |
| `outreach_status` (`new/in_sequence/replied/meeting_booked/disqualified/nurture/unsubscribed`) | 03 §5 (contacts) | 05, 09 |
| `link_type` (Sales Nav) | 03 §5 (sales_nav_links) | 05, 09 |
| `signal_type` (intent) | 03 §6 (intent_signals) | 06, 09 |
| `activity_type` + `channel` + `outcome` | 03 §7 (activities) | 05, 09 |
| outreach `status`/`platform` (sequences) | 03 §7 (outreach_log/sequences) | 05, 09, ADR-9 |
| audit actions (closed enum, incl. `credit.adjust` + auth events `login.*/mfa.*/token.*/sso.*/device.*/session.revoked/code.*/signup/oauth.link` + record/config mutations `contact.*/account.*/list.*/sequence.*/template.*/settings.update/automation.rule.*`; `audit_log.origin_domain`) | 03 §7 (audit_log) / 08 §5 | 08 §5, 07 §3/§7, 03 §8, 09 §3.2, 17 §9, 02 §6 |
| commercial policy (transparent, no-lock-in, export-on-exit) | ADR-12 / 07 §1A | 00 §7, 05 §11, 12 §4, 10 (M3) |
| charge-by-verified-result + credit-back | ADR-13 / 07 §3 | 03 §8, 05 §7, 06 §9, 09 §3.2, 10 (M4/M9) |
| trust & certification program (SOC 2/ISO/registration/Trust Center) | ADR-14 / 08 §15 | 00 §7, 10 (Trust track), 12 §4, 13 §3 |
| entity-resolution engine (Splink; **global/cross-source** ER at Layer 0 + within-workspace overlay dedup) | ADR-15 / ADR-21 / 06 §9 | 03 §5.1/§14, 10 (risk #1), 00 §7 |
| two-layer data: global master graph (Layer 0, system-owned, golden records + `source_records`/`match_links`) + per-workspace overlay (Layer 1) | ADR-21 / 03 §5.1 | 02 §3.1/§3.3/§4/§6, 06 §1/§9, 09 §2/§3, 08 §1/§4, 00 §6/§7, 10 |
| OpenSearch (global master-graph search) + Typesense (overlay search) | ADR-2 (amended by ADR-21) / 01 §1 | 02 §3.3, 03 §12, 09 §3, 10 |
| intent/technographic data sources (Bombora/G2/6sense; BuiltWith/HG Insights) | 06 §2 | 03 §6 (`intent_signals.signal_source`), 05 §9/§16, 10 (M8), ADR-8 |
| DROP data-broker deletion intake (→ DSAR fan-out) | 08 §4.4 | 08 §15, 13 §3, 10 (Trust track), ADR-14 |
| `source_name` (imports) / `data_source` (reveals) | 03 §5 | 06 §2/§8 |
| tenancy session GUCs (`app.current_tenant_id`, `app.current_workspace_id`) | 03 §9 / 02 §4 | ADR-6, ADR-10 |
| `email_blind_index` (HMAC for uniqueness over encrypted PII) | 03 §2/§5 | 08 |
| partitioned tables (`activities,audit_log,contact_reveals,intent_signals,scores,source_imports,outreach_log,provider_calls`) | 03 §12 | 01 §3, 02 |
| auth tables (`user_sessions,user_oauth_accounts,user_mfa`/`user_mfa_methods,user_mfa_recovery_codes,webauthn_credentials,trusted_devices,user_password_resets,auth_email_tokens,tenant_domains,tenant_sso_configs,tenant_auth_policies,workspace_auth_policies,scim_tokens,oauth_app_clients`) | 03 §4 | 05 §1, 09 §4, 12 §1–§5, 17, ADR-10, ADR-16 |
| auth origin + token model (dedicated `auth.truepoint.in` IdP; 60 s PKCE code → in-memory 15 min access JWT + rotating refresh cookie on auth origin; JWKS) | 17 §1/§3/§5 / ADR-16 | 09 §1/§4, 03 §4, 05 §1, 10 (M0/M2) |
| progressive identifier-first login (email/username; **existence-revealed → login/register**; domain→SSO routing) | 17 §2/§4 / ADR-17, ADR-20 | 09 §2, 03 §4, 12 §4 |
| auth policy + MFA enforcement levels (tenant/workspace, strictest-wins) | 17 §4/§7 / ADR-18 | 12 §3/§4, 03 §4 |
| stack: Hono/Bun, Aurora SLv2+RDS Proxy, Typesense, Lucia, ClickHouse, SES, Terraform/ECS | 01 §1 (canonical) | 02, 09, 10, ADR-10, ADR-2 |
| 6-destination nav (Home/Prospect/Sequences/Inbox/Reports/Settings); **Credits not a tab** | 11 §2 | 04 §3, 05, 09 |
| plan tiers (free/pro/team/enterprise) | 12 §6 | 03 (`tenants.plan`), 07 |
| staff roles (`super_admin/support/billing_ops/compliance_officer/read_only`) | 13 §2 / ADR-11 | 09 (`/admin/*`) |
| impersonation (time-boxed, banner, audited) | 13 §2 / ADR-11 | 08, 09 |
| feature flags (global + per-tenant) | 13 §3 | 05, 09 |
| privileged cross-tenant role + `platform_audit_log` | ADR-11 / 03 §9 | 02, 08, 13 |
| data-quality fields (`last_verified_at,verification_source,data_quality_score,is_duplicate_of`) + DQ tables | 03 (DQ amendment) / 06 | 11 (Data Health), 13 |
| **pending schema** (`tasks,templates,notifications,webhooks,integrations,sending_identities`; platform: `staff_users,impersonation_sessions,platform_audit_log,feature_flags,plan_templates,provider_configs,announcements,abuse_flags,system_status`) | 11/12/13 (flagged) | 03 (follow-up amendment) |
| departments/teams (`department_type`, `team_role`, `record_visibility`; `teams`/`team_members`/`team_credit_budgets`) | 03 §4/§5.2 / ADR-22 | 25, 05, 07 §5, 09 §4, 12 §3, 00 §6 |
| AI layer (`AiPort` + Claude Opus 4.8/Sonnet 4.6/Haiku 4.5; `ai_task_type`; `ai_requests`/`ai_evals`/`ai_cache`; pgvector `embeddings`) | ADR-23 / 23 / 03 §14 | 05 §16, 16 §11, 06 §9, 08 §10, 09, 01 §1, 00 §6/§8 |
| `data_quality_score` formula + `freshness_status` + freshness SLAs | 22 §2/§3 / ADR-25 / 03 §5.2/§14 | 06 §9, 03, 13 §3, 07 §5, 10 (M13), 00 §6 |
| automation (`automation_trigger`/`automation_action`; `automation_rules`/`automation_runs`) | 03 §14 / ADR-26 / 27 | 05, 09 §10, 12 §3, 08 §11, 25 §7 |
| event backbone (`outbox`; domain events; SSE/WebSocket) | 20 / ADR-27 / 03 §14 | 02 §3, 09 §10, 18 §9, 26, 27 |
| performance SLOs + error budgets + capacity (latency budgets, Citus cutover) | 18 / ADR-24 | 02 §9, 19, 09, 10 (M12), 00 §6 |
| `saved_views` / `segments` (smart segments) | 03 §5.2/§14 / 24 | 05 §8, 11 §4.2, 27 |
| record customization (`custom_field_definitions` + `custom_fields` jsonb, `pipeline_stages`→`outreach_status` map, `tags`/`record_tags`) | 03 §14 / ADR-28 | 05 §7/§21, 10 (M8), 24, 29 §6, 00 §6 |
| `credit_ledger` (M11; counter = derived cache) + `credit_leases` (M12) | ADR-29 / 07 §2 | 03 §8/§14, 05 §11, 02 §3.1, 10 (M11/M12 + risk #2), 00 §6/§7 |
| `mailbox_connections` (reply ingestion; M9 design gate) | 03 §14 | 05 §20, 10 (M9), 00 §8 Q11 |

## 6. ADR registry

| ADR | Title | Status | Context | Referenced by |
|---|---|---|---|---|
| ADR-1 | Drizzle ORM | Accepted | 01, 03 | 00, 01, 03 |
| ADR-2 | Typesense search from day one | Accepted (amended; global index → OpenSearch by ADR-21) | 01, 03 | 00, 01, 03 §12, 10, ADR-21 |
| ADR-3 | Three-layer data model | **Superseded by ADR-6; revived (hybrid) by ADR-21** | 03, 08 | (historical; revived as Layer 0 by ADR-21) |
| ADR-4 | Append-only credit ledger | **Superseded by ADR-7** | 07, 03 | (historical; revival path) |
| ADR-5 | Global shared contact DB | **Superseded by ADR-6; revived (hybrid) by ADR-21** | 02, 03 | (historical; revived as Layer 0 by ADR-21) |
| ADR-6 | Per-workspace multi-tenant model | Accepted (user scoping amended by ADR-19; no-global-golden reopened by ADR-21) | 02, 03 | 00, 02 §4, 03, 05, 08, ADR-19, ADR-21 |
| ADR-7 | Per-workspace reveal + credit counter | Accepted (amended by ADR-0029 — ledger M11 + leases M12) | 07, 03 | 00, 07, 03 §8, ADR-29 |
| ADR-8 | Lead-scoring / intelligence model | Accepted | 03, 06 | 00, 05 §16, 06, 11 |
| ADR-9 | Outreach engine (enroll & send) | Accepted | 05, 09, 08 | 00, 05, 08, 09, 11 |
| ADR-10 | AWS-native self-hosted stack (build auth) | Accepted (auth transport amended by ADR-16) | 01, 02 | 00, 01, 02, 09, 10, 13, 17, ADR-16 |
| ADR-11 | Platform-admin console & privileged access | Accepted | 13, 02, 03 | 00, 13, 02, 08, 09 |
| ADR-12 | Transparent no-lock-in commercial policy | Accepted | 07, 00 | 00, 05, 07, 12, 15 |
| ADR-13 | Charge-for-verified-data + credit-back | Accepted | 07, 06, 03 | 00, 03, 05, 06, 07, 09, 10, 15 |
| ADR-14 | Trust & certification program | Accepted | 08, 10 | 00, 08, 10, 12, 13, 15 |
| ADR-15 | Entity resolution / dedup engine (Splink) | Accepted (made global/cross-source by ADR-21) | 03, 06 | 00, 03, 06, 10, ADR-21 |
| ADR-16 | Dedicated auth origin + cross-domain token exchange | Accepted | 17, 09, 01 | 00, 03, 05, 09, 10, 12, 17, README (amends ADR-10) |
| ADR-17 | Progressive identifier-first login + domain tenant routing | Accepted (no-enumeration amended by ADR-20) | 17, 03, 12 | 00, 05, 09, 10, 12, 17, README, ADR-20 |
| ADR-18 | Auth policy + MFA enforcement model | Accepted | 17, 12, 03 | 00, 05, 10, 12, 17, README |
| ADR-19 | Global identity + tenant membership | Accepted (org-role capability amended by ADR-0030) | 17, 03 | 00, 02, 03, 05, 09, 12, 17, README (amends ADR-6 user scoping) |
| ADR-20 | Existence-revealing identifier-first + registration | Accepted | 17, 03, 12 | 00, 03, 05, 09, 17, README (amends ADR-17 no-enumeration) |
| ADR-21 | Global master graph + per-workspace overlay (two-layer) | Accepted | 02, 03, 06, 08 | 00, 02, 03, 06, 08, 09, 10, README (reopens ADR-6; revives ADR-3/5; amends ADR-2/15) |
| ADR-22 | Departments/teams as intra-workspace segmentation | Accepted (additive to ADR-6/19) | 25, 03 | 00, 03, 05, 07, 09, 12, 25, README |
| ADR-23 | AI provider & intelligence architecture (Anthropic Claude) | Accepted (resolves 00 §8 Q8) | 23, 05 | 00, 01, 05, 06, 08, 09, 16, 23, README |
| ADR-24 | Performance SLOs, capacity & scale-hardening | Accepted | 18, 02 | 00, 02, 09, 10, 18, 19, README |
| ADR-25 | Data freshness, decay & re-verification lifecycle | Accepted | 22, 06 | 00, 03, 06, 07, 08, 10, 22, README |
| ADR-26 | Workflow automation engine | Accepted | 27, 05 | 00, 03, 05, 09, 12, 27, README |
| ADR-27 | Real-time delivery & event backbone | Accepted | 20, 02 | 00, 02, 03, 09, 18, 20, 26, 27, README |
| ADR-28 | Record customization layer (custom fields, stages, tags) | Accepted | 05, 03 | 00, 03 §14, 05 §7/§21, 10 (M8), 24, 28, 29, README |
| ADR-29 | Credit ledger reintroduction & lease-based decrement | Accepted (amends ADR-7) | 07, 03 | 00, 02 §3.1, 03 §8/§14, 05 §11, 07 §2/§8/§11, 10 (M11/M12 + risk #2), 28, README |
| ADR-30 | Granular tenant org roles | Accepted (amends ADR-19) | 03, 17 | 00, 02 §5, 03 §4, 05 §1, 08 §16, 09 §4, 12 §1, 17 §4, 10 (M11), 28, 29, README |

**ADR rules:** new significant decision → new ADR + 00 §7 row + lead-doc edit (tripod). Superseding a
locked ADR → set old `Status: Superseded by ADR-NNNN` + reciprocal link, never overwrite the body.
Keep "Supersedes/Superseded by" pointers symmetric.

## 7. Conventions pointer
All edits follow `../conventions.md`. New docs use `../templates/planning-doc-template.md`; new ADRs use `../templates/adr-template.md`.
