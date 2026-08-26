// snippets.ts — the worked example, in the languages people actually paste into.
//
// Every endpoint spec carries ONE reviewed cURL example. Rather than asking each spec to repeat itself in
// three languages — three copies of one request, two of which nobody proofreads — the other languages are
// derived from that cURL. It stays the single reviewed artifact; the others cannot drift from it, because
// they are a transform of it.
//
// Parsing our own generated content is safe in a way parsing arbitrary shell is not: the examples are written
// in one house style (flags, one header per continuation line, a single-quoted `-d` payload), and
// snippets.test.ts asserts every endpoint's example still parses into a request whose method, URL and body
// match the endpoint's own declared contract. If someone writes an example this cannot read, a test says so
// rather than a page quietly rendering half a snippet.

import type { Endpoint } from "./types.ts";

export interface Snippet {
  readonly id: string;
  /** Shown on the language selector. */
  readonly label: string;
  /** Passed to CodeBlock as its language label. */
  readonly language: string;
  readonly source: string;
}

export interface ParsedRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly query: readonly (readonly [string, string])[];
  readonly headers: readonly (readonly [string, string])[];
  /** The JSON body as written in the example, or null for a GET. */
  readonly body: string | null;
}

/** Join a cURL example's backslash continuations back into one line. */
function flatten(request: string): string {
  return request.replace(/\\\r?\n\s*/g, " ");
}

/**
 * Read one of our cURL examples back into its parts.
 *
 * Deliberately narrow: it understands the flags our examples use (`-X`, `-G`, `-H`, `-d`,
 * `--data-urlencode`) and nothing else. A parser that tried to be a shell would fail in ways nobody could
 * predict; this one fails loudly on anything unfamiliar, and the test suite is what notices.
 */
export function parseCurl(request: string): ParsedRequest {
  const flat = flatten(request);

  const headers: (readonly [string, string])[] = [];
  for (const match of flat.matchAll(/-H\s+"([^"]+)"/g)) {
    const raw = match[1] ?? "";
    const colon = raw.indexOf(":");
    if (colon === -1) continue;
    headers.push([raw.slice(0, colon).trim(), raw.slice(colon + 1).trim()]);
  }

  const query: (readonly [string, string])[] = [];
  for (const match of flat.matchAll(/--data-urlencode\s+"([^"]+)"/g)) {
    const raw = match[1] ?? "";
    const eq = raw.indexOf("=");
    if (eq === -1) continue;
    query.push([raw.slice(0, eq), raw.slice(eq + 1)]);
  }

  const bodyMatch = /-d\s+'([\s\S]*?)'(?:\s|$)/.exec(flat);
  const body = bodyMatch?.[1]?.trim() ?? null;

  const urlMatch = /(https:\/\/[^\s"']+)/.exec(flat);
  const rawUrl = urlMatch?.[1] ?? "";
  const [url, inlineQuery] = rawUrl.split("?");
  if (inlineQuery) {
    for (const pair of inlineQuery.split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      query.push([pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1))]);
    }
  }

  const method = /-X\s+POST/.test(flat) || body ? "POST" : "GET";
  return { method, url: url ?? "", query, headers, body };
}

/** `Authorization: Bearer $TRUEPOINT_API_KEY` becomes an env read, not a literal, in every language. */
function isAuthHeader(name: string): boolean {
  return name.toLowerCase() === "authorization";
}

function extraHeaders(parsed: ParsedRequest): readonly (readonly [string, string])[] {
  // Content-Type is set by the language's own JSON call in both snippets below, so repeating it would be
  // noise a reader has to check rather than information.
  return parsed.headers.filter(
    ([name]) => !isAuthHeader(name) && name.toLowerCase() !== "content-type",
  );
}

function nodeSnippet(parsed: ParsedRequest): string {
  const lines: string[] = ["const key = process.env.TRUEPOINT_API_KEY;", ""];

  if (parsed.query.length) {
    lines.push(
      `const url = new URL(${JSON.stringify(parsed.url)});`,
      ...parsed.query.map(
        ([name, value]) =>
          `url.searchParams.set(${JSON.stringify(name)}, ${JSON.stringify(value)});`,
      ),
      "",
    );
  }

  const target = parsed.query.length ? "url" : JSON.stringify(parsed.url);
  const headerLines = [
    "    Authorization: `Bearer ${key}`,",
    ...(parsed.body ? ['    "Content-Type": "application/json",'] : []),
    ...extraHeaders(parsed).map(
      ([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)},`,
    ),
  ];

  lines.push(
    `const response = await fetch(${target}, {`,
    `  method: ${JSON.stringify(parsed.method)},`,
    "  headers: {",
    ...headerLines,
    "  },",
    ...(parsed.body ? [`  body: JSON.stringify(${compactJson(parsed.body)}),`] : []),
    "});",
    "",
    "// Every error is problem+json. Branch on `code`, never on the human-readable title.",
    "if (!response.ok) {",
    "  const problem = await response.json();",
    "  throw new Error(`${problem.code}: ${problem.title}`);",
    "}",
    "",
    "const data = await response.json();",
    "// A miss is a normal 200 — check `matched` before reading the record.",
  );
  return lines.join("\n");
}

function pythonSnippet(parsed: ParsedRequest): string {
  const lines: string[] = [
    "import os",
    "import requests",
    "",
    'key = os.environ["TRUEPOINT_API_KEY"]',
    "",
  ];

  const headerEntries = [
    '    "Authorization": f"Bearer {key}",',
    ...extraHeaders(parsed).map(
      ([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)},`,
    ),
  ];
  lines.push("headers = {", ...headerEntries, "}", "");

  if (parsed.query.length) {
    lines.push(
      "params = {",
      ...parsed.query.map(
        ([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)},`,
      ),
      "}",
      "",
    );
  }

  const call =
    parsed.method === "GET"
      ? `response = requests.get(${JSON.stringify(parsed.url)}, headers=headers${
          parsed.query.length ? ", params=params" : ""
        }, timeout=30)`
      : `response = requests.post(${JSON.stringify(parsed.url)}, headers=headers, json=${pythonLiteral(
          parsed.body ?? "{}",
        )}, timeout=30)`;

  lines.push(
    call,
    "",
    "# Every error is problem+json. Branch on `code`, never on the human-readable title.",
    "if not response.ok:",
    "    problem = response.json()",
    "    raise RuntimeError(f\"{problem['code']}: {problem['title']}\")",
    "",
    "data = response.json()",
    "# A miss is a normal 200 — check `matched` before reading the record.",
  );
  return lines.join("\n");
}

/** Re-emit a JSON body as compact JS/JSON so a multi-line example does not derail the snippet's indentation. */
function compactJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    return body;
  }
}

/** JSON is valid Python for our bodies EXCEPT the literals, which Python spells differently. */
function pythonLiteral(body: string): string {
  const compact = compactJson(body);
  return compact
    .replace(/\btrue\b/g, "True")
    .replace(/\bfalse\b/g, "False")
    .replace(/\bnull\b/g, "None");
}

export function buildSnippets(endpoint: Endpoint): readonly Snippet[] {
  const parsed = parseCurl(endpoint.example.request);
  return [
    { id: "curl", label: "cURL", language: "bash", source: endpoint.example.request },
    { id: "node", label: "Node.js", language: "javascript", source: nodeSnippet(parsed) },
    { id: "python", label: "Python", language: "python", source: pythonSnippet(parsed) },
  ];
}
