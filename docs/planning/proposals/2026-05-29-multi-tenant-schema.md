# PROPOSAL (incoming) — Sales intelligence database schema, multi-tenant edition

> **Status: ADOPTED (2026-05-29).** Reconciled into the corpus — see
> [ADR-0006](../decisions/ADR-0006-per-workspace-multitenant-model.md) (tenancy/data model, supersedes
> ADR-0003/0005), [ADR-0007](../decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md)
> (reveal/credits, supersedes ADR-0004), [ADR-0008](../decisions/ADR-0008-lead-scoring-model.md)
> (scoring), [ADR-0009](../decisions/ADR-0009-outreach-engine-enroll-and-send.md) (outreach send), and
> the rewritten [03-database-design.md](../03-database-design.md). Kept as the verbatim source of the
> proposal for provenance. It introduced a **workspace** layer, **per-workspace contact copies**,
> **Sales Navigator integration**, **reveal-ownership tracking**, and an **intelligence + activity** layer.

## Summary of what it introduces / changes vs the current plan

- New **tenancy model**: `tenant → workspace → workspace_member → user` (workspaces are new; today the
  plan has org + users + RBAC only).
- **Per-workspace data isolation**: every data/intelligence/activity row carries BOTH `tenant_id` and
  `workspace_id`. Contacts/accounts are **NOT shared** across workspaces (each workspace owns its own
  copy) — this directly contradicts ADR-0005 (global shared contact DB).
- Entities renamed: `tenants` (was `organizations`), `contacts` (was `persons`), `accounts` (was
  `companies`).
- **Reveal ownership**: first reveal wins ownership (`contacts.revealed_by_user_id`), full history in
  `contact_reveals`; credits tracked at **tenant** level (`tenants.reveal_credit_balance`,
  `contact_reveals.credits_consumed`). Differs from ADR-0004's `reveal_key=hash(org,person)` +
  free-re-reveal model.
- **Source provenance** via `source_imports` (raw_data jsonb per import) — simpler than ADR-0003's
  immutable `raw_records` + per-field `field_provenance` + golden-record model.
- New layers: **Sales Navigator** (`sales_nav_links` + SN fields on contacts/accounts), **intelligence**
  (`scores`, `intent_signals`), **activity** (`activities`, `outreach_log`, `audit_log`).
- RLS via `SET LOCAL app.current_workspace_id`; triggers for reveal-ownership, score sync, updated_at.

---

## Table-by-table (columns, types, key constraints)

### Tenancy layer

**tenants** — top-level paying customer.
`id uuid PK · name · slug unique · plan(free/starter/growth/enterprise) · seat_limit int · workspace_limit int(null=unlimited) · reveal_credit_balance int · status(active/suspended/churned) · created_at · updated_at`

**workspaces** — collaboration scope; all contacts/activities/reveals live inside one workspace.
`id PK · tenant_id FK · name · slug (unique within tenant) · is_default bool · created_by_user_id FK→users · settings jsonb · created_at · updated_at`. Partial unique: one default workspace per tenant.

**users** — `id PK · tenant_id FK · email (unique per tenant) · full_name · avatar_url · password_hash(null if SSO) · auth_provider(password/google/microsoft/saml) · last_login_at · status(active/invited/suspended) · created_at · updated_at`.

**workspace_members** — join user↔workspace with role per workspace.
`id PK · workspace_id FK · user_id FK · role(owner/admin/member/viewer) · invited_by_user_id FK · invited_at · joined_at · status(active/invited/removed)`. Unique (workspace_id,user_id). Check: (status='active')=(joined_at IS NOT NULL).

### Data layer

**accounts** — company records, scoped to a workspace (separate per workspace even for the same company).
`id PK · tenant_id FK(denormalized for RLS) · workspace_id FK · name · domain · linkedin_company_url · sales_nav_account_url · industry · sub_industry · employee_count int · revenue_range · hq_country · hq_city · icp_fit_score int(0-100) · created_at · updated_at`. Unique (workspace_id, domain) where domain not null.

**contacts** — one row per unique person within a workspace.
`id PK · tenant_id FK · workspace_id FK · account_id FK(SET NULL) · first_name · last_name · email · email_verified bool · linkedin_url · linkedin_public_id · sales_nav_profile_url · sales_nav_lead_id · job_title · seniority_level(c_suite/vp/director/manager/ic/other) · department · phone · phone_type(direct/mobile/hq/unknown) · location_country · location_city · priority_score int(0-100) · outreach_status(new/in_sequence/replied/meeting_booked/disqualified/nurture/unsubscribed) · is_revealed bool · revealed_by_user_id FK(denormalized) · revealed_at(denormalized) · last_activity_at · created_at · updated_at`.
Unique: (workspace_id,email), (workspace_id,linkedin_public_id), (workspace_id,sales_nav_lead_id) — all where-not-null. Checks: is_revealed=(revealed_by_user_id IS NOT NULL); is_revealed=(revealed_at IS NOT NULL).

**contact_reveals** — every reveal event; first per (workspace,contact) is canonical ownership.
`id PK · tenant_id FK · workspace_id FK · contact_id FK · revealed_by_user_id FK · reveal_type(email/phone/full_profile) · data_source(apollo/zoominfo/linkedin/internal) · credits_consumed int(default 1,>=0) · revealed_fields jsonb · revealed_at`.

**sales_nav_links** — SN artifacts (saved searches, lead lists, account lists, inmail threads).
`id PK · tenant_id FK · workspace_id FK · contact_id FK(opt) · account_id FK(opt) · link_type(profile/account/saved_search/lead_list/account_list/inmail_thread) · url text · title · notes · created_by_user_id FK · last_synced_at · created_at · updated_at`. Check ties link_type to contact_id/account_id presence.

**source_imports** — every import event per contact; raw source data for provenance/re-enrichment.
`id PK · tenant_id FK · workspace_id FK · contact_id FK · imported_by_user_id FK · source_name(apollo/zoominfo/linkedin/sales_navigator/hubspot/salesforce/clearbit/manual) · source_file · raw_data jsonb · imported_at`.

### Intelligence layer

**scores** — versioned scoring history (each re-score = new row).
`id PK · tenant_id FK · workspace_id FK · contact_id FK · icp_fit int(0-100) · intent_score int(0-100) · engagement_score int(0-100) · composite_score int(0-100) · score_breakdown jsonb · scored_at`.

**intent_signals** — signals feeding intent score (workspace-scoped).
`id PK · tenant_id FK · workspace_id FK · contact_id FK · signal_type · signal_source · detail text · weight int(1-10) · detected_at`.

### Activity layer

**activities** — per-user, per-workspace engagement history.
`id PK · tenant_id FK · workspace_id FK · contact_id FK · performed_by_user_id FK · activity_type · channel(email/phone/linkedin/sales_navigator/in-person) · subject · body text · outcome(no_reply/bounced/positive_reply/meeting_booked/unsubscribed) · metadata jsonb · occurred_at · created_at`.

**outreach_log** — campaign membership per contact.
`id PK · tenant_id FK · workspace_id FK · contact_id FK · enrolled_by_user_id FK · campaign_name · platform(klaviyo/apollo/salesloft/outreach/linkedin/manual) · external_campaign_id · status(enrolled/active/replied/completed/unsubscribed/bounced) · enrolled_at · sent_at · replied_at`.

**audit_log** — system-wide audit trail (login, reveal, create/update, invite, role change).
`id PK · tenant_id FK · workspace_id FK(null for tenant-level) · actor_user_id FK(null for system) · action · entity_type · entity_id uuid · metadata jsonb · ip_address inet · user_agent · occurred_at`.

---

## Indexes (highlights)
Tenancy: users(tenant_id), workspaces(tenant_id), workspace_members(user_id), workspace_members(workspace_id).
Data: accounts(workspace_id), contacts(workspace_id), contacts(workspace_id,account_id), contacts(workspace_id,priority_score DESC), contacts(workspace_id,outreach_status), contacts(workspace_id,revealed_by_user_id), contacts(workspace_id,last_activity_at DESC). contact_reveals(workspace_id,contact_id), (revealed_by_user_id,revealed_at DESC), (tenant_id,revealed_at DESC). sales_nav_links(workspace_id|contact_id|account_id). source_imports(workspace_id,contact_id).
Intelligence: scores(contact_id,scored_at DESC), intent_signals(contact_id,detected_at DESC).
Activity: activities(workspace_id,occurred_at DESC), (contact_id,occurred_at DESC), (performed_by_user_id,occurred_at DESC). outreach_log(workspace_id,contact_id), (workspace_id,campaign_name). audit_log(tenant_id,occurred_at DESC), (workspace_id,occurred_at DESC), (actor_user_id,occurred_at DESC).

## Row-level security
Enable RLS on contacts, accounts, contact_reveals, sales_nav_links, source_imports, scores, intent_signals, activities, outreach_log. Policy on each: `USING (workspace_id = current_setting('app.current_workspace_id')::uuid)`. App sets `SET LOCAL app.current_workspace_id = '<uuid>'` per request.

## Triggers
1. **First reveal wins ownership**: AFTER INSERT ON contact_reveals → UPDATE contacts SET is_revealed=TRUE, revealed_by_user_id, revealed_at WHERE id=contact_id AND is_revealed=FALSE (idempotent; only first sets ownership).
2. **Sync priority_score**: AFTER INSERT ON scores → UPDATE contacts.priority_score = NEW.composite_score.
3. **updated_at maintenance**: BEFORE UPDATE on tenants/users/workspaces/accounts/contacts/sales_nav_links.

## Default workspace provisioning
`provision_new_signup(...)` function: creates tenant → user → workspace('My workspace', is_default=true) → workspace_member(owner, active) → audit_log(workspace.created), returns (tenant_id,user_id,workspace_id). Invited users: only users + workspace_members rows.

## Enum reference
- roles: owner(full+billing+delete), admin(invite+settings+data), member(create/edit/reveal/outreach), viewer(read-only).
- outreach_status: new, in_sequence, replied, meeting_booked, disqualified, nurture, unsubscribed.
- reveal_type: email, phone, full_profile.
- link_type: profile, account, saved_search, lead_list, account_list, inmail_thread.
- signal_type: job_change, new_hire, funding_round, tech_install, web_visit, content_engagement, keyword_search, linkedin_activity, sales_nav_view.
- activity_type: email_sent, email_opened, email_clicked, email_replied, call_made, call_connected, linkedin_message, linkedin_connected, sales_nav_inmail, meeting_held, note_added.
- audit actions: user.logged_in, user.invited, user.removed, workspace.created, workspace.deleted, member.role_changed, contact.created, contact.updated, contact.revealed, contact.deleted, account.created, sales_nav.link_added, import.started, import.completed, outreach.enrolled, outreach.completed.

## Design notes (author's rationale)
- **tenant_id denormalized everywhere**: simpler RLS, billing without joins, per-tenant export.
- **Workspaces don't share contacts**: each workspace owns its own copy even for the same company —
  different ICPs/notes/states; cross-workspace visibility should be a read-only "tenant search" feature
  on top, NOT shared rows. *(Directly opposes ADR-0005's global shared contact DB.)*
- **Reveal ownership = first revealer**; later viewers see data but ownership stays pinned; full history
  in contact_reveals.
- **Credits at tenant level** (billing concept), spendable across workspaces.
- **Both contacts.revealed_by_user_id and contact_reveals**: denormalized column for fast lists; table
  for full history; trigger keeps them in sync (first insert only).
- **audit_log separate from activities**: activities = sales actions (team-visible timeline);
  audit_log = system actions (compliance/admin).
- **SN URLs on both contacts and sales_nav_links**: profile URL on contacts for fast access; the table
  for everything else.
- **Deletes cascade workspace→down**; tenant deletion cascades all the way; soft-delete optional on top.
