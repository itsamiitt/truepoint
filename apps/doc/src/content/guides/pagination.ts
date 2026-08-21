// pagination.ts — cursor paging and rate limits, kept in one guide because the mistake they cause is the
// same one: asking for far more data than you meant to, and paying for it.

import type { Guide } from "../types.ts";

export const PAGINATION: Guide = {
  slug: "pagination",
  title: "Pagination and rate limits",
  summary:
    "Cursor paging, page sizing, and the limits that keep a runaway loop from becoming an invoice.",
  blocks: [
    { kind: "h2", text: "Cursors, not offsets" },
    {
      kind: "p",
      text: "Search results page by opaque cursor. Each response carries `next_cursor`; pass it back as `cursor` to get the next page, and stop when it comes back null.",
    },
    {
      kind: "code",
      language: "bash",
      source: `# page 1
curl -X POST https://api.truepoint.in/api/v1/public/search \\
  -H "Authorization: Bearer $TRUEPOINT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"entity":"company","filters":{"country":"IN"},"limit":25}'

# page 2 — same filters, plus the cursor from page 1
curl -X POST https://api.truepoint.in/api/v1/public/search \\
  -H "Authorization: Bearer $TRUEPOINT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"entity":"company","filters":{"country":"IN"},"limit":25,"cursor":"c2Vhcm5jaDo0Mg"}'`,
    },
    {
      kind: "p",
      text: "Offsets are not offered, and that is not an omission. The graph changes while you page: with an offset, a record inserted ahead of your position silently shifts every later page, so you skip rows and re-read others without ever being told. A cursor is a position in a stable ordering, so it does not have that failure mode.",
    },
    {
      kind: "note",
      tone: "warning",
      text: "You are billed one credit per result a page returns. A loop that pages to exhaustion on a broad filter will do exactly what you asked and charge for all of it. Bound your paging explicitly — by page count, by credit budget, or by a filter narrow enough that exhaustion is the intent.",
    },
    { kind: "h2", text: "Choosing a page size" },
    {
      kind: "p",
      text: "`limit` accepts 1–100 and defaults to 25. Larger pages are cheaper per request, not per result — the credit cost is identical either way. Size the page to what you will actually use: fetching 100 to display 10 bills you for 100.",
    },
    { kind: "h2", text: "Rate limits" },
    {
      kind: "p",
      text: "Limits are per API key and are about protecting the service, not about pricing — they are separate from your credit balance, and a free call like company matching is still rate-limited.",
    },
    {
      kind: "list",
      items: [
        "Exceeding a limit returns 429 with a `Retry-After` header, in seconds.",
        "429s are never billed, so a backoff loop cannot cost you credits.",
        "Retry with exponential backoff and jitter. Retrying immediately, in lockstep, is how a fleet of workers turns one limit breach into a sustained one.",
        "If you need a sustained ceiling above the default, that is a conversation rather than a config flag — the limit exists to keep one caller from degrading everyone.",
      ],
    },
  ],
};
