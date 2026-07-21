// review — the operator promotion path (Phase 5, 10 §5). A reviewer approves a candidate; the write runs the
// @leadwolf/forge-core four-eyes gate (approvePromotion: the checker must differ from the maker, and confidence
// must clear VERIFY_THRESHOLD) over an injected PromotionTx (promoteVerifiedRecord under withForgeTx in prod).
// This is the ONLY way a verified_records row + its sync_outbox event are written — the workers never
// self-approve. Capability-gated (data:review) server-side; the promote fn is injected so the four-eyes logic
// is unit-testable with no DB.
import { FourEyesViolationError, type PromotionTx, approvePromotion } from "@leadwolf/forge-core";
import { type Context, Hono } from "hono";
import { type ResolveStaff, hasCapability } from "../../middleware/capability.ts";
import { approvePromotionRequest } from "./schema.ts";

export interface ReviewDeps {
  resolveStaff: ResolveStaff;
  promote: PromotionTx["promote"];
}

export function createReviewApp(deps: ReviewDeps): Hono {
  const app = new Hono();

  app.post("/v1/review/approve", async (c: Context): Promise<Response> => {
    const staff = await deps.resolveStaff(c);
    if (!staff) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!hasCapability(staff, "data:review")) {
      return Response.json({ error: "forbidden", capability: "data:review" }, { status: 403 });
    }
    const parsed = approvePromotionRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    try {
      const result = await approvePromotion(
        { promote: deps.promote },
        {
          id: parsed.data.approvalRequestId,
          requestedByUserId: parsed.data.requestedByUserId,
          // z.unknown() types `fields` as optional; normalize it to always-present for PromotionCandidate.
          candidates: parsed.data.candidates.map((cand) => ({
            ...cand,
            fields: cand.fields ?? null,
          })),
        },
        staff.userId,
      );
      return Response.json(result, { status: 200 });
    } catch (err) {
      if (err instanceof FourEyesViolationError) {
        return Response.json({ error: "four_eyes_violation" }, { status: 403 });
      }
      throw err;
    }
  });

  return app;
}
