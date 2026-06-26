# Email Subsystem — Templating & Personalization (01)

> **Status:** Plan (not yet built). **Owner:** Product + Platform + Design. **Last updated:** 2026-06-24.
> Part of the `docs/planning/email-planning/` set; this is **Doc #2**. It cites the **Shared Canon** —
> Locked Decisions **D1–D10**, the **Shared Vocabulary**, the **Canonical Entities**, and the **Phase Map** —
> defined in `00-overview` and owned (for the data model) by `09-data-model`. Where this doc proposes
> schema or behaviour it does **not** contradict that spine.
>
> **Scope:** end-to-end **templating and personalization** — the authoring layer that turns a stored
> `email_template` / `email_template_version` into the rendered body an `email_send` carries. It does **not**
> own the send path (`02-sending-infrastructure`), deliverability/warmup (`03`), tracking (`04`), the
> sequence engine that binds templates to steps (`05-sequences-automation`), compliance footers/unsubscribe
> (`06`), or the customer Templates surface (`10-web-surface`) / staff surface (`11-admin-surface`). It
> **intersects** all of them; intersections are called out inline.
>
> **Ships in Phase P2 (Templates)** per the Phase Map in `13-rollout-phases`.

---

## 1. Why templating is its own subsystem

Every modern sales-engagement platform (Outreach, Salesloft, Apollo, HubSpot, Reply.io, Lemlist, Smartlead,
Instantly) treats the template as the **unit of reuse and the unit of measurement**: it is what a seller
authors once, what a sequence step points at, what an A/B test splits, and what analytics rolls reply rate
up to. TruePoint's email subsystem needs the same first-class authoring layer — a `email_template` a
workspace owns, versions, shares, and renders **safely** against untrusted prospect data.

This doc covers nine sub-topics end to end. For each: **best-in-class** (how the leaders do it),
**recommended tech**, and **tradeoffs**. Then a **TruePoint mapping** section grounds all of it in our
entities, RLS, and the render-safety constraint (the non-negotiable: **no arbitrary template-engine eval on
untrusted variable values**).

---

## 2. Dynamic variables + fallbacks

**Best-in-class.** Every platform exposes *merge fields* (a.k.a. variables, tokens, dynamic fields) that
auto-populate from CRM/prospect data — `{{first_name}}`, `{{company}}`, `{{title}}`. Outreach calls them
**Variables**; Salesloft calls them **dynamic fields**; HubSpot calls them **personalization tokens**. The
universally-recommended best practice is the **fallback / default value**: when the underlying field is empty
the merge field collapses to a safe default rather than leaving a blank or, worse, emitting `Hi ,`. Salesloft
and Outreach both document this explicitly — "don't forget to set fallback variables for any empty fields"
([Outreach Variables Overview](https://support.outreach.io/hc/en-us/articles/226680368-Outreach-Variables-Overview);
[Salesloft Available Dynamic Fields](https://support.salesloft.com/hc/en-us/articles/360027742311-Available-Dynamic-Fields)).
A missing-fallback send is the single most common embarrassing-personalization failure.

**Recommended tech.** A **whitelisted variable registry** per workspace — a closed set of named tokens, each
mapped to a resolver over the prospect/contact record, the workspace, and the sending user. Each token
declares a **default**; the renderer substitutes the default when the resolver returns null/empty/whitespace.
Tokens are referenced by a delimited syntax (`{{ token }}`) but are **looked up in the registry, never
evaluated** (see §11 render-safety). Default precedence: per-use fallback (authored inline) → token's
registry default → empty string with a render-warning surfaced in the Templates UI.

**Tradeoffs.** A closed registry is less flexible than free-form CRM-field interpolation (a seller can't type
an arbitrary field name) but it is the security boundary that makes injection impossible and gives the four
authoring states (`10-web-surface`) something concrete to validate against. We accept the lower flexibility;
the registry is extensible by config, not by letting clients name arbitrary fields.

---

## 3. Conditional / Liquid logic (if/else)

**Best-in-class.** The leaders run on real templating engines. **Outreach uses Liquid** (Shopify's templating
language) for its template logic — `{% if %}`/`{% else %}` blocks, filters, and loops — which lets a single
template branch on prospect attributes. **HubSpot uses HubL** (its Liquid/Jinja-derived language) with
documented `if`/`unless` statements and operators for conditional email blocks
([HubSpot — If statements](https://developers.hubspot.com/docs/cms/reference/hubl/if-statements);
[Conditionally show/hide email blocks](https://tabular.email/help/conditionally-show-or-hide-email-blocks-using-if-statements)).
Conditional logic is what turns "one template per persona" into "one template, persona-branched" — e.g. a
different value-prop sentence for VP vs. IC titles, or a different CTA when a funding signal is present.

**Recommended tech.** A **sandboxed, restricted template grammar** that supports the *shape* of Liquid
conditionals (`if`/`elsif`/`else`, equality/presence tests, a small fixed filter set such as
`default`/`upcase`/`truncate`) but **bound to the whitelisted variable registry only** and with **no ability
to evaluate attacker-controlled strings as template code**. Conditions test *registry tokens*, not arbitrary
expressions. This is the critical security stance in §11: the engine compiles operator-authored template
*structure* once (at version-create time), but **prospect data is only ever data** — it is never re-parsed as
Liquid/Jinja. Output of every interpolation is HTML-escaped by default.

**Tradeoffs.** Full Liquid/Jinja is powerful but a known server-side-template-injection (SSTI) surface if any
untrusted value reaches the evaluator. A restricted grammar gives ~90% of the authoring value (branching,
defaults, presence checks) while removing the SSTI class entirely. The cost is that power users can't write
arbitrary loops/filters; we treat that as a feature, not a gap. **Security has the final say here** (Shared
Canon precedence): convenience never overrides the no-eval-on-untrusted-input rule.

---

## 4. Snippets / blocks (reusable content chunks)

**Best-in-class.** **HubSpot snippets** are short, reusable text blocks insertable into templates, emails, and
chat ([HubSpot — Create and use snippets](https://knowledge.hubspot.com/conversations/use-snippets)). The
pattern: author a value-prop paragraph, a calendar-link CTA, or a signature block *once*, reference it in many
templates, and edit it in one place. Snippets carry their own permissions in HubSpot
([HubSpot Snippets Permissions](https://mpiresolutions.com/blog/hubspot-snippets/)). Outreach/Salesloft offer
the equivalent via shared content blocks and template fragments.

**Recommended tech.** Model a **snippet as a lightweight, workspace-scoped `email_template` variant**
(a `kind`-style discriminator on the template entity — see `09-data-model`) referenced **by ID, not copied
by value** (the references-not-copies principle from the Constraints Digest). A template that includes a
snippet stores the snippet's ID; the renderer resolves and inlines it at render time. Snippets are themselves
versioned (§9) so editing a snippet doesn't silently mutate already-sent mail.

**Tradeoffs.** Reference-by-ID means editing a shared snippet propagates everywhere immediately — powerful but
surprising; we mitigate with snippet versioning and a "used in N templates" indicator before edit. Copy-by-value
would avoid surprise but defeats single-place-edit (the whole point) and bloats storage. We choose
reference-by-ID + version pinning at send time.

---

## 5. AI-assisted personalization (LLM openers at scale)

**Best-in-class.** Lemlist, Apollo, Smartlead, Instantly, and Reply.io all ship LLM personalization. The
strong-consensus 2025-2026 pattern is **generate chunks, not whole emails**: the LLM writes the high-variance
pieces — the personalized **opener** and a **signal-specific pain hypothesis** — while a human-approved
sequence owns the structure, value-prop, and CTA
([Topo — AI Email Personalization at Scale](https://www.topo.io/blog/ai-email-personalization);
[Apollo — Best AI tool for personalized cold email at scale](https://www.apollo.io/insights/best-ai-tool-for-automating-personalized-cold-email-at-scale-for-b2b-teams);
[Lemlist](https://www.lemlist.com/)). The LLM is fed **structured signals** (title, company, tech stack,
hiring/funding/news events) — quality correlates directly with reply rate (generic ~1–3%; signal-driven
AI-personalized 5–35% by tier). The dominant safeguard is **human-in-the-loop tiering**: Tier 1 strategic
(manual research + AI draft, human-edited), Tier 2 targeted (AI-drafted, human-reviewed), Tier 3 broad (fully
AI, <1 min/email). The loudest warning is **hallucination**: "AI-hallucinated details are the fastest way to
destroy credibility… always verify high-stakes personalization claims" (Topo, 2026).

**Recommended tech — use the latest Claude models.** Per the project's `claude-api` skill (authoritative over
recalled model facts), the current Claude model IDs and pricing are:

| Model | Model ID | Context | Input $/1M | Output $/1M | Recommended role |
|---|---|---|---|---|---|
| Claude Opus 4.8 | `claude-opus-4-8` | 1M | $5.00 | $25.00 | Tier-1 strategic openers; hardest accounts; reviewer/grader of cheaper output |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | $3.00 | $15.00 | Tier-2 default — best speed/intelligence balance for batch opener generation |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | $1.00 | $5.00 | Tier-3 broad/cheap, high-volume, latency-sensitive drafting |

Default to `claude-opus-4-8` for quality-sensitive work; drop to Sonnet 4.6 for cost-efficient batch and
Haiku 4.5 for the cheapest broad tier — a clean three-tier mapping onto the industry tiering model above.
Generation runs as **queue-backed jobs** (`email_send`-adjacent worker; D10 fan-out), never inline in the
request path, so a slow LLM turn never blocks the API. Feed the model **only verified, structured signals**
from the prospect record; never let it invent firmographic facts. Persist the generated opener as a
*candidate* attached to the template render, gated by the tier's review policy before it can be sent. (When
TruePoint writes Claude API code for this, per the skill: adaptive thinking, streaming for long output,
`claude-opus-4-8` as the default model string — covered in the integration doc set, not here.)

**Tradeoffs.**

| Approach | Pro | Con | Best for |
|---|---|---|---|
| **Static merge fields only** (§2) | Deterministic, cheapest, zero hallucination risk, fully cacheable | Lowest relevance; recipients detect templating (69% of decision-makers report annoyance with obvious templates — [Smartlead/G2 2026](https://www.smartlead.ai/blog/what-is-spintax)) | High-volume, low-stakes, compliance-sensitive sends |
| **Spintax variation** (§6) | Breaks spam fingerprint; cheap; no LLM | Variation ≠ relevance; combinatorial QA burden | Deliverability protection on bulk sends |
| **LLM chunk personalization** (Sonnet/Haiku) | High relevance at scale; signal-driven; 5–35% reply | Cost + latency (queue it); hallucination risk → needs review tier; metered spend (FinOps cap per tenant) | Tier-2/3 targeted outreach |
| **LLM full-email + human edit** (Opus 4.8) | Highest relevance; best for whale accounts | Slowest, priciest, lowest throughput | Tier-1 strategic, low volume |

Cost is **metered, per-tenant** (Constraints Digest: per-tenant FinOps quota + cap; `truepoint-operations`).
The non-negotiable is the **review gate before send** for any tier above fully-trusted, and **provenance**: an
LLM-authored opener is stored with its model ID and the signals it was given, so a reply that goes wrong is
auditable.

---

## 6. Spintax / variation

**Best-in-class.** Smartlead, Instantly, Reply.io, GMass, and Salesforge all ship **spintax** — the
`{Hi|Hey|Hello}` syntax that emits one randomly-chosen variant per recipient. Its purpose is **deliverability,
not relevance**: sending byte-identical bodies to hundreds of recipients from one domain trips Gmail/Outlook
**duplicate-content fingerprinting** and gets routed to spam/promotions; spintax breaks the fingerprint so
every send is technically a different email
([Smartlead — What is Spintax](https://www.smartlead.ai/blog/what-is-spintax);
[Instantly — Spintax Explained](https://instantly.ai/blog/spintax/);
[Reply.io — Spintax Generator](https://reply.io/blog/spintax-generator/)). Syntax is curly-brace + pipe, and
**nestable** — `{I noticed|I saw} {your {recent post|latest article}…}` branches into many phrasings from one
block (Smartlead). Reported impact: spintax + ≥2 personalizations correlates with materially higher reply
rates and inbox-placement lift (Smartlead/Hunter.io 2026).

**Recommended tech.** Spintax is a **pre-render expansion pass** over the template body, applied per-recipient
**before** variable substitution, with a **deterministic per-`email_send` seed** (so the chosen variant is
reproducible — the exact text stored on the immutable sent version, §9 / `04-status-event-tracking`). Parse and
expand spintax with a **bounded combinatorial limit** (cap nesting depth and total expansion count) to prevent
a pathological template from exploding. Spintax tokens and merge-field tokens use disjoint delimiters
(`{…|…}` vs `{{ … }}`) so they never collide.

**Tradeoffs.** Spintax adds variation cheaply with no LLM cost, but variation is not relevance — it defeats
*fingerprinting*, not *generic-ness*. QA burden grows combinatorially (each variant must read correctly), so
the Templates UI (`10-web-surface`) should preview sampled expansions. Bounded depth caps the blast radius.
Best used **alongside** §2 fallbacks and §5 LLM openers, not instead of them.

---

## 7. Multi-step sequence templates (templates bound to steps)

**Best-in-class.** In Outreach, Salesloft, Apollo, and Lemlist a **sequence/cadence step references a
template** — the step is the schedule + channel, the template is the content. This lets one template be reused
across sequences and lets a sequence be re-targeted by swapping the template a step points at.

**Recommended tech.** An `outreach_steps` row **references an `email_template` by ID** (references-not-copies)
plus a **pinned `email_template_version`** captured at the moment of enrollment/send so editing the template
later doesn't rewrite in-flight enrollments. This is a hard **intersection with `05-sequences-automation`**:
templating *owns* the template + version + render; the **sequence engine owns the binding, the schedule, and
which version is pinned per `outreach_log` enrollment**. The render contract (registry of variables, snippet
resolution, spintax expansion, LLM-candidate gating) is identical whether a template is rendered ad-hoc or via
a step — one renderer, two callers.

**Tradeoffs.** Version-pinning per enrollment guarantees consistency but means a fix to a template doesn't
retroactively help already-enrolled prospects (they're on the pinned version); we expose a "re-pin to latest"
action rather than silently mutating. This matches the immutable-sent-version rule (§9).

---

## 8. Shared template libraries with permissions (org/team vs personal)

**Best-in-class.** HubSpot, Outreach, and Salesloft all distinguish **personal** templates from **team/org-
shared** ones, with permissions governing who can view/edit/use a shared template
([HubSpot Snippets Permissions](https://mpiresolutions.com/blog/hubspot-snippets/)). Lemlist lets high-
performing campaigns be **saved as shared templates** to spread best practice
([Lemlist — Save an email template](https://help.lemlist.com/en/articles/4452709-save-an-email-template)).

**Recommended tech.** Apply TruePoint's existing **owner-scope + sharing + workspace-role model verbatim**
(**D8 — owner-scoped visibility by default**; Constraints Digest). An `email_template` carries
`tenant_id` + `workspace_id` + `owner_user_id`. Default visibility is **owner-only**; a template is promoted to
**workspace-shared** via an explicit share action, gated by workspace role. This is the *same* sharing
mechanism the Lists subsystem uses (mirrors `list-plan/02-data-model` / `07-admin-staff-governance`) — we
reuse, not reinvent. RLS keys on `workspace_id` (cross-workspace isolation at the DB); **owner-vs-workspace
visibility is the app-layer filter** on top (exactly the posture in `list-plan/02 §1.3`).

**Tradeoffs.** Reusing the Lists ownership/sharing model means zero new authorization primitives and a familiar
mental model for sellers, at the cost of not having email-specific sharing semantics (e.g. "share read-only to
team but let only managers edit") on day one — that's a later refinement layered on the same base, not a
different model. See `12-roles-permissions` for the full matrix.

---

## 9. A/B variants (per-template variant testing) + versioning

**Best-in-class.** Lemlist A/B-tests both messages and sequence steps — author "Cold Intro – Short" vs.
"Cold Intro – Long," split traffic, and measure which wins
([Lemlist — A/B test a step](https://help.lemlist.com/en/articles/4494106-a-b-test-a-step);
[Lemlist — Cold email A/B testing](https://www.lemlist.com/blog/cold-email-ab-testing)). Outreach/Salesloft
offer step-level variant testing with reply-rate as the decisioning metric.

**Recommended tech — A/B variants are template variants, on top of immutable versioning.** Two distinct
concepts, both owned here:

- **`email_template_version` — versioning + the immutable sent-version.** Every edit to a template creates a
  new immutable `email_template_version` (append-only history, mirroring the agent-versioning and
  immutable-snapshot patterns the codebase already uses). At send time the **exact rendered version is frozen
  onto the `email_send`** — the immutable sent-version. This is what makes a sent email auditable and what
  lets tracking (`04`) and analytics (`08`) attribute outcomes to the precise content that went out, even
  after the template is edited. (Render output also captures the spintax seed §6 and any LLM candidate §5.)
- **A/B variants** are modelled as **sibling template variants under one logical template** (a `variant`
  discriminator + a parent grouping), each with its own version chain. The sequence engine
  (`05-sequences-automation`) splits enrollment across variants; analytics (`08`) rolls reply rate up per
  variant. **D6 governs the KPI**: opens are *informational, not the metric of record* (Apple MPP inflates
  opens); **reply rate is the primary A/B decisioning signal**, not open rate.

**Tradeoffs.** Modelling A/B as variants-of-a-template (rather than two unrelated templates) keeps reporting
coherent and makes "promote the winner" a first-class action, at the cost of a slightly more complex template
entity (parent + variant + version). We accept it — the alternative (two standalone templates a human
eyeballs) doesn't roll up cleanly. Statistical-significance gating on the winner-pick lives in `08`.

---

## 10. Brand / letterhead controls (workspace-level branding, signatures, footers)

**Best-in-class.** Workspace/org-level branding — logo, colours, a standard signature block, and a footer —
applied consistently across templates so individual sellers don't hand-roll (and mangle) the brand. Footers
are also where the **compliance** apparatus lives: physical mailing address (CAN-SPAM), the unsubscribe
mechanism, etc.

**Recommended tech.** Model brand assets as **workspace-scoped assets** (`tenant_id` + `workspace_id`, no
`owner_user_id` — they belong to the workspace, not a user) — logo, colour tokens, default signature, default
footer. Templates *reference* the workspace brand (references-not-copies again), so a brand change propagates
without re-editing every template. Signatures may be **per-user** (resolved via a registry token, §2) layered
over the workspace default. **Hard intersection with `06-compliance`**: the renderer **always** appends the
compliance footer — the RFC 8058 one-click unsubscribe header/link and CAN-SPAM postal address (**D9**) — and
this append is **not author-removable**. The brand/letterhead layer styles the footer; compliance owns its
*presence and contents*. Tying off **D4** (suppression gates every send, fail-closed) and **D3** (custom
tracking domain per tenant): unsubscribe links and any tracked links in the footer route through the tenant's
own tracking domain, set by `02`/`03`/`04`, not hard-coded here.

**Tradeoffs.** Workspace-level brand assets centralize control (good for consistency and compliance) but a
single shared signature is too blunt for multi-persona teams — hence per-user signature override on top. The
non-removable compliance footer occasionally frustrates authors who want a "clean" email; that is intentional
and non-negotiable (**security/compliance precedence**).

---

## 11. TruePoint mapping — render-safety, entities, and the no-eval rule

This section is the contract the rest of the subsystem builds against. **Security has the final say** (Shared
Canon precedence); the rules below are not style choices.

### 11.1 Entities (owned by `09-data-model`, used here)

- **`email_template`** — the logical template. Carries `tenant_id`, `workspace_id`, `owner_user_id`
  (**D8** owner-scope), the variant/snippet discriminator, the current pointer into its version chain, and a
  reference to the workspace brand. RLS **ENABLE + FORCE**, fail-closed `NULLIF` on the workspace GUC,
  `tenant_id`-leading index (Constraints Digest, mirroring `list-plan/02 §1.3`).
- **`email_template_version`** — append-only, immutable versions; the version frozen onto an `email_send` is
  the **immutable sent-version** (§9). Same tenancy columns; never updated in place.

### 11.2 Render-safety — guard template injection (the non-negotiable)

1. **No arbitrary Liquid/Jinja eval on untrusted variable values.** Prospect-supplied and CRM-supplied data is
   **only ever data** — it is interpolated, never re-parsed as template code. The only template *code* is the
   operator-authored structure (§3), compiled once at version-create time from a **restricted grammar**.
2. **Whitelist allowed variables.** A token resolves **only** if it is in the workspace's variable registry
   (§2). An unknown token is a render-warning, not an arbitrary field lookup, and certainly not eval.
3. **Escape output.** Every interpolated value is **HTML-escaped by default**; raw/unescaped output is not
   exposed to template authors. This closes the stored-XSS path through prospect data.
4. **Bounded expansion.** Spintax depth/count (§6) and conditional nesting (§3) are capped to prevent
   resource-exhaustion via a hostile template.
5. **LLM output is untrusted too.** An LLM-generated opener (§5) is treated as *data* — escaped, never
   re-evaluated as template — and gated by the tier's review policy before it can reach an `email_send`.

This is the same posture the Constraints Digest states ("validate input + guard template injection") and the
same fail-closed instinct as **D4** (suppression gates every send). A multi-tenant render path that evaluates
untrusted input as template code would be a **bug, not a feature**.

### 11.3 Where templating sits in the file structure (per Shared Canon)

- `packages/db/src/schema/email.ts` + `rls/email.sql` + `repositories/emailRepository.ts` — the
  `email_template` / `email_template_version` tables, RLS, and the sole data-access layer.
- `packages/core/src/email/` — the **renderer** (registry resolution, restricted-grammar conditionals,
  snippet inlining, spintax expansion, escaping, LLM-candidate gating). Pure domain logic; no I/O.
- `packages/types/src/` — the Zod contracts for create/update template, variant, snippet, and the render
  request/response DTOs (RFC 9457 errors on validation failure).
- `apps/api/src/features/email/{routes.ts,index.ts}` — `/api/v1` template CRUD, share, variant, and render-
  preview endpoints; cursor pagination; Idempotency-Key on writes (**D5**).
- `apps/workers/src/queues/email*.ts` — the LLM-personalization generation job (§5), queue-backed (**D10**),
  idempotent, backoff + DLQ.
- `apps/web/src/features/email/{api.ts,types.ts,components/,hooks/,index.ts}` — the **Templates tab**
  surface (`10-web-surface`); four states via `StateSwitch`, `var(--tp-*)` tokens, WCAG 2.2 AA
  (`truepoint-design`).

### 11.4 Intersections (explicit)

| Intersects | What templating provides | What the other doc owns |
|---|---|---|
| `05-sequences-automation` | The `email_template` + pinned `email_template_version` + the renderer | The step→template binding, schedule, per-enrollment version pin, A/B traffic split |
| `10-web-surface` | The render contract, variable registry, variant/snippet model | The **Templates tab** UI, editor, four-state rendering, preview |
| `11-admin-surface` | Template metadata; never record-level content without break-glass | Staff governance, audit of template access (mirrors `list-plan/07`) |
| `06-compliance` | A styling slot for the footer | The footer's **presence + contents** (RFC 8058 one-click unsubscribe, CAN-SPAM address; **D9**) |
| `04-status-event-tracking` | The immutable sent-version frozen on `email_send` | Attribution of opens (informational, **D6**) / replies (primary KPI) to that version |
| `08-reporting-analytics` | Per-variant version identity | Reply-rate rollup, A/B significance, winner-pick |

---

## 12. Summary of recommendations

- **Variables + fallbacks (§2):** closed, whitelisted registry; every token has a default; resolve, never eval.
- **Conditionals (§3):** restricted Liquid-shaped grammar over registry tokens only; HTML-escape output; no SSTI surface.
- **Snippets (§4):** workspace-scoped, versioned, referenced-by-ID, single-place-edit.
- **AI personalization (§5):** generate **chunks** (openers + signal pain-points), queue-backed; **`claude-opus-4-8`** for Tier-1, **`claude-sonnet-4-6`** for Tier-2 batch, **`claude-haiku-4-5`** for Tier-3 broad; verified signals only; review-gate before send; metered per-tenant; provenance stored.
- **Spintax (§6):** bounded pre-render expansion, deterministic per-`email_send` seed; deliverability tool, not a relevance tool.
- **Sequence binding (§7):** step references template + **pinned version**; one renderer, two callers; binding owned by `05`.
- **Shared libraries (§8):** reuse TruePoint owner-scope + sharing + workspace-role (**D8**); RLS on `workspace_id`, app-layer owner filter.
- **A/B + versioning (§9):** A/B = sibling template variants; every edit = immutable `email_template_version`; the sent version is frozen on `email_send`; **reply rate** decides (**D6**, not opens).
- **Brand/letterhead (§10):** workspace-scoped assets, referenced not copied; per-user signature override; **non-removable** compliance footer (**D9**) through the tenant tracking domain (**D3**).
- **Render-safety (§11):** the non-negotiable — no arbitrary template eval on untrusted values, whitelist variables, escape output, bound expansion, treat LLM output as untrusted data. **Ships in P2.**

---

### Sources (live, 2024–2026)

- Outreach — Variables Overview: https://support.outreach.io/hc/en-us/articles/226680368-Outreach-Variables-Overview
- Salesloft — Available Dynamic Fields: https://support.salesloft.com/hc/en-us/articles/360027742311-Available-Dynamic-Fields
- HubSpot — HubL `if` statements: https://developers.hubspot.com/docs/cms/reference/hubl/if-statements
- HubSpot — Create and use snippets: https://knowledge.hubspot.com/conversations/use-snippets
- HubSpot — Snippets permissions (2026): https://mpiresolutions.com/blog/hubspot-snippets/
- Tabular — Conditionally show/hide email blocks with if statements: https://tabular.email/help/conditionally-show-or-hide-email-blocks-using-if-statements
- Smartlead — What is Spintax (2026): https://www.smartlead.ai/blog/what-is-spintax
- Instantly — Spintax Explained: Boosting Cold Email Deliverability (2025): https://instantly.ai/blog/spintax/
- Reply.io — Spintax Generator: https://reply.io/blog/spintax-generator/
- Topo — AI Email Personalization at Scale (2025–2026): https://www.topo.io/blog/ai-email-personalization
- Apollo — Best AI tool for automating personalized cold email at scale: https://www.apollo.io/insights/best-ai-tool-for-automating-personalized-cold-email-at-scale-for-b2b-teams
- Lemlist — AI outbound platform: https://www.lemlist.com/
- Lemlist — A/B test a step: https://help.lemlist.com/en/articles/4494106-a-b-test-a-step
- Lemlist — Cold email A/B testing: https://www.lemlist.com/blog/cold-email-ab-testing
- Lemlist — Save an email template: https://help.lemlist.com/en/articles/4452709-save-an-email-template
