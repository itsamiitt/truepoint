# TruePoint Browser Extension — Architecture Program

> **Status:** 🔶 Design series (documentation-first) · **Type:** Program index
> · **Owner:** Data-Platform / Frontend-Architecture · **Depends on:** the shipped ingestion seam
> ([`prospect-database-platform/06`](../prospect-database-platform/06-Chrome-Extension-Capture.md))

This series designs TruePoint's **browser extension** — the in-page capture channel that lets a
signed-in user grab a prospect/company from LinkedIn (and other supported sites) and push it into the
platform. It is written as a competitor teardown **plus** an enterprise design document: first we
reverse-engineer the installed **Apollo.io** extension (v15.1.1) through read-only observation, then we
design a **Manifest V3, least-privilege, compliance-first** architecture for TruePoint that reuses the
server seam already built.

The series spans three halves: **engineering** (`00–05` + `ADR-0043`) — teardown, MV3 architecture,
security/perf, standards, roadmap; **product** (`06–09`) — the feature catalogue, the honest
market-gap/differentiation analysis, the minimal-modern UX/design language, and the product-level
(feature) architecture; and **auth & brand** (`10–13` + `ADR-0044/0045`) — the enterprise authentication
architecture (`10`), the branding/visual-language plan (`11`), the auth gap analysis + companion-window
remediation (`12`, the corrected auth design), and the **brand + live-credits build record** (`13`, what
actually shipped in `apps/extension`).

## 0. Read first — do not duplicate

TruePoint is **not greenfield** here. The **server side of the extension already exists and is tested**;
this program designs the **client build target** (`apps/extension`). **Update (2026-07-21):** that client
now exists and is built through **M1 + partial M2**, shipped **dark** behind flags — see
[`14-implementation-audit.md`](./14-implementation-audit.md) for the authoritative built/dark/stub state,
the gate-state tracker, and the remaining backlog (the X-register). The design docs below stay the target;
doc 14 is the only place shipped-status lives.

- **Product/compliance spec (drafted):** [`prospect-database-platform/06-Chrome-Extension-Capture.md`](../prospect-database-platform/06-Chrome-Extension-Capture.md)
  — the extension is *one connector on the unified ingestion contract*; it **never writes the DB and never
  enriches in-page**; consent + source URL + captured-at are mandatory; suppression runs server-side.
- **Server connector (built + tested):** `packages/core/src/ingestion/connectors/chromeExtension.ts`
  (+ `.test.ts`); contract enum in `packages/types/src/ingestion.ts`.
- **API entry (built):** `POST /api/v1/ingest` (`apps/api/src/features/ingest/routes.ts`) — special-cases
  `chrome_extension` with a per-caller record-volume limiter (`checkCaptureRate`).
- **Money loop (built):** `POST /api/v1/contacts/:id/reveal` (needs `Idempotency-Key`);
  `POST /api/v1/enrichment/:entity/:id`.
- **Flag:** `CHROME_EXTENSION_ENABLED` (`packages/config/src/env.ts`) — currently dark pending legal sign-off.

Every design doc below **cites** those rather than restating them.

## 1. Document set

| # | Doc | What it answers |
|---|---|---|
| — | [`README`](./README.md) | This index + the 20-deliverable coverage map. |
| **00** | [`00-executive-summary.md`](./00-executive-summary.md) | What Apollo is, what we build, the compliant fork, headline recommendations, risk posture. |
| **01** | [`01-apollo-teardown.md`](./01-apollo-teardown.md) | **Reverse-engineering (research Phases 1–8):** architecture, manifest, dynamic injection, LinkedIn detection & SPA handling, MAIN-world interception, data capture, multi-site support, automation engine, browser lifecycle, security & performance — with diagrams. |
| **02** | [`02-target-architecture.md`](./02-target-architecture.md) | **TruePoint enterprise MV3 architecture (research Phase 9):** modular feature/plugin system, browser-event manager, website-adapter framework, compliant extraction engine, LinkedIn & CRM/reveal modules, auth, secure API layer, job scheduler, state, storage/IndexedDB, cache, sync engine, queue, retry, error, event system — with diagrams. |
| **03** | [`03-security-and-performance.md`](./03-security-and-performance.md) | Security architecture (authN/Z, tokens, storage, CSP, isolation, message validation, anti-abuse, consent/audit), performance analysis, scalability. |
| **04** | [`04-engineering-standards.md`](./04-engineering-standards.md) | Tech stack, folder structure, testing strategy, build pipeline, CI/CD, release/version-migration, browser-compat, enterprise deployment, and best practices from leading extensions. |
| **05** | [`05-roadmap.md`](./05-roadmap.md) | Phased implementation roadmap (M1→M5) with milestones, priorities, and the server pieces each milestone rides. |
| **06** | [`06-product-feature-catalog.md`](./06-product-feature-catalog.md) | **Product features:** the full user-facing catalogue in three bands (table-stakes / differentiators / gap-fillers), each mapped to a `/api/v1` endpoint (or dark/net-new), tiered Free/Pro/Enterprise, with JTBD + prioritization. |
| **07** | [`07-market-gap-and-differentiation.md`](./07-market-gap-and-differentiation.md) | **Market gap:** extension-level competitive matrix + the *honest* wedge — the three differentiators that survived adversarial testing, and the five "gaps" that are really table-stakes. |
| **08** | [`08-ux-design-language.md`](./08-ux-design-language.md) | **Minimal-modern design:** the four in-page surfaces (hover-card, side-panel, popup, inline badge), `--tp-*` tokens, four states, motion, WCAG 2.2 AA, shadow-DOM isolation, and ASCII wireframes. |
| **09** | [`09-product-architecture.md`](./09-product-architecture.md) | **Product architecture:** the ten feature modules over a shared `subjectKey`, the five-layer narrative, and the entitlement/consent gating spine — with three feature-level Mermaid diagrams. |
| **10** | [`10-extension-authentication.md`](./10-extension-authentication.md) | **Enterprise auth architecture (⚠ Model A superseded by `12`):** the cross-origin problem, research, full auth lifecycle + every flow (sequence diagrams), security design, backend changes required. Its launchWebAuthFlow primary is superseded — read `12`. |
| **11** | [`11-extension-branding.md`](./11-extension-branding.md) | **Branding & visual language:** the three-chevron mark + real icon assets, Cobalt/Ink tokens, Geist type, brand voice, and per-surface branding (toolbar, popup, auth pages, states, notifications, onboarding, profile, workspace switcher). |
| **12** | [`12-extension-auth-gap-analysis-and-remediation.md`](./12-extension-auth-gap-analysis-and-remediation.md) | **Auth gap analysis & fix:** why auth fails today (launchWebAuthFlow never captures the code; the "tab" symptom), how enterprise extensions really authenticate, the ranked gap register, and the **companion-window** remediation (popup web login + `externally_connectable` handoff + rotating SW refresh token). |
| **13** | [`13-brand-and-credits.md`](./13-brand-and-credits.md) | **Brand + live-credits build record:** the brand→token/font mapping that shipped in `apps/extension` (tokens via `@leadwolf/ui`, self-hosted Geist, the mark/lockup, mark icons) and the credits data-flow (`GET /credits/balance`, the SW `CreditsStore`, refresh triggers + the reveal `balanceAfter` delta). |
| **14** | [`14-implementation-audit.md`](./14-implementation-audit.md) | **Implementation audit (living):** what has actually shipped into `apps/extension` (+ its server seams), the gate-state tracker, the drift log reconciling stale docs (auth backend built, ADR-0043/0045 divergences), and the remaining backlog (X-register). The source of truth for shipped-status. |
| ADR | [`../decisions/ADR-0043-chrome-extension-architecture.md`](../decisions/ADR-0043-chrome-extension-architecture.md) | The MV3 architecture decisions (least-privilege, thin-producer, compliant capture). ⚠ §5 (auth) superseded by ADR-0045; §8 "Preact + Zustand" not-taken — see doc `14`. |
| ADR | [`../decisions/ADR-0044-extension-authentication.md`](../decisions/ADR-0044-extension-authentication.md) | ⚠ **Superseded by ADR-0045.** The original launchWebAuthFlow silent-re-auth decision. |
| ADR | [`../decisions/ADR-0045-extension-auth-companion-window.md`](../decisions/ADR-0045-extension-auth-companion-window.md) | The corrected auth decision: companion-window login + `externally_connectable` handoff + extension-scoped rotating refresh token. |

## 2. Coverage map — the 20 requested deliverables

| # | Deliverable | Where |
|---|---|---|
| 1 | Executive summary | `00` |
| 2 | Multi-phase research findings | `01` (Phases 1–8), `02` (Phase 9) |
| 3 | Architecture diagrams (Mermaid) | `01` §1, `02` §2 |
| 4 | Browser-lifecycle diagrams | `01` §6, `02` §5 |
| 5 | Data-flow diagrams | `01` §3, `02` §7 |
| 6 | Component-interaction diagrams | `01` §1, `02` §2 |
| 7 | Security architecture | `01` §7, `03` §1 |
| 8 | Performance analysis | `01` §8, `03` §2 |
| 9 | Enterprise extension architecture | `02` |
| 10 | Recommended technology stack | `04` §1 |
| 11 | Folder structure | `04` §2 |
| 12 | Database / storage design | `02` §8 |
| 13 | API communication architecture | `02` §6 |
| 14 | Background-worker architecture | `02` §4 |
| 15 | State-management design | `02` §9 |
| 16 | Event-management system | `02` §5 |
| 17 | Error-handling strategy | `02` §11 |
| 18 | Scalability recommendations | `03` §3 |
| 19 | Best practices (leading enterprise extensions) | `04` §6 |
| 20 | Phased implementation roadmap | `05` |

### Product deliverables (added in the `06–09` half)

| Theme | Where |
|---|---|
| How it works as a product / feature inventory | `06` (catalogue), `09` (feature architecture) |
| What features to offer / fill the market gap | `06` §5 (gap-fillers), `07` (the honest wedge) |
| Competitive differentiation | `07` (matrix + verified wedges + table-stakes list) |
| Minimal & modern design | `08` (four surfaces, tokens, states, motion, a11y, wireframes) |
| Product / feature-level architecture | `09` (ten modules, five layers, gating spine, diagrams) |
| Commercial tiering (Free/Pro/Enterprise) | `06` §6–§7 |

### Auth & brand deliverables (added in the `10–12` half)

| Theme | Where |
|---|---|
| Enterprise authentication architecture | `10` (⚠ launchWebAuthFlow primary superseded by `12`) |
| Authentication research (enterprise extensions, OAuth/PKCE/JWT) | `10` Phase 1, `12` §3 |
| Security model (token storage, rotation, revocation, MFA/SSO future) | `10` Phase 3, `12` §7 |
| Every authentication flow (sequence diagrams + recovery) | `10` Phase 4, `12` §6 |
| **Why auth fails today + the fix (companion window)** | **`12`** (root cause, gap register, remediation) |
| Backend/API changes the extension auth requires | `10` §7, `12` §8 |
| The corrected auth decision | `ADR-0045` (supersedes `ADR-0044`) |
| Branding & visual language (mark, tokens, voice, per-surface) | `11` |

## 3. Operating rules (carried from `CLAUDE.md`)

- **Security has final say.** We document Apollo's private-API interception factually, but TruePoint
  **captures only what the signed-in user is authorized to see**, with explicit consent + source
  attribution, and runs suppression server-side. We reject Apollo's `*://*/*` + MAIN-world XHR
  interception as an anti-pattern (see `03` §1.9).
- **Thin producer.** The extension holds **no provider keys, no DB access, no in-page enrichment** — it
  enqueues evidence envelopes to `/api/v1/ingest` and lets the server pipeline run.
- **Documentation-first.** No `apps/extension` code ships until this series is reviewed and the
  compliance sign-off in `06-Chrome-Extension-Capture` §8/§10 lands.

## 4. Method note — how the teardown was produced

Apollo's extension was analyzed **statically and read-only** from its on-disk install
(`…\Extensions\alhgpfoeiimagjlnfekdhkjlkiomcapa\15.1.1_0\`): `manifest.json` in full, the file tree,
and high-signal string analysis of the (minified, source-map-stripped) bundles. No Apollo account was
driven, no traffic was captured, nothing was modified. Findings are behavioral/architectural inferences
from shipped code, not a claim about Apollo's server internals.
