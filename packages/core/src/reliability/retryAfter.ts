// retryAfter.ts — the ONE Retry-After parser (RFC 9110 §10.2.3): both the delta-seconds form every
// enrichment vendor uses AND the HTTP-date form (which the old per-adapter parsers silently dropped —
// a vendor switching forms turned every hinted wait into an unhinted one). PURE: the clock is injected
// (default Date.now) so the date form unit-tests deterministically.

/**
 * Parse a Retry-After VALUE into milliseconds from `now`. Seconds form (integer or decimal) wins;
 * otherwise the HTTP-date form is tried; a past date clamps to 0; garbage/absent → undefined.
 */
export function parseRetryAfterMs(
  raw: string | undefined,
  now: () => number = Date.now,
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now());
}

/**
 * Case-insensitive `retry-after` lookup over a plain header record (the hubspotHttp `header()` idiom —
 * transports SHOULD lowercase keys, but a hand-built test record must not silently read as "no header").
 */
export function retryAfterFromHeaders(
  headers: Record<string, string> | undefined,
  now: () => number = Date.now,
): number | undefined {
  if (!headers) return undefined;
  const direct = headers["retry-after"];
  if (direct !== undefined) return parseRetryAfterMs(direct, now);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "retry-after") return parseRetryAfterMs(value, now);
  }
  return undefined;
}
