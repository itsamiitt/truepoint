# 00 — Product Overview (Phase 1: Application Understanding)

> Part of the **LeadWolf Market Gap Analysis & PMF Audit**. Research date: **2026-06-01**.
> See the [README](README.md) for the index, method, and assumptions. This document is the *evidence
> base* for everything downstream — it is grounded entirely in the `docs/planning/` corpus, not the market.

---

## At a glance

| Dimension | Detail |
|---|---|
| **Name** | LeadWolf (working repo: *DuskWolf*) |
| **Tagline** | "Hunt your best leads." |
| **Category** | Sales intelligence + prospecting CRM (per-workspace, multi-tenant) — B2B lead-gen / SDR enablement / RevOps |
| **One-line** | An end-to-end prospecting CRM where each team owns its own contact data, reveals verified email/phone with credits, scores prospects, and runs compliant outreach — in one app. |
| **Stage** | **Pre-launch, design only.** No application code exists; the product is the planning-doc corpus. |
| **Monetization** | Per-reveal **credits** + Free / Pro / Team / Enterprise subscription tiers (all pricing placeholder) |
| **Build target** | AWS-native, self-hosted (Hono/Bun, Next.js 15, Aurora Postgres, Typesense, SES) |

---

## 1. Core purpose — the problem it solves

Sales teams waste time on **stale, incomplete contact data scattered across a stitched-together stack** of
tools (a data vendor + an enrichment tool + a sequencer + a CRM + a compliance spreadsheet). LeadWolf collapses
that stack into a single workspace where a team **imports and enriches** contacts, **reveals** verified
email/phone on demand, **scores** prospects, and **sequences and sends** outreach — with **compliance built
into the core** so every reveal and send is gated by suppression/consent.

**The core loop:**

```
Import / enrich → dedup (within workspace) → verify email/phone → search a masked list
→ REVEAL (spend tenant credit) → score → sequence + send   (every reveal & send passes a suppression check; every action audited)
```

## 2. Target audience & personas

| Persona | Goal | Key workflows |
|---|---|---|
| **SDR / AE** (primary user) | Find & reach the right prospects fast | Search → filter → reveal → list/sequence → export/CRM |
| **Sales / RevOps manager** | Manage seats, credits, data hygiene | Tenant/workspace admin, credit allocation, usage reporting, suppression |
| **Data / compliance officer** (buyer-side) | Ensure lawful use | Review DSAR handling, suppression, audit trail |
| **Developer** (customer) | Integrate data into their stack | Public REST API (post-MVP), CSV/CRM sync |

**Segment:** SMB-to-mid-market B2B sales/RevOps teams that want clean data and a complete workflow in one
place, plus compliance-sensitive buyers (especially EU) for whom GDPR/consent handling is a purchase gate.

## 3. Major features & modules

**MVP (milestones M1–M5):**

- **Auth & tenancy** — self-built (Lucia); email/password + OAuth; MFA; SAML/OIDC seam; self-serve signup.
- **Workspaces** — create/switch; hard RLS isolation; per-workspace roles (owner/admin/member/viewer).
- **Import** — CSV/XLSX + manual + enrichment providers (Apollo/ZoomInfo/Clearbit); per-import provenance.
- **Search & results** — faceted search over a **masked** contact/account list; saved searches & lists.
- **Reveal** — spend tenant credits to reveal email / phone / full profile; idempotent, **first-reveal-wins
  per workspace** (re-reveal of the same copy is free; same person in another workspace is charged again).
- **Credits & billing** — tenant credit counter; Stripe credit-pack top-ups; usage history.
- **Export** — CSV of revealed records only; passes suppression; audit-logged.
- **Lead scoring** — versioned scores (ICP fit / intent / engagement → composite 0–100) + intent signals.
- **Compliance** — suppression/DNC gating, consent records, DSAR (access/delete/rectify), append-only audit.

**Post-MVP roadmap (M7–M11):**

- **Sales Navigator** capture (human-in-the-loop) · **Activity timeline** & **Reports/analytics** ·
  **Outreach sequencing + send engine** (email via SES; AI drafting; inbox/tasks) · **CRM sync**
  (HubSpot/Salesforce/Pipedrive) · **Public REST API + webhooks** · **AI** (NL search, draft assist) ·
  **Enterprise** (SSO/SCIM, IP allowlist, data residency, audit-log export) · separate **platform admin** console.

## 4. Unique capabilities / claimed differentiators

1. **End-to-end in one app** — find → reveal → score → sequence → send, without stitching five tools together.
2. **Compliance as a feature** — GDPR/CCPA/DNC suppression is **unbypassable** (enforced *inside* the reveal
   and send DB transactions), with consent records, DSAR fan-out across copies, and an append-only audit log.
3. **Per-workspace data ownership** — each workspace owns its **own** contact copies (no shared golden record);
   separate ICPs/notes/scores/outreach state per team/brand/client, isolated at the database layer (RLS).
4. **Verified-on-reveal** — email/phone verification happens at reveal time, with per-import provenance shown.

## 5. Current value proposition

> "The intelligent prospecting CRM — find the right people, reveal verified contact details, score them, and
> engage them, as a coordinated pack." Positioned **against bloated legacy data vendors and stitched-together
> tool stacks**: own your data, pay only when you reveal, and stay compliant by default.

## 6. Information architecture (the product surface)

A single-page command center with **6 destinations** (left rail): **Home** (cockpit), **Prospect** (unified
search + contacts + accounts + lists), **Sequences**, **Inbox**, **Reports**, **Settings** — plus a top-bar
**credit-balance pill** (deep-links to billing; not a tab). Everything else is a **panel/drawer** (record
detail, reveal confirmation, import wizard, sequence builder, score breakdown), never a separate page.
Design language: clean light monochrome + one indigo accent, keyboard-first.

## 7. Architecture & business model (summary)

- **Tenancy:** `tenant → workspace → workspace_member → user`. Credits are a **tenant-level pool**; data and
  isolation are **per workspace**. Tenant-owner capability (billing/SSO/API keys) is orthogonal to workspace role.
- **Stack:** AWS-native self-hosted — Hono on Bun (API), Next.js 15/React 19 (web), Aurora Serverless v2
  Postgres with **RLS** multi-tenancy, Typesense search (CDC-fed), Redis/BullMQ workers, Drizzle ORM, SES email,
  KMS-encrypted PII masked until reveal. Designed for 100M+ rows.
- **Revenue:** consumption (credits per reveal) layered with subscription entitlements (seats/workspaces/feature
  gates). Enrichment is treated as a *system cost*, never billed directly; users pay only on reveal.

## 8. What is NOT yet decided (gaps in our own evidence)

- **Final pricing** — reveal cost per type, credit-pack sizes/prices, signup bonus, and tier prices are all
  placeholders. Competitiveness on price (see [Product-Market Fit](04-product-market-fit.md)) is therefore
  assessed structurally, against competitor bands.
- **No measured PMF inputs** — zero users, revenue, retention, conversion, or NPS data exist. All fit
  judgements in this report are **projected** from the plan, not observed.

---

*Sources for this document: the LeadWolf planning corpus under `docs/planning/` (overview, brand identity,
features/modules, information architecture, billing & credits, roadmap, settings, platform admin, and the
ADR decision log). No external/market sources are used here — those appear from [01 Market Research](01-market-research.md) onward.*
