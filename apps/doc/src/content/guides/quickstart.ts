// quickstart.ts — the /docs landing page. The first thing a developer reads, so it says what the thing is,
// what it costs, and what is real today before it shows a single line of code.

import type { Guide } from "../types.ts";

export const QUICKSTART: Guide = {
  slug: "quickstart",
  title: "Quickstart",
  summary: "What the API does, what a call costs, and how to make your first one.",
  blocks: [
    {
      kind: "note",
      tone: "warning",
      text: "The endpoints documented here are a published contract, not a shipped service. Nothing on api.truepoint.in answers these paths yet. This reference exists so the contract can be reviewed, argued with and built against before it is frozen — every endpoint page carries its own status badge.",
    },
    {
      kind: "p",
      text: "The TruePoint data API answers two questions: who is this company, and who works there. You send a partial identifier — a domain, an email, a name plus an employer — and get back a structured record where every field carries its own provenance.",
    },
    {
      kind: "p",
      text: "It is priced in credits and metered on results. A call that returns nothing costs nothing, which means our coverage gaps show up in our match rate rather than on your invoice.",
    },
    { kind: "h2", text: "Three things worth knowing before you integrate" },
    {
      kind: "list",
      items: [
        "Company matching is free. Resolve domains to ids as often as you like; it is rate-limited, not billed.",
        "Every response carries field_provenance. A value with three corroborating sources seen last week is not the same asset as a single-source value from last year, and the API refuses to pretend otherwise.",
        "Suppressed people are absent, not redacted. Someone who has opted out comes back as a no-match, on every endpoint, with no flag to override it.",
      ],
    },
    { kind: "h2", text: "Your first call" },
    {
      kind: "p",
      text: "Start with company matching, because it is free and it tells you immediately whether your identifiers resolve to the entities you expect.",
    },
    {
      kind: "code",
      language: "bash",
      source: `curl "https://api.truepoint.in/api/v1/public/company/match?domain=northgate.example.com" \\
  -H "Authorization: Bearer $TRUEPOINT_API_KEY"`,
    },
    {
      kind: "p",
      text: "A match returns the canonical domain we hold the company under. That domain is the identifier every other call takes — there is no opaque id to store, and normalising your own records onto it is what makes the next call cheap.",
    },
    { kind: "h2", text: "Then enrich" },
    {
      kind: "code",
      language: "bash",
      source: `curl -X POST https://api.truepoint.in/api/v1/public/company/enrich \\
  -H "Authorization: Bearer $TRUEPOINT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"domain":"northgate.example.com"}'`,
    },
    {
      kind: "p",
      text: "Every billed response includes credits_charged, so your own metering can reconcile against ours per call rather than per invoice. If those two numbers ever disagree, that is a bug on our side and we want to hear about it.",
    },
    { kind: "h2", text: "Where to go next" },
    {
      kind: "list",
      items: [
        "Authentication — how keys work, and what to do when one leaks.",
        "Errors — the full problem+json vocabulary, including which failures are billed (none of them).",
        "Pagination and rate limits — how to page a search without paying for results you discard.",
        "Confidence and provenance — how to read the field_provenance block, and what each source class means.",
      ],
    },
  ],
};
