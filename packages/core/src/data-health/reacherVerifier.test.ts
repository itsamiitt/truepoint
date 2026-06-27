// reacherVerifier.test.ts — the Reacher response→EmailStatus mapping, the graceful-degrade transport
// behaviour, and the hybrid (primary→secondary-on-non-decisive) composition. All offline (injected fetch).
import { describe, expect, test } from "bun:test";
import type { EmailStatus } from "@leadwolf/types";
import { hybridVerifier, passThroughVerifier, staticVerifier } from "./emailVerifier.ts";
import { type VerifierFetch, reacherStatusFrom, reacherVerifier } from "./reacherVerifier.ts";

const fixedFetch =
  (status: number, json: unknown): VerifierFetch =>
  async () => ({ status, json });

describe("reacherStatusFrom", () => {
  test("safe → valid", () => {
    expect(reacherStatusFrom({ is_reachable: "safe" }, "unverified")).toBe("valid");
  });
  test("invalid → invalid", () => {
    expect(reacherStatusFrom({ is_reachable: "invalid" }, "unverified")).toBe("invalid");
  });
  test("risky + catch-all → catch_all", () => {
    expect(
      reacherStatusFrom({ is_reachable: "risky", smtp: { is_catch_all: true } }, "unverified"),
    ).toBe("catch_all");
  });
  test("risky, not catch-all → risky", () => {
    expect(
      reacherStatusFrom({ is_reachable: "risky", smtp: { is_catch_all: false } }, "unverified"),
    ).toBe("risky");
  });
  test("unknown → unknown (a real determination, charged 0)", () => {
    expect(reacherStatusFrom({ is_reachable: "unknown" }, "valid")).toBe("unknown");
  });
  test("null payload → keeps current status", () => {
    expect(reacherStatusFrom(null, "valid")).toBe("valid");
  });
  test("missing is_reachable → keeps current status", () => {
    expect(reacherStatusFrom({}, "risky")).toBe("risky");
  });
});

describe("reacherVerifier", () => {
  test("maps a 200 response", async () => {
    const v = reacherVerifier({
      backendUrl: "http://reacher.test",
      fetchJson: fixedFetch(200, { is_reachable: "safe" }),
    });
    expect(await v.verify("a@b.com", "unverified")).toBe("valid");
  });
  test("non-2xx degrades to the stored status (verifier did not run)", async () => {
    const v = reacherVerifier({
      backendUrl: "http://reacher.test",
      fetchJson: fixedFetch(503, null),
    });
    expect(await v.verify("a@b.com", "valid")).toBe("valid");
  });
  test("a transport throw degrades to the stored status (never fails the reveal)", async () => {
    const v = reacherVerifier({
      backendUrl: "http://reacher.test",
      fetchJson: async () => {
        throw new Error("network down");
      },
    });
    expect(await v.verify("a@b.com", "unverified")).toBe("unverified");
  });
  test("posts to {base}/v0/check_email with a trailing slash stripped", async () => {
    let calledUrl = "";
    let body: unknown;
    const fj: VerifierFetch = async (url, init) => {
      calledUrl = url;
      body = init.body;
      return { status: 200, json: { is_reachable: "safe" } };
    };
    const v = reacherVerifier({ backendUrl: "http://reacher.test/", fetchJson: fj });
    await v.verify("a@b.com", "unverified");
    expect(calledUrl).toBe("http://reacher.test/v0/check_email");
    expect(body).toEqual({ to_email: "a@b.com" });
  });
});

describe("hybridVerifier", () => {
  test("a decisive primary short-circuits — secondary is never consulted", async () => {
    let secondaryCalls = 0;
    const secondary = {
      name: "secondary",
      verify: async (_email: string, s: EmailStatus): Promise<EmailStatus> => {
        secondaryCalls++;
        return s;
      },
    };
    const v = hybridVerifier(staticVerifier({ "a@b.com": "valid" }), secondary);
    expect(await v.verify("a@b.com", "unverified")).toBe("valid");
    expect(secondaryCalls).toBe(0);
  });
  test("a catch_all primary escalates and the secondary resolves it", async () => {
    const v = hybridVerifier(
      staticVerifier({ "a@b.com": "catch_all" }),
      staticVerifier({ "a@b.com": "valid" }),
    );
    expect(await v.verify("a@b.com", "unverified")).toBe("valid");
  });
  test("an unknown primary + a non-decisive secondary keeps the primary's status", async () => {
    const v = hybridVerifier(staticVerifier({ "a@b.com": "unknown" }), passThroughVerifier);
    expect(await v.verify("a@b.com", "unverified")).toBe("unknown");
  });
});
