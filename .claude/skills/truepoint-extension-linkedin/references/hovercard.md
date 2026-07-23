# Hover card (in-page surface)

The hover card is the one thing the extension injects into LinkedIn's page. It is the minimal in-page trigger
that shows the prospect's status and a primary action; the real workspace is the Side Panel (out of page).
Keep it small, isolated, and resilient.

## How it's built (`src/content/hovercard/index.ts`)

- **Shadow DOM isolation.** The card mounts in a shadow root so LinkedIn's CSS can't bleed in and ours can't
  bleed out. Tokens are injected as inline text: `import tokens from "@leadwolf/ui/tokens.css?inline"` then set
  `style.textContent = tokens + baseCss`.
- **Vanilla DOM, not React.** The in-page bundle is deliberately framework-free to stay tiny and fast to inject
  (ADR-0043 §8 floated Preact; as-built is plain DOM — either keeps the bundle small; do not pull React into
  the content script).
- **Reads `var(--tp-*)`** for brand-consistent styling without importing the component barrel.

## Rules

- **The card is a thin client.** It renders extracted (name/title/location) + a status pill + one primary
  action, and it `send()`s a `LOOKUP` to the SW to hydrate real status (`known`/`owned`/`unknown`). It holds
  no token and makes no API call.
- **Implement the four states** — resolving, unknown (offer capture), known/owned (offer open/reveal), error.
  Wire the primary action to the correct branch: an **owned** subject's primary action must open the app /
  reveal, not fall through to capture (the X06 miswire here is **fixed** — owned opens the app; the X06
  remainder is the panel tabs, see doc 14).
- **Tear down cleanly** on SPA navigation (see `spa-navigation.md`) — one card at a time, no leaked nodes.
- **Defer the visuals to `truepoint-design`** — placement, spacing, motion, copy, accessibility, and the exact
  state treatments are its call; this reference is about isolation and wiring, not look.
- Keep the injected footprint minimal — it is also fingerprint surface (see `anti-fingerprint-and-tos.md`).
