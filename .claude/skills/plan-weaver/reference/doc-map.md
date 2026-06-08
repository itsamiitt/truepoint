# LeadWolf Planning — Wiring Map

> The source of truth for **what is connected to what** in `docs/planning/`. `plan-weaver` reads this
> before any change to compute the impact set. If the live docs have structurally drifted from this
> map, trust the live docs and update this file as part of the change.
>
> **Model (since 2026-05-29):** per-workspace multi-tenant CRM ([ADR-0006]) on an AWS-native
> self-hosted stack ([ADR-0010]). The earlier global-golden-DB / three-layer / ledger design is
> superseded — see the ADR registry (§6).
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
| (input) | `docs/planning/proposals/2026-05-29-multi-tenant-schema.md` (adopted) |

## 2. Adjacency list (doc → docs/ADRs it references)

`03` is the **hub**. `01`/`ADR-10` (stack) and `ADR-6` (tenancy/data model) are the other high-blast-radius nodes.

| Doc | References |
|---|---|
| README | 00–16, brand, decisions/ |
| 00 | 01, ADR-1..11, 04, 05, 06, 07, 08, 10, 11, 12, 13, 14, 16 (decision log §7 + open Qs §8) |
| 01 | 03, 04, 10, ADR-1, ADR-2, ADR-10 |
| 02 | 01, 03, 06, 08, 16, ADR-6, ADR-10 |
| 03 | 06, 07, 08, ADR-1, ADR-2, ADR-6, ADR-7, ADR-8, ADR-9, ADR-10 |
| 04 | (self-contained; others reference it for design tokens) + workspace switcher → 02/05 |
| 05 | 03, 04, 06, 07, 08, 09, 10, ADR-6, ADR-8, ADR-9 |
| 06 | 03, 07, 08, ADR-8 |
| 07 | 03, 06, 08, 09, ADR-7 |
| 08 | 03, 06, 07, 09, ADR-6, ADR-9 |
| 09 | 03, 07, 08, ADR-10 |
| 10 | 01, 03, 05, 06, 07, 08, 09, ADR-2, ADR-6, ADR-7, ADR-8, ADR-9, ADR-10 (risk register) |
| ADR-6 | 02, 03 (supersedes ADR-3, ADR-5) |
| ADR-7 | 07, 03 (supersedes ADR-4) |
| ADR-8 | 03, 06 |
| ADR-9 | 05, 09, 08 |
| ADR-10 | 01, 02 |
| ADR-11 | 13, 02, 03 |
| ADR-12 | 07, 00 |
| ADR-13 | 07, 06, 03 |
| ADR-14 | 08, 10 |
| ADR-15 | 03, 06 |
| 11 | 02, 04, 05, 06, 07, 08, 09, 10, 12, 13, ADR-2, ADR-6, ADR-8, ADR-9, ADR-10 |
| 12 | 03, 07, 08, 09, 11, ADR-6 |
| 13 | 01, 02, 03, 06, 08, 09, 10, ADR-10, ADR-11 |
| 14 | 01, 02, 03, 04, 05, 07, 08, 10, 16, brand, ADR-2, ADR-6, ADR-7, ADR-10 |
| 15 | 00, 03, 05, 06, 07, 08, 09, 10, 12, 13, ADR-12, ADR-13, ADR-14 (gap-remediation overlay; links out to ../market-analysis/) |
| 16 | 00, 01, 02, 11, 13, 14, ADR-2, ADR-6, ADR-10, ADR-11 (engineering-conventions overlay; details 02 §1 on-disk layout) |
| brand | 04, 08, 11 |

**Bidirectional pairs:** 00↔ADRs; 03↔ADR-6/7/8/9/10; 05↔10 (matrix↔roadmap); 07↔08↔09 (reveal+send path); 11↔04 (IA↔nav); 11↔12↔13 (app surface); 13↔ADR-11; 10↔14 (roadmap↔execution); 02↔16, 14↔16 (architecture↔code-organization); 04↔brand (design↔brand); 07↔ADR-12/13, 08↔ADR-14, 06↔ADR-13, 03↔ADR-13 (remediation decisions); 10↔15, 05↔15 (gap remediation); 03↔ADR-15, 06↔ADR-15 (entity resolution); superseded↔superseding (ADR-3/5↔ADR-6, ADR-4↔ADR-7).

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

## 4. Critical drift hazards (H1–H10) — "edit these together"

| ID | Concept | Locations that must stay consistent |
|---|---|---|
| **H1** | Reveal transaction (suppression-gated; tenant-counter charge; per-workspace first-reveal) | 03 §8/§10, 07 §3, 08 §3, 09 §3 |
| **H2** | Credit accounting (`tenants.reveal_credit_balance` counter, `CHECK>=0`, FOR UPDATE; reveal idempotency via unique `(workspace_id,contact_id,reveal_type)`) | 03 §8/§11, 07 §1/§2/§3, ADR-7, 10 (M3 DoD) |
| **H3** | `source_imports` is the provenance model (no field-level lineage/golden) | 03 §5, 06, 08 §4, ADR-6 |
| **H4** | Per-workspace dedup keys (email_blind_index / linkedin_public_id / sales_nav_lead_id) | 03 §5/§11, 06 (import) |
| **H5** | Suppression — gates reveal **and** send; scopes global/tenant/workspace | 03 §8, 08 §3, ADR-9 |
| **H6** | DSAR delete fan-out across per-workspace copies + source_imports + contact_reveals + activities | 08 §4, 03 §5 |
| **H7** | `email_status` enum (`unverified,valid,risky,invalid,catch_all,unknown`) | 03 §5, 06 §9, 07 §3/§11, 09 §3 |
| **H8** | Roles: workspace roles on `workspace_members` + a distinct tenant-level owner/billing capability | 03 §4, 02 §5, 05 §1, 09 §4 |
| **H9** | RLS via `SET LOCAL app.current_workspace_id` + `app.current_tenant_id` (non-BYPASSRLS role, RDS Proxy GUC reset) | 03 §9, 02 §4, ADR-6, ADR-10 |
| **H10** | Milestone assignment of a feature | 05 (matrix) + 10 (M0–M… detail) |
| **H11** | Navigation model (6 destinations; **Credits not a tab**) | 04 §3 == 11 §2; 05 modules; 09 resources |
| **H12** | Platform privileged access (RLS-bypass role + `platform_audit_log` + impersonation) | 13, ADR-11, 03 §9, 08 |
| **H13** | Charge-by-verified-result + credit-back (charge set by `email_status`; bounce → `credit.adjust`) | 07 §3, 09 §3.2, 06 §9, 03 §8, 05 §7, 10 (M4/M9 DoD), 08 §5 (audit action), ADR-13 |

## 5. Shared-vocabulary index (definition → usages)

| Term | Definition | Usages |
|---|---|---|
| workspace roles (`owner/admin/member/viewer`) | 03 §4 (`workspace_members.role`) | 02 §5, 05 §1, 09 §4 |
| tenant-level owner/billing capability | 03 §4 (`users.is_tenant_owner`) | 02 §5, 05 §1 |
| `email_status` enum | 03 §5 | 06 §9, 07 §3/§11, 09 §3 |
| `phone_status` | 03 §5 | 06 §7, 09 §3 |
| `reveal_type` (`email/phone/full_profile`) | 03 §5 (contact_reveals) | 07 §1/§3, 09 §3 |
| `outreach_status` (`new/in_sequence/replied/meeting_booked/disqualified/nurture/unsubscribed`) | 03 §5 (contacts) | 05, 09 |
| `link_type` (Sales Nav) | 03 §5 (sales_nav_links) | 05, 09 |
| `signal_type` (intent) | 03 §6 (intent_signals) | 06, 09 |
| `activity_type` + `channel` + `outcome` | 03 §7 (activities) | 05, 09 |
| outreach `status`/`platform` (sequences) | 03 §7 (outreach_log/sequences) | 05, 09, ADR-9 |
| audit actions (closed enum, incl. `credit.adjust`) | 03 §7 (audit_log) / 08 §5 | 08 §5, 07 §3/§7, 03 §8, 09 §3.2 |
| commercial policy (transparent, no-lock-in, export-on-exit) | ADR-12 / 07 §1A | 00 §7, 05 §11, 12 §4, 10 (M3) |
| charge-by-verified-result + credit-back | ADR-13 / 07 §3 | 03 §8, 05 §7, 06 §9, 09 §3.2, 10 (M4/M9) |
| trust & certification program (SOC 2/ISO/registration/Trust Center) | ADR-14 / 08 §15 | 00 §7, 10 (Trust track), 12 §4, 13 §3 |
| entity-resolution engine (Splink; within-workspace fuzzy dedup) | ADR-15 / 06 §9 | 03 §14, 10 (risk #1), 00 §7 |
| intent/technographic data sources (Bombora/G2/6sense; BuiltWith/HG Insights) | 06 §2 | 03 §6 (`intent_signals.signal_source`), 05 §9/§16, 10 (M8), ADR-8 |
| DROP data-broker deletion intake (→ DSAR fan-out) | 08 §4.4 | 08 §15, 13 §3, 10 (Trust track), ADR-14 |
| `source_name` (imports) / `data_source` (reveals) | 03 §5 | 06 §2/§8 |
| tenancy session GUCs (`app.current_tenant_id`, `app.current_workspace_id`) | 03 §9 / 02 §4 | ADR-6, ADR-10 |
| `email_blind_index` (HMAC for uniqueness over encrypted PII) | 03 §2/§5 | 08 |
| partitioned tables (`activities,audit_log,contact_reveals,intent_signals,scores,source_imports,outreach_log,provider_calls`) | 03 §12 | 01 §3, 02 |
| auth tables (`user_sessions,user_oauth_accounts,user_mfa,user_password_resets,tenant_sso_configs`) | 03 §4 | 05 §1, 09 §4, ADR-10 |
| stack: Hono/Bun, Aurora SLv2+RDS Proxy, Typesense, Lucia, ClickHouse, SES, Terraform/ECS | 01 §1 (canonical) | 02, 09, 10, ADR-10, ADR-2 |
| 6-destination nav (Home/Prospect/Sequences/Inbox/Reports/Settings); **Credits not a tab** | 11 §2 | 04 §3, 05, 09 |
| plan tiers (free/pro/team/enterprise) | 12 §6 | 03 (`tenants.plan`), 07 |
| staff roles (`super_admin/support/billing_ops/compliance_officer/read_only`) | 13 §2 / ADR-11 | 09 (`/admin/*`) |
| impersonation (time-boxed, banner, audited) | 13 §2 / ADR-11 | 08, 09 |
| feature flags (global + per-tenant) | 13 §3 | 05, 09 |
| privileged cross-tenant role + `platform_audit_log` | ADR-11 / 03 §9 | 02, 08, 13 |
| data-quality fields (`last_verified_at,verification_source,data_quality_score,is_duplicate_of`) + DQ tables | 03 (DQ amendment) / 06 | 11 (Data Health), 13 |
| **pending schema** (`tasks,templates,notifications,webhooks,integrations,sending_identities`; platform: `staff_users,impersonation_sessions,platform_audit_log,feature_flags,plan_templates,provider_configs,announcements,abuse_flags,system_status`) | 11/12/13 (flagged) | 03 (follow-up amendment) |

## 6. ADR registry

| ADR | Title | Status | Context | Referenced by |
|---|---|---|---|---|
| ADR-1 | Drizzle ORM | Accepted | 01, 03 | 00, 01, 03 |
| ADR-2 | Typesense search from day one | Accepted (amended) | 01, 03 | 00, 01, 03 §12, 10 |
| ADR-3 | Three-layer data model | **Superseded by ADR-6** | 03, 08 | (historical) |
| ADR-4 | Append-only credit ledger | **Superseded by ADR-7** | 07, 03 | (historical; revival path) |
| ADR-5 | Global shared contact DB | **Superseded by ADR-6** | 02, 03 | (historical) |
| ADR-6 | Per-workspace multi-tenant model | Accepted | 02, 03 | 00, 02 §4, 03, 05, 08 |
| ADR-7 | Per-workspace reveal + credit counter | Accepted | 07, 03 | 00, 07, 03 §8 |
| ADR-8 | Lead-scoring / intelligence model | Accepted | 03, 06 | 00, 05 §16, 06, 11 |
| ADR-9 | Outreach engine (enroll & send) | Accepted | 05, 09, 08 | 00, 05, 08, 09, 11 |
| ADR-10 | AWS-native self-hosted stack (build auth) | Accepted | 01, 02 | 00, 01, 02, 09, 10, 13 |
| ADR-11 | Platform-admin console & privileged access | Accepted | 13, 02, 03 | 00, 13, 02, 08, 09 |
| ADR-12 | Transparent no-lock-in commercial policy | Accepted | 07, 00 | 00, 05, 07, 12, 15 |
| ADR-13 | Charge-for-verified-data + credit-back | Accepted | 07, 06, 03 | 00, 03, 05, 06, 07, 09, 10, 15 |
| ADR-14 | Trust & certification program | Accepted | 08, 10 | 00, 08, 10, 12, 13, 15 |
| ADR-15 | Entity resolution / dedup engine (Splink) | Accepted | 03, 06 | 00, 03, 06, 10 |

**ADR rules:** new significant decision → new ADR + 00 §7 row + lead-doc edit (tripod). Superseding a
locked ADR → set old `Status: Superseded by ADR-NNNN` + reciprocal link, never overwrite the body.
Keep "Supersedes/Superseded by" pointers symmetric.

## 7. Conventions pointer
All edits follow `../conventions.md`. New docs use `../templates/planning-doc-template.md`; new ADRs use `../templates/adr-template.md`.
