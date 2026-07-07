# 07 — Market Gap & Differentiation (Extension Surface)

> **Series:** [TruePoint Browser Extension](./README.md) · **Doc:** 07 · **Status:** ✅ Drafted
> · **Prev:** [`06-product-feature-catalog`](./06-product-feature-catalog.md) · **Next:** [`08-ux-design-language`](./08-ux-design-language.md)

`01` was a *technical* teardown of one competitor. This doc is the *market* view: where TruePoint's
extension actually wins, stated honestly. It builds on TruePoint's own strategy corpus
([`market-analysis/02-competitor-analysis`](../../market-analysis/02-competitor-analysis.md),
[`03-market-gaps`](../../market-analysis/03-market-gaps.md),
[`08-swot`](../../market-analysis/08-swot.md)) — it does **not** restate it, and it never contradicts it.

**This doc's discipline:** every claimed differentiator was run through an adversarial check ("do the
incumbents already ship this in *their* extension?"). Most did not survive. We lead with the few that did
and are explicit about the many that are **table-stakes, not a moat** — because overclaiming would betray
the exact "honest" positioning that is the strategy.

---

## 1. The category, and where the extension sits

Sales-intelligence prospecting is an **extension-led** category: Lusha, Kaspr, Seamless, Wiza, Hunter,
Apollo, RocketReach, and Cognism all lead with a Chrome extension. So **an extension is table-stakes for
this segment** — not, by itself, a differentiator. TruePoint's strategy places it in the vacant
intersection **"compliant + affordable + full-loop"** (Apollo owns affordable + full-loop with weak
compliance; Cognism owns compliant + premium but *data-only and does not send*). The extension is the
**delivery vehicle for the SMB/self-serve wedge and the DIY-replacement thesis** — but its job is to
express *trust / compliance / isolation*, not to win a database-size or feature-count race.

Boundary (non-negotiable, from the corpus): **we compete on trust, not database breadth.** TruePoint owns
no proprietary dataset — it verifies third-party data via a provider waterfall. The extension must **not**
drift into scraping-and-breadth; capture is human-in-the-loop and visible-DOM only
([`ADR-0043`](../decisions/ADR-0043-chrome-extension-architecture.md), and Kaspr's €240K CNIL fine +
Seamless's LinkedIn delisting are the cautionary cases).

## 2. Competitive matrix — extension surface

Rough capability parity across the extensions users actually compare (● ships it, ◐ partial/limited,
○ absent; based on the competitive research pass, 2025–2026):

| Capability | Apollo | ZoomInfo (ReachOut) | Cognism | Lusha | Seamless | Kaspr | Wiza | Hunter | **TruePoint (planned)** |
|---|---|---|---|---|---|---|---|---|---|
| In-page reveal (email/phone) | ● | ● | ● | ● | ● | ● | ◐ | ◐ (email) | ● |
| Org-wide reveal-once, free re-read | ● | ● | ● | ◐ | ○ | ◐ | ○ | ◐ | ● |
| Bulk reveal a search page | ● | ● | ◐ | ○ | ● | ◐ | ● | ○ | ◐ (dark) |
| Add-to-list / lists | ● | ● | ● | ● | ● | ● | ● | ◐ | ● |
| Add-to-sequence in-extension | ● | ◐ | ○ | ○ | ● | ○ | ○ | ○ | ● |
| CRM push / two-way sync | ● | ● | ● | ● | ● | ● | ◐ | ◐ | ○ (net-new) |
| Dialer | ● | ● | ○ | ○ | ● | ○ | ○ | ○ | ○ (net-new) |
| AI NL→filter search | ● | ● | ● | ○ | ◐ | ○ | ○ | ○ | ● |
| CRM-grade fields *in the card* | ◐ | ◐ | ○ | ○ | ◐ | ○ | ○ | ○ | ● |
| Admin/batch suppression / DNC | ● | ● | ● | ◐ | ◐ | ● | ○ | ○ | ● |
| **In-transaction reveal+enroll gate** | ○ | ○ | ◐ (sourcing only) | ○ | ○ | ◐ | ○ | ○ | ● |
| **Live DSAR/consent-withdrawal at the click** | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ● |
| **Tenant-owned exportable lawful-basis artifact** | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ◐ (net-new) |
| **No-surprise-overage hard credit ceiling** | ○ (auto-charges overage) | ◐ (annual pool) | ◐ (annual pool) | ◐ | ○ (charges for no-data) | ◐ | n/a | ◐ | ● |
| Honest/no-lock-in billing posture | ○ | ○ | ◐ | ● | ○ | ◐ | ◐ | ● | ● |

The three **bold** rows plus the last two rows (the no-surprise-overage ceiling and the honest-billing
posture) are where TruePoint has a real, defensible edge. Almost
everything else is parity we must simply match well.

## 3. The honest wedge — what actually survives

Eight candidate "gaps" were tested adversarially. **Five were rejected as table-stakes reframed** (§4).
**Three survive, in refined form** — and they cluster on one theme the whole strategy points at:
**compliance + billing honesty enforced at the exact monetized moment**, which incumbents structurally
avoid because it costs them either overage revenue or a compliance-liability posture they've disclaimed.

### 3.1 A tenant-owned lawful-basis + audit artifact at collection

- **Not** "consent capture" — that framing is wrong for cold B2B (the subject isn't present and gives no
  consent; what's recorded is the *buyer's lawful basis*, near-always legitimate-interest). A mandatory
  per-reveal picker would *depress* adoption, so we **auto-stamp a configurable default basis with zero rep
  friction**, shown as a one-line indicator, not a gate.
- **The wedge:** no incumbent extension emits a per-reveal, per-contact, **append-only, tenant-owned,
  exportable** lawful-basis + audit artifact into the *buyer's own* tenant, usable as ROPA/DSAR/DPA
  evidence. Apollo explicitly disclaims EU/UK safeguards (shifts the burden to the user); ZoomInfo trades
  the buyer's contacts back into its dataset; Cognism is compliant at *sourcing* but produces no
  per-rep-action artifact the buyer controls.
- **Why TruePoint can:** the enforcement is already in code — reveal runs an unbypassable in-transaction
  gate (`assertNotSuppressed`) and writes an append-only audit row for every reveal *and* every blocked
  attempt. The buyer-facing **exportable artifact** is the net-new part.
- **Buyer:** EU/UK/DPDP-regulated teams and their sales-ops/compliance approver — exactly where the
  incumbents self-disclaim. **Rep experience stays friction-free.**

### 3.2 A live consent-withdrawal / DSAR-erasure gate at the monetized click

- **Do not** claim incumbents lack suppression — ZoomInfo (Master Suppression + DNC across countries),
  Apollo (Do-Not-Contact lists), and Cognism (DNC/GDPR-scrubbed) all ship **admin/batch** suppression.
  Leading with "we check suppression and they don't" is false and would be rebutted instantly.
- **The genuinely absent capability:** a **live, self-serve, per-workspace** gate at the *exact* reveal/enroll
  click that enforces the buyer's own state — specifically a **consent withdrawal (GDPR objection)** or an
  **active DSAR/erasure** against that subject — **synchronously inside the charge transaction**, so (a) the
  credit is never spent on a contact you're legally obligated not to process, (b) an erased/objected subject
  can never be silently re-revealed or re-enrolled, and (c) the blocked attempt is audit-logged as proof.
- **Two seams incumbents miss:** DSAR/erasure-awareness *at capture time* (they treat DSAR as a back-office
  privacy-center flow), and enforcement on the **export-to-external-sequence** path (incumbent DNC lives in
  *their* sequencer and does nothing once you push to your ESP).
- **Why TruePoint can:** `assertNotSuppressed` runs inside the reveal tx (`revealContact`) and enroll tx
  (`enrollContact`); a `SuppressedError` rolls the tx back so **no credit is spent**; consent-withdrawal and
  DSAR fan-out both auto-insert a global suppression row, so the same gate transitively enforces both. The
  **export-path gate** is the net-new part.

### 3.3 A no-surprise-overage credit ceiling

- **Parity hygiene, not the headline:** per-action cost preview and "owned-is-free" flags — Apollo's "Net
  New" selector, ZoomInfo's reveal-once, and Cognism's dup-detection already approximate these. Leading with
  them invites a "we already do that" rebuttal.
- **The defensible wedge — a business-model asymmetry:** Apollo **auto-charges overages at ~$0.20/credit**,
  its single angriest billing complaint, *precisely because there is no ceiling*; ZoomInfo/Cognism lock spend
  into negotiated annual pools. TruePoint's bulk confirm gate leases a worst-case ceiling and **refuses**
  (`InsufficientCreditsError`) rather than silently overspending. An incumbent won't cannibalize overage
  revenue with a hard cap — so a challenger can own **"you will never be surprise-charged, ever"** as a brand
  promise.
- **To fully deliver:** the current lease enforces a *system-computed* worst case, not a *user-set* budget —
  add a **user-settable per-job cap** (the honest, net-new completion of the promise).

## 4. Table-stakes, not a moat (rejected claims — stated plainly)

These read like differentiators but were **rejected** on evidence. The docs name them so no one later
mistakes them for the wedge:

| Tempting claim | Why it's not a moat |
|---|---|
| "First-reveal-wins dedup with free hydrate — a team of 10 stops paying 10×" | Apollo (account-pooled credits, extension draws the same pool, "Net New" toggle) and ZoomInfo (reveal-once/keep-forever) **already do org-wide free re-read**. TruePoint's `/revealed[/batch]` is a clean *parity* implementation, not a category-new capability. |
| "Per-workspace agency switcher in-card" | Apollo's Solutions-Partner program already offers per-client workspace switching with per-workspace governance, and its extension writes to the active workspace. Also, TruePoint's **Layer-0 master graph is a shared, system-owned golden record with no RLS** — only the **Layer-1 overlay** (lists/scores/outreach/suppression) is isolated, so "no shared golden record" is *false*. The only honest angle is packaging (DB-RLS isolation as an auditable guarantee + no Partner-tier tax), which is positioning, not a structural gap. |
| "Validated AI NL prospecting, preview before you spend" | Cognism's AI Search and Apollo both hand you an editable AI-populated filter before running, and **search is free everywhere** (only reveal costs) — "preview before you spend" just restates how the category works. The narrow residual is *query portability/auditability* (the AI emits the same validated `ContactQuery` as the manual builder, so it's reproducible/saveable/diffable) — a transparency nuance, not an underserved market. |
| "Turn a Sales-Nav page into an owned, audited list" | TruePoint's `captureSalesNavLink` stores a **bookmark (URL + note/labels)** and by design (ADR-0009) *never fetches or automates against LinkedIn* — no name/email/phone is ingested. Apollo/ZoomInfo genuinely bulk-select a Sales-Nav page and export populated rows for free. The mechanic as pitched doesn't exist; the real strengths (masked-vs-revealed, audited export) are generic and aimed at the *opposite* (enterprise) buyer from the "beat DIY SMB" framing. |
| "Minimal single-purpose card vs dense enterprise overlay" | A red ocean, not a white space — Lusha, Kaspr, Skrapp, Prospeo, Hunter already ship clean single-purpose reveal widgets. Minimal UI is trivially copyable (a "compact mode" toggle), buyer-invisible (internal token discipline isn't a market wedge), and off-axis (buyers switch for better/cheaper *data*, not a smaller card). We should still be minimal (see `08`) — just not pitch it as the moat. |

## 5. The DIY baseline is the real low-end competitor

The strategy's sharpest point: most early buyers compare TruePoint not to a named SaaS but to the **DIY
stack — Sales Navigator + a spreadsheet + a VA + bought lists**. The extension is precisely where that gets
beaten: Sales Nav has no bulk export and no emails; bought lists carry sender liability; data decays ~30%/yr.
A one-click **capture → verify → reveal → export**, repeatable and audited, is a categorically better job.
**Caveat (honest):** the realistic upgrade for the price-sensitive DIY buyer is often *Apollo Free*, whose
one-click scrape+export is lower-friction than a paste-link-then-import-then-pay flow — so TruePoint must
win this buyer on **trust + the full loop in one app**, and lead the compliance story with the *enterprise/EU*
buyer where it's actually decisive.

## 6. Positioning summary (for the extension)

> **TruePoint's extension is the compliant, honest way to prospect from the page.** It matches the incumbents
> on the core reveal/list/sequence loop, and wins on two things they structurally won't copy: **compliance
> enforced at the monetized click** (live DSAR/consent gate + a tenant-owned, exportable lawful-basis audit
> trail — for the EU/regulated buyer the incumbents self-disclaim) and **billing you can trust** (a
> no-surprise-overage credit ceiling — against Apollo's auto-charged overages). Everything else is
> table-stakes we execute cleanly; we never claim otherwise.

Feature-by-feature mapping of these positions to shipped vs net-new work is in
[`06-product-feature-catalog`](./06-product-feature-catalog.md); the security enforcement behind the
compliance claims is in [`03-security-and-performance`](./03-security-and-performance.md) §1.
