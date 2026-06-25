// renderTemplate.ts — the render-safe template engine (M12 P2, 01; email-planning/13 P2). Substitutes
// `{{ variable }}` / `{{ variable | fallback }}` merge fields from contact data. The security boundary
// (truepoint-security): the TEMPLATE BODY is authored by the (trusted) user, but the VARIABLE VALUES come
// from (untrusted) contact data — so values are HTML-escaped before insertion and there is NO recursion (a
// value that itself contains `{{…}}` is inserted literally, never re-rendered). No eval, no Liquid/Jinja
// interpreter — a fixed, single-pass token substitution. Unknown / not-allowed keys fall back, never error
// and never leak the raw token. Pure; no I/O.

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export interface RenderOptions {
  /** When set, only these merge-field keys substitute; any other token falls back (whitelist). */
  allowedKeys?: ReadonlySet<string>;
  /** HTML-escape substituted VALUES (default true — for an HTML body). Set false for a plain-text subject. */
  escapeValues?: boolean;
}

/**
 * Render `template`, substituting merge fields from `variables`. A missing/empty value uses the token's
 * `| fallback` (or ""). Variable values are HTML-escaped by default (the untrusted-input boundary); the
 * template author's own markup is preserved. Single pass — substituted values are never re-rendered.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string | null | undefined>,
  opts: RenderOptions = {},
): string {
  const doEscape = opts.escapeValues !== false;
  return template.replace(TOKEN, (_match, key: string, rawFallback?: string) => {
    const fallback = (rawFallback ?? "").trim();
    if (opts.allowedKeys && !opts.allowedKeys.has(key)) {
      return doEscape ? escapeHtml(fallback) : fallback;
    }
    const v = variables[key];
    const value = v != null && v !== "" ? v : fallback;
    return doEscape ? escapeHtml(value) : value;
  });
}

/** The distinct merge-field keys a template references — drives the editor's "fields used" hint + validation. */
export function extractVariables(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(TOKEN)) {
    if (m[1]) seen.add(m[1]);
  }
  return [...seen];
}
