// botCheck.test.ts — proves the Turnstile siteverify call is bounded and fails CLOSED (perf RC#11c). A hung
// Cloudflare endpoint must not stall sign-in: the 2.5s AbortController timeout aborts the fetch and the catch
// treats that exactly like any other failure (returns false) when a secret is configured.
//
// TURNSTILE_SECRET comes from the bun test preload (test/setup.ts), NOT from this file. It used to be assigned
// here at module scope, which only works when this happens to be the first file in the run to import
// @leadwolf/config — config freezes `env` from process.env on first import, so in a full-suite run the snapshot
// was already taken, verifyTurnstile took its "unconfigured → disabled" path, and every enforced-path
// expectation here inverted. It passed alone and failed together. Anything that must be in `env` before the
// freeze belongs in the preload.
import { afterEach, describe, expect, it } from "bun:test";

const { verifyTurnstile } = await import("./botCheck.ts");

const realFetch = globalThis.fetch;
// Swap in a stub fetch. Cast through unknown because Bun's `typeof fetch` carries extra members (preconnect).
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = impl as unknown as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("verifyTurnstile (secret configured → enforced)", () => {
  it("returns false for a missing token without making a network call", async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return new Response("{}");
    });
    expect(await verifyTurnstile(null)).toBe(false);
    expect(called).toBe(false);
  });

  it("returns true when Cloudflare reports success", async () => {
    stubFetch(async () => new Response(JSON.stringify({ success: true })));
    expect(await verifyTurnstile("good-token")).toBe(true);
  });

  it("returns false when Cloudflare reports failure", async () => {
    stubFetch(async () => new Response(JSON.stringify({ success: false })));
    expect(await verifyTurnstile("bad-token")).toBe(false);
  });

  it("fails CLOSED when the request is aborted by the timeout (hung Cloudflare)", async () => {
    // Honour the AbortSignal: reject with an AbortError the way fetch does, so we exercise the catch path.
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const result = await verifyTurnstile("hangs-forever");
    expect(result).toBe(false);
  });
});
