# Input Validation and Injection

Every piece of data that originates outside the server is untrusted: request
bodies, query params, headers, uploaded files, webhook payloads, and even the
data returned from third-party APIs. Injection vulnerabilities happen when
untrusted input is used to build a query, command, path, or markup without being
validated or safely encoded first.

---

## Validate at the Boundary

All external input is parsed and validated against a schema the moment it enters
the server, before any other code touches it. Validation is not "check it looks
roughly right" — it is "parse it into a known-good typed shape, and reject
anything that doesn't fit."

Use a schema validator (Zod is the codebase standard) at every API boundary:

```ts
const AddProspectInput = z.object({
  listId: z.string().uuid(),
  prospectId: z.string().uuid(),
  source: z.enum(['manual', 'import', 'enrichment']),
})

// at the route handler
const parsed = AddProspectInput.safeParse(req.body)
if (!parsed.success) return badRequest(parsed.error)
// from here on, `parsed.data` is typed and known-valid
```

Validate type, format, length, and range. An email field is a valid email; an ID
is a UUID; a free-text field has a max length; an enum is one of the allowed
values. Reject everything else — do not coerce or "clean" suspicious input, reject it.

> **Implementation status:** this matches the codebase — boundary validation is Zod
> `safeParse` at the route handler (e.g. `contactQuery.safeParse(...)` in
> `apps/api/src/features/search/routes.ts`), returning a 400 on `!parsed.success`.

This also protects against oversized input: cap string lengths and array sizes so
a request can't carry a 10MB field or a million-element array (see `api-security.md`).

---

## SQL / Database Injection

Never build a query by concatenating input into a string. Always use
parameterised queries or the ORM's typed query builder, which separates the query
structure from the data.

```ts
// ❌ injection — input becomes part of the SQL
db.query(`SELECT * FROM prospects WHERE name = '${name}'`)
// name = "'; DROP TABLE prospects; --" is now a very bad day

// ✅ parameterised — input is data, never code
db.query('SELECT * FROM prospects WHERE name = $1', [name])

// ✅ ORM — structure and data are separate by construction
db.prospect.findMany({ where: { name } })
```

This applies to every query: filters, sorts, search. A "search" feature that
interpolates the search term into raw SQL is a classic injection point — keep it
parameterised. The same discipline applies to any NoSQL or query DSL: never let
input define query structure.

---

## Cross-Site Scripting (XSS)

XSS is when attacker-controlled input is rendered as executable markup in another
user's browser — letting the attacker run script in that user's session.

React escapes string content by default, which prevents the common case. The
dangerous exits from that protection:

- **`dangerouslySetInnerHTML`** — renders raw HTML. Never pass user-influenced
  content to it. If you must render rich text, sanitise it with a vetted
  sanitiser (DOMPurify) first, and treat reaching for `dangerouslySetInnerHTML`
  as a decision that needs justification. See `frontend-security.md`.
- **URL injection** — a user-supplied value used as an `href` or `src` can be
  `javascript:` or `data:` URI. Validate that user-supplied URLs are `http(s)`
  before using them in a link or image.
- **Stored XSS** — the most damaging: malicious input saved to the database (a
  prospect name, a note) that executes when another user views it. The defence is
  the same — never render stored content as raw HTML; let React escape it.

CRM data is full of free-text fields (names, notes, company descriptions) that one
user enters and another views. Treat all of it as untrusted on the way out, not
just on the way in.

---

## SSRF (Server-Side Request Forgery)

This is a live risk for TruePoint because the enrichment features make outbound
requests. SSRF is when an attacker gets the server to make a request to a URL
*they* control — pointing it at internal services, the cloud metadata endpoint
(`169.254.169.254`, which can leak cloud credentials), or internal admin panels
the server can reach but the attacker can't.

If any feature fetches a URL that is influenced by user input — an enrichment
lookup, a webhook target, an avatar-from-URL, a "fetch company website" — then:

- **Allowlist** the destinations where possible. Enrichment calls go to known
  provider domains, not arbitrary URLs.
- **Validate and resolve** any user-supplied URL: reject non-`http(s)` schemes,
  reject private/loopback/link-local IP ranges (`10.x`, `192.168.x`, `127.x`,
  `169.254.x`, `::1`), and reject hostnames that resolve to them.
- **Never** pass a raw user-supplied URL straight into a server-side fetch.

See `integrations.md` for the outbound-request rules in full.

---

## Command and Path Injection

- **Command injection** — never pass input into a shell command. Avoid shelling
  out at all; if unavoidable, use an API that takes an argument array (not a
  string the shell parses) and never interpolate input into the command string.
- **Path traversal** — never build a file path from input without validating it.
  Input like `../../etc/passwd` escapes the intended directory. For file
  operations (CSV import, attachments), validate the resolved path stays within
  the allowed directory, and never use a user-supplied filename as a path directly.

---

## File Uploads

CSV import and any attachment feature handle untrusted files:

- Validate the file type by content, not just extension — a `.csv` can contain
  anything.
- Cap file size before processing, so a huge upload can't exhaust memory.
- Parse CSV with a real parser, not by splitting strings — and treat every cell
  as untrusted input subject to the rules above (a cell can carry an injection
  payload or a formula-injection attack if later opened in a spreadsheet).
- Never execute, never store in a web-served path, never trust the filename.

---

## Checklist

- Is every external input validated against a schema at the boundary?
- Are all queries parameterised / built through the ORM, never string-concatenated?
- Is any stored or user-supplied content rendered as raw HTML? (it shouldn't be)
- Are user-supplied URLs validated to `http(s)` and non-internal before use?
- Does any feature fetch a URL influenced by input? Is it allowlisted/validated? (SSRF)
- Are uploaded files size-capped, type-checked by content, and parsed safely?
- Are string lengths and array sizes capped to prevent oversized payloads?
