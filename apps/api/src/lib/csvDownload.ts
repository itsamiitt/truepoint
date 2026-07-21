// csvDownload.ts — pinned response headers for every endpoint that serves a CSV file (import-redesign 13
// §1.6, step S-S1): `Content-Type: text/csv; charset=utf-8` fixed SERVER-SIDE (never derived from stored
// metadata), `X-Content-Type-Options: nosniff` so a browser never content-sniffs the payload into a
// renderable/executable context, and `Content-Disposition: attachment` with an ASCII-sanitized filename —
// a CSV must never be served renderable in a browser context. One helper so the pinning can't drift per
// endpoint; use it for ANY new file-serving response.

import type { Context } from "hono";

const FALLBACK_FILENAME = "download.csv";

/** Sanitize a download filename to a safe ASCII token: printable ASCII only, with the characters that
 *  could break out of the quoted Content-Disposition parameter (quotes, backslash, CR/LF, semicolon)
 *  stripped. The filename is DATA, never a path (13 §1.5). */
function asciiFilename(filename: string): string {
  const ascii = filename
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[\\";]/g, "")
    .trim();
  return ascii || FALLBACK_FILENAME;
}

/** Pin the CSV download headers (13 §1.6) on the response being built. */
export function setCsvDownloadHeaders(c: Context, filename: string): void {
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("x-content-type-options", "nosniff");
  c.header("content-disposition", `attachment; filename="${asciiFilename(filename)}"`);
}
