import { describe, expect, test } from "bun:test";
import { type ReviewDeps, createReviewApp } from "../src/features/review/routes.ts";
import type { Capability } from "../src/middleware/capability.ts";

const MAKER = "00000000-0000-0000-0000-0000000000aa";
const CHECKER = "00000000-0000-0000-0000-0000000000bb";
const REQ_ID = "00000000-0000-0000-0000-000000000001";

function deps(caps: Capability[], over: Partial<ReviewDeps> = {}): ReviewDeps {
  return {
    resolveStaff: (c) => {
      const userId = c.req.header("x-staff");
      return userId ? { userId, capabilities: caps } : null;
    },
    promote: async () => ({ verifiedId: "v1", written: true }),
    // The persisted approval — the SERVER's maker + candidate, never the request body (P-01.10).
    loadApprovalRequest: async () => ({
      requestedByUserId: MAKER,
      status: "pending",
      candidate: { contentHash: "h1", entityKind: "person", fields: {}, confidence: 0.9 },
    }),
    ...over,
  };
}

// The body carries ONLY the id now — no maker, no candidate (those are loaded server-side).
const body = { approvalRequestId: REQ_ID };

const post = (d: ReviewDeps, b: unknown, headers: Record<string, string>) =>
  createReviewApp(d).request("/v1/review/approve", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(b),
  });

describe("review promotion (P5, four-eyes; P-01.10)", () => {
  test("no auth → 401", async () => {
    expect((await post(deps(["data:review"]), body, {})).status).toBe(401);
  });

  test("needs data:review → 403 with only data:read", async () => {
    expect((await post(deps(["data:read"]), body, { "x-staff": CHECKER })).status).toBe(403);
  });

  test("a different checker promotes → 200 (maker loaded server-side, not from the body)", async () => {
    const res = await post(deps(["data:review"]), body, { "x-staff": CHECKER });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ approved: 1 });
  });

  test("checker == the PERSISTED maker → four_eyes_violation 403 (cannot be spoofed via the body)", async () => {
    // The approver IS the maker recorded on the approval_request; nothing in the body can claim otherwise.
    const res = await post(deps(["data:review"]), body, { "x-staff": MAKER });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "four_eyes_violation" });
  });

  test("unknown approval request → 404", async () => {
    const d = deps(["data:review"], { loadApprovalRequest: async () => null });
    expect((await post(d, body, { "x-staff": CHECKER })).status).toBe(404);
  });

  test("a non-pending (already executed) request cannot be re-approved → 404", async () => {
    const d = deps(["data:review"], {
      loadApprovalRequest: async () => ({
        requestedByUserId: MAKER,
        status: "executed",
        candidate: { contentHash: "h1", entityKind: "person", fields: {}, confidence: 0.9 },
      }),
    });
    expect((await post(d, body, { "x-staff": CHECKER })).status).toBe(404);
  });
});
