// jsonBodyCap.ts — read a JSON request body as a parsed value UNDER A HARD BYTE CAP. The JSON-path equivalent
// of the multipart admission's whole-body gate (13 §1 / S-S1), used by the P5 API-push verb POST /imports/rows:
//   1. a DECLARED Content-Length over the cap is refused up front (cheap, before touching the stream), AND
//   2. the stream itself is counted so a lying or absent (chunked) Content-Length can't slip a huge body past.
// Without this, an attacker could send rows carrying enormous field values and JSON.parse would buffer them ALL
// into memory before Zod's per-field max-lengths reject — a body-size DoS the row-count ceiling alone can't
// bound. Decoupled from the Hono Context (takes the header value + the raw stream) so the cap logic is unit-
// testable in isolation without an HTTP harness.

import { ImportTooLargeError } from "@leadwolf/types";

/**
 * Read `stream` fully as UTF-8 and `JSON.parse` it, aborting past `maxBytes`.
 * - `declaredContentLength`: the request's `Content-Length` header (or null/undefined) — an over-cap declared
 *   length throws {@link ImportTooLargeError} (413) WITHOUT reading a byte.
 * - A null/empty stream ⇒ `{}` (an absent body parses as the empty object → downstream schema rejects it as a
 *   missing `rows`, a clean 400).
 * - Malformed JSON throws (a `SyntaxError`) — the caller maps it to a 400.
 * Throws {@link ImportTooLargeError} the instant the counted bytes exceed `maxBytes` (the stream is cancelled).
 */
export async function readJsonBodyCapped(
  declaredContentLength: string | null | undefined,
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<unknown> {
  const declared = Number(declaredContentLength);
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new ImportTooLargeError({ limit: maxBytes, current: declared, unit: "bytes" });

  if (!stream) return {};

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ImportTooLargeError({ limit: maxBytes, current: total, unit: "bytes" });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(buf).trim();
  if (text === "") return {};
  return JSON.parse(text);
}
