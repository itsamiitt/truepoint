# DOM extraction

The extraction rule is: **read the least you can, only what the user can already see, and let the server do
the rest.** The extension is a thin producer (ADR-0043 §3) and a compliant citizen (§4); it is not a scraper.

## What to extract

- **The identity (required):** the LinkedIn public identifier from `/in/<publicId>` — the join key to
  `contacts.linkedinPublicId`. This is usually the *only* thing needed: with it, the SW asks the server to
  resolve the prospect (the resolver endpoint, X01) and hydrates the card from our own data.
- **Minimal visible fields (for the hover card / capture envelope):** the rendered name, headline/title, and
  location the user is looking at — the visible text, via `firstText`-style selectors (`src/content/extract/dom.ts`).
- **For a capture:** the identity + minimal fields + `consent` + `sourceUrl` + `capturedAt`. The server runs
  validate → dedup → resolve → suppress → enrich → project; the extension never enriches in-page.

## What NOT to extract

- **No private-API data.** Do not read Voyager/Sales-Navigator/Recruiter JSON, do not monkey-patch
  `fetch`/`XHR`, do not inject a MAIN-world script. (ADR-0043 §4; detected per `anti-fingerprint-and-tos.md`.)
- **No bulk/off-screen harvesting.** Not connection lists, not search-result pages, not background tabs — only
  the one profile the user opened.
- **No reconstructing licensed data by scraping.** We already hold enrichment data server-side; scrape the
  identity, resolve server-side, don't re-derive.

## Rules

- **Resilient, fail-soft selectors.** LinkedIn markup drifts; a missing selector yields a partial/`null`
  result the UI degrades gracefully around — never a thrown error and never a broken page.
- **Prefer the URL/path for identity** (stable) over deep DOM selectors (fragile).
- **Never write to LinkedIn's DOM** except the isolated Shadow-DOM hover-card mount (see `hovercard.md`).
- **Everything extracted is untrusted input to the server** — it is validated by the ingestion contract
  (`@leadwolf/types`) server-side; the client does not get to assert trust.
