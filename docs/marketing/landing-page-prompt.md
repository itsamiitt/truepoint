# TruePoint — Landing Page Build Prompt

> Copy everything below the line into your AI site builder (v0 / Lovable / Cursor / Claude / Bolt). It is a
> self-contained brief for a **long, modern, fully-animated, scroll-driven** marketing site for **TruePoint**.
> Pricing numbers are intentionally **placeholders** — keep them labelled.

---

## ROLE

You are a senior product designer + front-end engineer. Build a **production-ready, single-page marketing
site** for **TruePoint** — long, editorial, and **fully animated with smooth scroll-driven motion**. The
aesthetic is **calm, premium, near-monochrome** (think Linear / Vercel / Stripe restraint), *not* loud
sales-tech. Motion should feel **expensive and effortless**, never gimmicky. When in doubt: subtle, smooth,
purposeful.

## PRODUCT IN ONE PARAGRAPH

TruePoint is **the intelligent prospecting CRM** — a per-workspace, multi-tenant sales-intelligence platform
where a sales team does the whole motion in one app: **find** the right people, **reveal** verified
email/phone, **score** them by ICP fit + intent, then **sequence and send** outreach — with **compliance
built into the core** (suppression gates both reveals *and* sends; GDPR/CCPA/DSAR first-class). It replaces a
stitched-together stack of a data vendor + enrichment tool + sequencer + compliance spreadsheet. You **own
your data** (per-workspace copies, no shared "golden record"), you **only pay for verified data** (bad data is
free; bounces are credited back), and there's **no lock-in** (transparent pricing, no auto-renew traps, export
and leave anytime). The name says it plainly: the **true** point of contact, every time.

- **Tagline (hero):** **"Point to your best leads."**
- **Category:** sales intelligence + prospecting CRM.
- **For:** SDRs, AEs, and RevOps teams who want clean data and an end-to-end workflow in one place.
- **Against:** bloated legacy data vendors (ZoomInfo et al.) and duct-taped tool stacks.

## BRAND SYSTEM (follow exactly)

**Aesthetic:** clean, light, near-monochrome with **one** restrained accent. ~90% of every screen is
monochrome; the accent is *earned* — it appears only on the single most important action/state.

**Colors (CSS variables):**
```
--bg-content:    #FFFFFF   /* primary surface */
--bg-sidebar:    #F9FAFB   /* muted panels / alt sections */
--border-hairline:#F0F0F0  /* dividers */
--border-default:#E5E7EB   /* cards, inputs */
--text-primary:  #111827   /* near-black headings + body */
--text-secondary:#6B7280   /* muted labels */
--accent:        #4F46E5   /* "TruePoint Indigo" — rare: primary CTA, active state, key highlight */
--success:       #16A34A   /* verified */
--warning:       #D97706   /* low credits / risky */
--danger:        #DC2626   /* invalid / destructive */
```
The accent reads as **precision / signal** — focused, exact, trustworthy. **Do not** build a dark theme (a
light UI is core to the brand). Optional: one very subtle indigo radial-gradient glow behind the hero headline
and the final CTA — faint, never neon.

**Typography:** **Geist** (fallback **Inter**); **Geist Mono** for data/numbers/IDs/credit counts. Hierarchy
through **weight + size, not color**. Big confident headings (Semibold, tight tracking), generous body
(Regular), lots of whitespace. Wordmark: `TruePoint` with "True" Regular + "Point" Semibold (single color, no
second color).

**Logo / mark:** a minimal geometric **TruePoint mark** — a *precise pinpoint*: a single accent "point" dot
sitting at the convergence of two clean strokes that form a subtle upward locator / crosshair (reading as "the
exact right point, found"). Monochrome, single weight, the lone accent dot allowed as the "point." Use a
tasteful inline SVG placeholder matching this description; **never** literal bullseye/clipart targets or stock
imagery.

**Icons:** **Lucide**, thin/geometric/muted-grey. The pinpoint/locator motif lives **only** in the logo —
don't sprinkle target icons through the UI.

**Voice & copy:** direct, calm-confident, jargon-free. Short sentences, concrete verbs. No exclamation spam,
no "synergy / 10x / game-changer". Collaborative ("your team"), never creepy/surveillance. Words to use:
*find, reveal, score, verify, precise, true, signal, clean, own, on point.* Avoid: *scrape, harvest, blast,
spray, stalk.*

## TECH + LIBRARIES

- **Next.js (App Router) + TypeScript + Tailwind CSS.** Componentized (one component per section).
- **Motion:** **Framer Motion (`motion`)** for enter/scroll animations + **Lenis** for smooth inertial scroll.
  (Use GSAP + ScrollTrigger only if a pinned scrollytelling section needs it.)
- **shadcn/ui** primitives (accordion, tabs, buttons), **Lucide** icons.
- Fonts via `next/font` (Geist + Geist Mono).
- No heavy page builders; clean semantic HTML. Ship a real, scrollable page — not a screenshot.

## GLOBAL MOTION & SCROLL SPEC (this is the heart of the brief)

Make the page feel alive as you scroll, with taste:

1. **Smooth scroll** — Lenis inertial scrolling site-wide (lerp ~0.1), synced with Framer Motion's `useScroll`.
2. **Scroll-progress bar** — a thin 2px accent bar at the very top tracking page progress.
3. **Reveal-on-scroll** — every section's elements enter with a soft fade + 16–24px upward translate, **staggered** (children 60–90ms apart), triggered when ~20% in view, played **once**. Easing `cubic-bezier(0.22,1,0.36,1)` ("easeOutExpo"), duration 500–700ms.
4. **Sticky / pinned scrollytelling** — the **core loop** section pins while the user scrolls through its 5 steps (Find → Reveal → Score → Sequence → Send): the left side holds copy that swaps per step; the right side is an animated product canvas that morphs between steps (masked row → revealed row → score badge filling → sequence steps drawing in → send "delivered" check). Progress dots on the side.
5. **Parallax** — subtle (±20–40px) on hero visual layers, section background accents, and product mockups. Keep it gentle.
6. **Number count-ups** — stats animate from 0 to target when scrolled into view (Geist Mono).
7. **Animated diagrams** — the find→reveal→score→sequence→send pipeline draws its connectors (SVG path
   `pathLength` 0→1) and pulses a "credit" token along the reveal step.
8. **Bento hover micro-interactions** — feature cards lift slightly (translateY -4px), hairline border brightens to accent at low opacity, an inner icon nudges. Magnetic effect on primary CTA buttons (button eases toward cursor within a small radius).
9. **Marquee** — a slow, infinite, pausable logo/words marquee for "works with / replaces" row.
10. **Sticky nav transition** — transparent over hero, then on scroll it gains a white background, hairline bottom border, and slight shadow; condense padding.
11. **Reveal "magic moment"** — in the hero and the Reveal step, animate a masked contact (`j••••@acme.com`, `•••‑•••‑••12`) **un-blurring/decrypting** into a real value with a green "verified ✓" stamp and a tiny "1 credit" chip. This is the signature interaction (and the literal meaning of "TruePoint") — make it delightful.
12. **Accessibility:** fully honor `prefers-reduced-motion` — replace transforms with instant/opacity-only, disable Lenis, freeze marquees and parallax. Never trap scroll. Keep 60fps (animate transform/opacity only; `will-change` sparingly).

**Motion tokens:** durations 0.5–0.7s (entrances), 0.2s (hovers); ease `[0.22,1,0.36,1]`; stagger 0.07s.

## PAGE STRUCTURE (in scroll order — long & readable)

Build these sections top-to-bottom. Each lists **purpose · layout · copy · motion**. Use the draft copy
(edit lightly for fit). Alternate `--bg-content` and `--bg-sidebar` backgrounds for rhythm.

### 0. Sticky Nav
- **Layout:** TruePoint mark + `TruePoint` wordmark (left); center links *Product · How it works · Pricing · Trust · Docs*; right: ghost "Sign in" + accent "Start free" button.
- **Motion:** transparent → solid-on-scroll (see global #10); mobile = slide-over menu.

### 1. Hero
- **Copy:**
  - Eyebrow: *The intelligent prospecting CRM*
  - H1: **Point to your best leads.**
  - Sub: *Find the right people, reveal verified email and phone, score them, and run compliant outreach — all in one app. No stitched-together stack. No stale data. No lock-in.*
  - CTAs: **Start free** (accent) · **See how it works** (ghost, scrolls to core loop)
  - Trust line under CTAs: *GDPR & CCPA built in · You only pay for verified data · Export and leave anytime.*
- **Visual:** a clean, light **product UI mock** (search results table with masked rows) floating with soft shadow; one row performs the **reveal "magic moment"** on loop/scroll. Faint indigo radial glow behind the headline.
- **Motion:** headline words stagger-up; product mock parallax + subtle 3D tilt on pointer; animated scroll cue at bottom.

### 2. Social proof / "replaces your stack"
- **Copy:** small caps *Replaces a 5-tool stack* → an infinite marquee of the categories TruePoint collapses: *Data vendor · Email finder · Verifier · Sequencer · Compliance spreadsheet → one app.*
- **Motion:** slow marquee (pausable); logo placeholders in muted grey.

### 3. Problem
- **Copy:**
  - H2: **Prospecting is five tools held together with tape.**
  - Body: *Your data is stale and scattered. You pay for emails that bounce. Your sequencer doesn't know what your data vendor knows. And compliance is a spreadsheet someone forgot to update. The result: wasted reveals, missed quota, and real legal risk.*
  - Three pain chips: *Stale, scattered data · Paying for bad data · Compliance as an afterthought.*
- **Motion:** the "five tools" visually drift apart / glitch, then in the next section snap into one. Reveal-on-scroll.

### 4. Core loop — pinned scrollytelling (signature section)
- **Copy header:** **One platform. One workflow. Find → Reveal → Score → Sequence → Send.**
- **Steps (each pins with its own copy + animated canvas):**
  1. **Find.** *Search a masked book of contacts and accounts with rich filters — title, seniority, intent, headcount, location. See what you'll get before you spend a thing.*
  2. **Reveal.** *Spend a credit to unlock verified email and phone. First reveal in a workspace wins; re-reveals are free. Suppressed contacts are never revealed.* (animate the un-blur + verified ✓ + "1 credit")
  3. **Score.** *Every prospect gets an ICP-fit, intent, and engagement score — so you pursue the right ones first.* (animate a 0→87 composite gauge)
  4. **Sequence.** *Build multi-step sequences and let AI draft the first touch. You review, you approve.* (steps draw in)
  5. **Send.** *Send compliant email with deliverability handled — domains, DKIM/SPF/DMARC, warm-up, unsubscribe. Every send passes a suppression check.* (a "delivered" check + suppression shield)
- **Motion:** sticky pin; left copy crossfades per step; right canvas morphs; progress dots; SVG connector draws as you advance. (Graceful non-pinned stacked fallback on mobile + reduced-motion.)

### 5. Differentiators — 3 pillars (+ honest billing)
- **Copy (H2): Why teams switch to TruePoint.**
  - **End-to-end in one app.** *Find → reveal → score → sequence → send. Stop paying for — and stitching — five tools.*
  - **Compliance as a feature.** *GDPR + CCPA designed in. Suppression gates both reveals **and** sends. DSAR, consent, and an append-only audit trail are first-class — not bolted on.*
  - **You own your data.** *Per-workspace copies with hard isolation. No shared "golden record," no surprise data-destroy on churn. Export and leave anytime.*
- **Motion:** three cards reveal with stagger; each has a small animated line-icon (loop, shield, vault).

### 6. "Verified-or-free" trust highlight
- **Copy:**
  - H2: **Only pay for data that's actually good.**
  - Body: *We verify every email and phone at reveal. If it's invalid, you're not charged. If a valid email bounces, we credit it back. The market's #1 complaint, fixed.*
  - Chips: *Charged only for `valid` · Bad data = 0 credits · Credit-back on bounce.*
- **Motion:** the reveal "magic moment" replayed; a counter shows "credits saved" counting up; an `invalid → 0 credits` row animates.

### 7. Feature deep-dive — bento grid
- **Copy (H2): Everything precision prospecting needs.** A responsive bento of cards (varying sizes), each title + one line + tiny animated visual:
  - **Masked search & faceted filters** — *see status glyphs (✓ valid, ? risky, — none) before you spend.*
  - **Reveal & credits** — *email / phone / full profile, idempotent and fair.*
  - **Enrichment & verification** — *Apollo, ZoomInfo, Clearbit — cache-first, cost-aware.*
  - **Lead scoring & intent signals** — *ICP fit + intent + engagement, versioned and explainable.*
  - **Sequences & deliverability** — *domains, DKIM/SPF/DMARC, warm-up, bounce→suppression.*
  - **Compliance & DSAR** — *suppression, consent, access/delete/rectify, audit log.*
  - **CRM sync** — *HubSpot, Salesforce, Pipedrive — push revealed contacts and lists.*
  - **Public API & webhooks** — *CRM-neutral and API-first; build on your data.*
  - **AI drafting (augmented, not autonomous)** — *AI drafts, you approve. Human-in-the-loop by design.*
- **Motion:** cards reveal staggered; hover lift + accent hairline; each mini-visual animates on hover/in-view.

### 8. Compliance & Trust
- **Copy:**
  - H2: **Built for the teams whose legal team has questions.**
  - Body: *Suppression and lawful basis gate every reveal and every send — enforced in the database, not as an afterthought. DSAR access/delete/rectify fan out across every copy. Everything meaningful is audited.*
  - Trust badges row (placeholders, labelled "in progress"): *SOC 2 Type II · ISO 27001 · GDPR · CCPA · US data-broker registration · DPA · Sub-processor list.* Link: **Visit the Trust Center →**
- **Motion:** a shield/lock line-illustration draws; badges fade-up in a row.

### 9. Built for your role (tabs)
- **Copy (H2): One app, every seat.** Tabs: **SDR / AE · RevOps · Compliance · Developer.** Each tab swaps a short value line + 3 bullets + a small relevant visual.
  - *SDR/AE:* find → reveal → sequence without leaving the app.
  - *RevOps:* seats, credits, data hygiene, usage reporting.
  - *Compliance:* DSAR, suppression, audit trail, Trust Center.
  - *Developer:* CRM-neutral REST API, webhooks, OpenAPI.
- **Motion:** animated tab indicator; content crossfade.

### 10. Stats band
- **Copy:** 3–4 count-up metrics (use honest, generic framing since pre-launch — e.g. *verified-on-reveal accuracy, credits saved on bad data, one workspace = your whole motion, minutes to first reveal*). Label any aspirational number clearly.
- **Motion:** count-up on scroll; Geist Mono; thin animated underlines.

### 11. Pricing
- **Copy (H2): Transparent pricing. No traps.**
  - Sub: *Public pricing, month-to-month, cancel anytime. Credits don't expire. We never destroy your data to keep you.*
  - **Four tiers** (numbers are PLACEHOLDERS — render as `$—/mo` or "Custom" with a "pricing TBD" note):
    - **Free** — 1 workspace · reveals (credits) · basic reports.
    - **Pro** — everything in Free · sequences + send · full reports.
    - **Team** — multiple workspaces · roles · CRM sync · public API + webhooks.
    - **Enterprise** — SSO/SCIM · IP allowlist · data residency · audit-log export · SLA / priority support.
  - Feature comparison checklist under the cards. Toggle monthly/annual (annual optional, not forced).
- **Motion:** cards reveal staggered; "most popular" (Pro/Team) gets the lone accent ring; hover lift; checklist rows tick in.

### 12. Honest comparison
- **Copy (H2): The anti-lock-in alternative.** A compact table: TruePoint vs "Legacy data vendors" across:
  *Transparent self-serve pricing · No auto-renewal traps · Export & leave anytime · Pay only for verified data · Suppression gates sends too · End-to-end in one app.* (TruePoint ✓ across; incumbents mostly ✗.) Keep it factual and fair, not snarky.
- **Motion:** rows reveal; check/cross marks pop in with a tiny spring.

### 13. Testimonials (placeholder)
- **Copy:** 2–3 placeholder quote cards in brand voice (mark clearly as placeholders). Monochrome avatars (initials), Geist Mono attribution.
- **Motion:** gentle horizontal auto-scroll or fade carousel; pause on hover.

### 14. FAQ (accordion)
- **Copy:** *Is my data really mine? · What happens to bad data and bounces? · How does compliance gate sends? · Can I export and leave? · Do credits expire? · Do you integrate with my CRM?* Answer each in 2–3 brand-voice sentences.
- **Motion:** shadcn accordion with smooth height + chevron rotate; reveal-on-scroll.

### 15. Final CTA
- **Copy:** H2 **Get to the point.** · Sub: *Start free. Reveal your first verified leads in minutes — no card required.* · **Start free** (accent) + **Talk to us** (ghost).
- **Visual:** faint indigo glow; the TruePoint mark subtly drawn/animated (the point "locking in").
- **Motion:** big confident reveal; magnetic CTA.

### 16. Footer
- **Layout:** wordmark + one-line pitch; columns — *Product, Company, Resources, Legal, Trust.* Include **Trust Center, Sub-processors, DPA, Privacy, Terms, Unsubscribe**, and the required physical address line. Newsletter input (subtle).
- **Motion:** quiet fade-in; back-to-top with smooth Lenis scroll.

## RESPONSIVENESS, A11Y, PERFORMANCE

- Mobile-first; pinned scrollytelling degrades to a clean stacked sequence on small screens.
- WCAG AA contrast (the monochrome palette already passes); visible focus rings (accent); semantic landmarks; alt text; keyboard-operable nav/tabs/accordion.
- `prefers-reduced-motion`: opacity-only or no animation, Lenis off, marquees/parallax frozen.
- Animate only `transform`/`opacity`; lazy-load below-the-fold visuals; target Lighthouse ≥ 95 perf/a11y; no layout shift.

## ASSETS

- No generic stock photography and no literal bullseye/target clichés. Use **minimal monochrome line
  illustrations**, generous whitespace, and **product-UI mockups** (build them as lightweight HTML/CSS, not
  images, so they animate). One accent highlight per illustration at most. Inline SVG for the TruePoint mark +
  all diagrams.

## DELIVERABLE

A single scrollable Next.js page composed of the sections above as separate components, with a small
`lib/motion.ts` exporting shared variants (fade-up, stagger, easing tokens) and a `<SmoothScroll>` (Lenis)
wrapper. Clean, commented, production-ready. Keep all pricing numbers as labelled placeholders.
