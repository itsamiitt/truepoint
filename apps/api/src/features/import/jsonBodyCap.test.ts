import { describe, expect, test } from "bun:test";
// jsonBodyCap.test.ts — the P5 API-push body-size DoS guard (import-and-data-model-redesign 08 §9 / 13 §1).
// CI-RUN: this sandbox cannot execute bun; these are the CI gate for the byte cap. The guard must refuse an
// over-cap DECLARED Content-Length before reading a byte, AND abort a lying/absent-length body mid-stream —
// so JSON.parse can never buffer an oversized payload into memory before Zod's per-field maxes reject it.

import { ImportTooLargeError } from "@leadwolf/types";
import { readJsonBodyCapped } from "./jsonBodyCap.ts";

/** Build a ReadableStream that emits `text` (UTF-8) in fixed-size chunks — a stand-in for a request body. */
function streamOf(text: string, chunkBytes = 8): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(i, i + chunkBytes));
      i += chunkBytes;
    },
  });
}

const CAP = 1024;

describe("readJsonBodyCapped", () => {
  test("parses a valid under-cap JSON body", async () => {
    const body = JSON.stringify({ sourceName: "manual", rows: [{ email: "a@b.co" }] });
    const out = await readJsonBodyCapped(String(body.length), streamOf(body), CAP);
    expect(out).toEqual({ sourceName: "manual", rows: [{ email: "a@b.co" }] });
  });

  test("a null stream yields {} (absent body → schema rejects downstream)", async () => {
    expect(await readJsonBodyCapped(null, null, CAP)).toEqual({});
  });

  test("a whitespace-only body yields {}", async () => {
    expect(await readJsonBodyCapped(undefined, streamOf("   \n"), CAP)).toEqual({});
  });

  test("refuses an over-cap DECLARED Content-Length WITHOUT reading the stream", async () => {
    // A poisoned stream: any read attempt rejects with the wrong error class. The declared-length check
    // must win first, so the ImportTooLargeError assertion proves the short-circuit. (A pull-spy can't:
    // the runtime may eagerly prime pull() at construction regardless of whether the impl reads.)
    const poison = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("stream must never be read"));
      },
    });
    await expect(readJsonBodyCapped(String(CAP + 1), poison, CAP)).rejects.toBeInstanceOf(
      ImportTooLargeError,
    );
  });

  test("aborts a lying/absent Content-Length once streamed bytes exceed the cap", async () => {
    const huge = "x".repeat(CAP * 4);
    const body = JSON.stringify({ rows: [{ email: huge }] });
    // No declared length (chunked) — the counter is the only guard.
    await expect(readJsonBodyCapped(undefined, streamOf(body), CAP)).rejects.toBeInstanceOf(
      ImportTooLargeError,
    );
  });

  test("a body exactly at the cap is accepted (boundary)", async () => {
    // Pad a valid JSON object to exactly CAP bytes with insignificant whitespace.
    const base = JSON.stringify({ rows: [{ email: "a@b.co" }] });
    const padded = base + " ".repeat(CAP - base.length);
    expect(padded.length).toBe(CAP);
    const out = (await readJsonBodyCapped(String(CAP), streamOf(padded), CAP)) as {
      rows: unknown[];
    };
    expect(out.rows).toHaveLength(1);
  });

  test("malformed JSON throws (caller maps to a 400)", async () => {
    await expect(readJsonBodyCapped(undefined, streamOf("{not json"), CAP)).rejects.toBeTruthy();
  });
});
