// clamdScanner.ts — the ClamAV adapter for core's MalwareScannerPort (import-redesign 13 §2.1's recommended
// baseline, step S-S2 / GATE C / G08): speaks the clamd TCP protocol's zINSTREAM command DEPENDENCY-FREE over
// node:net — no npm dependency, self-hostable as a sidecar in the current single-region deployment (the
// scanner placement inherits the bucket's region pin — 13 §10.2 residency note). Host/port ride env
// (CLAMAV_HOST/CLAMAV_PORT) at the composition roots; the vendor is an ops choice behind the port.
//
// PROTOCOL (clamd docs): send `zINSTREAM\0`, then the file as length-prefixed chunks — a 4-byte BIG-ENDIAN
// unsigned length followed by that many bytes — terminated by a ZERO-length chunk; clamd answers one
// NUL-terminated line: `stream: OK` (clean) · `stream: <Signature> FOUND` (infected) · `... ERROR` (e.g.
// "INSTREAM size limit exceeded" — which correctly fails CLOSED here: a file too big to scan is a file too
// big to accept, 13 §2.1). Any socket/connect/timeout failure ⇒ verdict `error` — the caller's fail-closed
// branch (503 at admission; retry→DLQ at the drive). NOTHING from the scanned content is ever logged or
// echoed; the signature name is the only detail carried (non-PII, engine-issued).
//
// The protocol pieces are PURE, exported helpers (frame builder + response parser) so the EICAR/framing unit
// tests run with a FAKE socket — no clamd in CI (T-S3's end-to-end EICAR run is the itest against a real
// sidecar, CI-owed with the deployment).

import { connect as netConnect } from "node:net";
import type { MalwareScanResult, MalwareScanSource, MalwareScannerPort } from "@leadwolf/core";

/** The 4-byte big-endian length prefix for one INSTREAM chunk. Exported for the framing unit test. */
export function instreamLengthPrefix(byteLength: number): Uint8Array {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(byteLength, 0);
  return buf;
}

/** The INSTREAM terminator: a zero-length chunk. */
export const INSTREAM_TERMINATOR: Uint8Array = instreamLengthPrefix(0);

/** The command that opens the stream (z-variant: NUL-terminated command + NUL-terminated reply). */
export const INSTREAM_COMMAND: Uint8Array = Buffer.from("zINSTREAM\0", "ascii");

/** Parse clamd's one-line reply. Exported for the EICAR unit test. Unknown shapes = `error` (fail-closed). */
export function parseClamdResponse(raw: string): {
  verdict: "clean" | "infected" | "error";
  signature?: string;
} {
  const line = raw.replace(/\0/g, "").trim();
  if (/^stream: OK$/i.test(line)) return { verdict: "clean" };
  const found = /^stream: (.+) FOUND$/i.exec(line);
  if (found?.[1]) return { verdict: "infected", signature: found[1] };
  return { verdict: "error" }; // "… ERROR", size-limit refusals, or garbage — never admits a file
}

async function* webStreamToBytes(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function toIterable(source: MalwareScanSource): AsyncIterable<Uint8Array> {
  if (source instanceof Uint8Array) {
    return (async function* one(): AsyncGenerator<Uint8Array> {
      yield source;
    })();
  }
  return typeof (source as ReadableStream<Uint8Array>).getReader === "function"
    ? webStreamToBytes(source as ReadableStream<Uint8Array>)
    : (source as AsyncIterable<Uint8Array>);
}

/** The minimal socket surface the adapter needs — injected in unit tests (a real node:net Socket satisfies it). */
export interface ClamdSocketLike {
  write(data: Uint8Array): boolean;
  end(): void;
  destroy(): void;
  setTimeout(ms: number, cb: () => void): void;
  on(event: "data", cb: (chunk: Buffer) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "close", cb: () => void): void;
  once(event: "connect", cb: () => void): void;
}

export interface ClamdScannerOptions {
  host: string;
  port: number;
  /** Whole-scan deadline. Exceeded ⇒ verdict `error` (fail-closed), socket destroyed. */
  timeoutMs?: number;
  /** INSTREAM chunk size (clamd reads any size; 64 KiB keeps frames small). */
  chunkBytes?: number;
  /** Test seam: socket factory (prod = node:net connect). */
  createConnection?: (port: number, host: string) => ClamdSocketLike;
}

/**
 * The ClamAV clamd INSTREAM adapter. `real: true` — an `error` verdict from this adapter means a CONFIGURED
 * scanner failed, and every caller fails closed on it. Constant memory: the source streams through in
 * chunk-sized frames, never buffered whole.
 */
export function clamdScanner(opts: ClamdScannerOptions): MalwareScannerPort {
  const {
    host,
    port,
    timeoutMs = 60_000,
    chunkBytes = 64 * 1024,
    createConnection = (p, h) => netConnect(p, h) as unknown as ClamdSocketLike,
  } = opts;

  return {
    engine: "clamav",
    real: true,
    async scan(source): Promise<MalwareScanResult> {
      const scannedAt = new Date();
      try {
        const raw = await new Promise<string>((resolve, reject) => {
          let settled = false;
          const done = (fn: () => void) => {
            if (!settled) {
              settled = true;
              fn();
            }
          };
          let socket: ClamdSocketLike;
          try {
            socket = createConnection(port, host);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          const chunksIn: Buffer[] = [];
          socket.setTimeout(timeoutMs, () => {
            socket.destroy();
            done(() => reject(new Error("clamd: scan timed out")));
          });
          socket.on("error", (err) => {
            socket.destroy();
            done(() => reject(err));
          });
          socket.on("data", (chunk) => {
            chunksIn.push(chunk);
            // The z-reply is NUL-terminated — settle as soon as the terminator arrives.
            if (chunk.includes(0)) {
              done(() => resolve(Buffer.concat(chunksIn).toString("ascii")));
              socket.destroy();
            }
          });
          socket.on("close", () => {
            // Connection closed without a NUL — take whatever arrived (parse decides; empty ⇒ error).
            done(() => resolve(Buffer.concat(chunksIn).toString("ascii")));
          });

          // Pump the stream once connected: command → length-prefixed frames → zero terminator.
          socket.once("connect", () => {
            void (async () => {
              try {
                socket.write(INSTREAM_COMMAND);
                for await (const piece of toIterable(source)) {
                  for (let off = 0; off < piece.byteLength; off += chunkBytes) {
                    const frame = piece.subarray(off, Math.min(off + chunkBytes, piece.byteLength));
                    socket.write(instreamLengthPrefix(frame.byteLength));
                    socket.write(frame);
                  }
                }
                socket.write(INSTREAM_TERMINATOR);
              } catch (err) {
                socket.destroy();
                done(() => reject(err instanceof Error ? err : new Error(String(err))));
              }
            })();
          });
        });
        const parsed = parseClamdResponse(raw);
        return { ...parsed, engine: "clamav", scannedAt };
      } catch {
        // Connect refused / reset / timeout / source read failure — the engine is configured but did not
        // answer: FAIL-CLOSED (the caller refuses admission / retries the drive). Never `skipped`.
        return { verdict: "error", engine: "clamav", scannedAt };
      }
    },
  };
}
