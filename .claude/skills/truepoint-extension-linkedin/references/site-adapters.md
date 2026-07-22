# Site adapters

Every supported site is a self-contained adapter behind one interface, selected by a registry. Adding a site
(or a new LinkedIn page type) means writing an adapter — never sprinkling site-specific logic through the
content script.

## The framework

- **Interface + types:** `src/content/adapters/types.ts`.
- **Registry:** `src/content/adapters/registry.ts` — maps the current URL to the right adapter.
- **LinkedIn adapter:** `src/content/adapters/linkedin/index.ts`.
- **Content-script entry:** `src/content/index.ts` — resolves the adapter, checks the page type, extracts,
  shows the hover card, and fires a best-effort `LOOKUP` to the SW.

## The LinkedIn adapter as-built

- **Page-type detection:** recognizes `/in/<slug>` (profile), `/company/<slug>` (company), and `/search`
  (search) from the path. Only the **profile** path currently produces an extraction — `extract()` returns
  `null` for company/search (X07: the company adapter is the next to build).
- **Identity:** for a profile it extracts the `/in/<publicId>` slug — the canonical join key that matches
  `contacts.linkedinPublicId` server-side.

## Rules for a new adapter / page type

- **One adapter owns one site.** Keep detection (`pageType`) and extraction (`extract`) in the adapter; the
  content script stays generic.
- **`extract()` returns a typed result or `null`** — never throws for "this page isn't supported." A `null`
  is a normal outcome the content script handles by rendering nothing.
- **Emit the identity the server can resolve**, plus the minimal visible fields for the hover card — not a
  full profile dump (see `dom-extraction.md`).
- **A company adapter** should extract the company's LinkedIn identifier/URL (matches `accounts.linkedinCompanyUrl`)
  and the minimal visible fields, and set the page type so `src/content/index.ts` shows a company card.
- **Selectors are versioned in-repo** (ADR-0043 §7) — they are shipped code reviewed in the store build, never
  pushed via remote config. Expect LinkedIn markup drift; make selectors resilient and fail soft.
