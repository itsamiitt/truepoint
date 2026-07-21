import { describe, expect, test } from "bun:test";
import { type ReviewDeps, createReviewApp } from "../src/features/review/routes.ts";
import type { Capability } from "../src/middleware/capability.ts";

const MAKER = "00000000-0000-0000-0000-0000000000aa";
const CHECKER = "00000000-0000-0000-0000-0000000000bb";
const REQ_ID = "00000000-0000-0000-0000-000000000001";

function deps(caps: Capability[]): ReviewDeps {
  return {
    resolveStaff: (c) => {
      const userId = c.req.header("x-staff");
      return userId ? { userId, capabilities: caps } : null;
    },
    promote: async () => ({ verifiedId: "v1", written: true }),
  };
}

const goodBody = {
  approvalRequestId: REQ_ID,
  requestedByUserId: MAKER,
  candidates: [{ contentHash: "h1", entityKind: "person", fields: {}, confidence: 0.9 }],
};

const post = (d: ReviewDeps, body: unknown, headers: Record<string, string>) =>
  createReviewApp(d).request("/v1/review/approve", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("review promotion (P5, four-eyes)", () => {
  test("no auth → 401", async () => {
    expect((await post(deps(["data:review"]), goodBody, {})).status).toBe(401);
  });

  test("needs data:review → 403 with only data:read", async () => {
    expect((await post(deps(["data:read"]), goodBody, { "x-staff": CHECKER })).status).toBe(403);
  });

  test("a different checker promotes → 200", async () => {
    const res = await post(deps(["data:review"]), goodBody, { "x-staff": CHECKER });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ approved: 1 });
  });

  test("checker == maker → four_eyes_violation 403", async () => {
    const res = await post(deps(["data:review"]), goodBody, { "x-staff": MAKER });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "four_eyes_violation" });
  });
});
