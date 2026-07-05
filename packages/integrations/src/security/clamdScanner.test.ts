// clamdScanner.test.ts — CI-RUN unit tests for the Gate-C clamd adapter (S-S2/G08): the INSTREAM protocol
// FRAMING (4-byte big-endian length prefixes + zero terminator), the response PARSE (OK / EICAR-style
// `<sig> FOUND` / ERROR / garbage — unknown NEVER admits), and the socket lifecycle against a FAKE socket
// (no clamd in CI): clean flow, infected flow, connect-refused ⇒ 'error' (fail-closed), timeout ⇒ 'error'.
// The end-to-end EICAR run against a REAL sidecar is T-S3's itest, CI-owed with the scanner deployment.

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  type ClamdSocketLike,
  INSTREAM_COMMAND,
  INSTREAM_TERMINATOR,
  clamdScanner,
  instreamLengthPrefix,
  parseClamdResponse,
} from "./clamdScanner.ts";

// The EICAR test string (the industry-standard harmless detection fixture, 13 §2.3 / T-S3) and the
// signature name ClamAV reports for it.
const EICAR =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const EICAR_SIGNATURE = "Win.Test.EICAR_HDB-1";

describe("INSTREAM framing (pure)", () => {
  test("length prefix is 4-byte big-endian", () => {
    expect([...instreamLengthPrefix(0)]).toEqual([0, 0, 0, 0]);
    expect([...instreamLengthPrefix(1)]).toEqual([0, 0, 0, 1]);
    expect([...instreamLengthPrefix(0x01020304)]).toEqual([1, 2, 3, 4]);
    expect([...INSTREAM_TERMINATOR]).toEqual([0, 0, 0, 0]);
  });

  test("the command is the z-variant (NUL-terminated)", () => {
    expect(Buffer.from(INSTREAM_COMMAND).toString("ascii")).toBe("zINSTREAM\0");
  });
});

describe("clamd response parse (pure)", () => {
  test("stream: OK ⇒ clean", () => {
    expect(parseClamdResponse("stream: OK\0")).toEqual({ verdict: "clean" });
  });
  test("EICAR FOUND ⇒ infected with the signature name", () => {
    expect(parseClamdResponse(`stream: ${EICAR_SIGNATURE} FOUND\0`)).toEqual({
      verdict: "infected",
      signature: EICAR_SIGNATURE,
    });
  });
  test("ERROR / size-limit refusal ⇒ error (fail-closed, never admits)", () => {
    expect(parseClamdResponse("INSTREAM size limit exceeded. ERROR\0").verdict).toBe("error");
  });
  test("garbage / empty ⇒ error (unknown shapes never admit)", () => {
    expect(parseClamdResponse("").verdict).toBe("error");
    expect(parseClamdResponse("banana").verdict).toBe("error");
  });
});

/** A scriptable fake clamd socket: records writes; `reply` is sent after the zero-length terminator. */
class FakeClamdSocket extends EventEmitter implements ClamdSocketLike {
  readonly written: Buffer[] = [];
  destroyed = false;
  private timeoutMs = 0;
  private timeoutCb: (() => void) | null = null;
  constructor(private readonly reply: string | null) {
    super();
    queueMicrotask(() => this.emit("connect"));
  }
  write(data: Uint8Array): boolean {
    this.written.push(Buffer.from(data));
    // Detect the zero-length terminator frame → answer like clamd would.
    if (data.byteLength === 4 && Buffer.from(data).readUInt32BE(0) === 0 && this.written.length > 1) {
      if (this.reply !== null) queueMicrotask(() => this.emit("data", Buffer.from(`${this.reply}\0`, "ascii")));
      else queueMicrotask(() => this.emit("close"));
    }
    return true;
  }
  end(): void {}
  destroy(): void {
    this.destroyed = true;
  }
  setTimeout(ms: number, cb: () => void): void {
    this.timeoutMs = ms;
    this.timeoutCb = cb;
  }
  fireTimeout(): void {
    this.timeoutCb?.();
  }
}

function scannerWith(socket: ClamdSocketLike | (() => ClamdSocketLike)) {
  return clamdScanner({
    host: "127.0.0.1",
    port: 3310,
    timeoutMs: 1000,
    chunkBytes: 16, // tiny frames so multi-frame paths are exercised
    createConnection: typeof socket === "function" ? socket : () => socket,
  });
}

describe("clamdScanner (fake socket)", () => {
  test("clean file: frames the bytes, terminates, parses OK — verdict clean", async () => {
    const sock = new FakeClamdSocket("stream: OK");
    const result = await scannerWith(sock).scan(new TextEncoder().encode("email,name\r\n"));
    expect(result.verdict).toBe("clean");
    expect(result.engine).toBe("clamav");
    // Protocol shape: command, then (len,data)+, then the zero terminator.
    expect(Buffer.from(sock.written[0]!).toString("ascii")).toBe("zINSTREAM\0");
    const last = sock.written.at(-1)!;
    expect(last.readUInt32BE(0)).toBe(0);
    // Every data frame is preceded by its exact big-endian length.
    expect(sock.written[1]!.readUInt32BE(0)).toBe(sock.written[2]!.byteLength);
  });

  test("EICAR: verdict infected with the engine's signature name", async () => {
    const sock = new FakeClamdSocket(`stream: ${EICAR_SIGNATURE} FOUND`);
    const result = await scannerWith(sock).scan(new TextEncoder().encode(EICAR));
    expect(result.verdict).toBe("infected");
    expect(result.signature).toBe(EICAR_SIGNATURE);
  });

  test("a large source is split into chunk-sized frames", async () => {
    const sock = new FakeClamdSocket("stream: OK");
    const bytes = new Uint8Array(40); // chunkBytes=16 ⇒ 3 data frames (16+16+8)
    await scannerWith(sock).scan(bytes);
    const dataFrames = sock.written.filter((_, i) => i > 0 && i % 2 === 0); // len,data pairs after cmd
    expect(dataFrames.map((f) => f.byteLength)).toEqual([16, 16, 8]);
  });

  test("FAIL-CLOSED: connect refused ⇒ verdict 'error' (never clean, never skipped)", async () => {
    const scanner = scannerWith(() => {
      throw new Error("ECONNREFUSED");
    });
    const result = await scanner.scan(new Uint8Array([1, 2, 3]));
    expect(result.verdict).toBe("error");
    expect(scanner.real).toBe(true); // a REAL engine erroring is what the callers fail closed on
  });

  test("FAIL-CLOSED: socket error mid-stream ⇒ verdict 'error'", async () => {
    class ErroringSocket extends FakeClamdSocket {
      override write(data: Uint8Array): boolean {
        super.write(data);
        if (this.written.length === 2) queueMicrotask(() => this.emit("error", new Error("reset")));
        return true;
      }
    }
    const result = await scannerWith(new ErroringSocket(null)).scan(new Uint8Array(64));
    expect(result.verdict).toBe("error");
  });

  test("FAIL-CLOSED: timeout ⇒ verdict 'error' and the socket is destroyed", async () => {
    // A socket that never answers: the scan settles only via the timeout callback.
    class SilentSocket extends FakeClamdSocket {
      override write(data: Uint8Array): boolean {
        this.written.push(Buffer.from(data));
        if (data.byteLength === 4 && Buffer.from(data).readUInt32BE(0) === 0 && this.written.length > 1) {
          queueMicrotask(() => this.fireTimeout());
        }
        return true;
      }
    }
    const sock = new SilentSocket(null);
    const result = await scannerWith(sock).scan(new Uint8Array([1]));
    expect(result.verdict).toBe("error");
    expect(sock.destroyed).toBe(true);
  });

  test("close without a reply ⇒ verdict 'error' (empty parse never admits)", async () => {
    const sock = new FakeClamdSocket(null); // emits 'close' instead of data
    const result = await scannerWith(sock).scan(new Uint8Array([1]));
    expect(result.verdict).toBe("error");
  });
});
