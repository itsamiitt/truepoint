// review — the operator promotion path (Phase 5, 10 §5). A reviewer approves a candidate BY ID; the maker and the
// candidate (fields/confidence/channels) are loaded server-side from the persisted forge.approval_request the
// verify stage wrote (P-01.10) — never the request body. The write then runs the @leadwolf/forge-core four-eyes
// gate (approvePromotion: the checker must differ from the maker, and confidence must clear VERIFY_THRESHOLD)
// over an injected PromotionTx (promoteVerifiedRecord under withForgeTx in prod). This is the ONLY way a
// verified_records row + its sync_outbox event are written — the workers never self-approve. Capability-gated
// (data:review) server-side; the promote + load fns are injected so the four-eyes logic is unit-testable, no DB.
import {
  FourEyesViolationError,
  type PromotionCandidate,
  type PromotionTx,
  approvePromotion,
} from "@leadwolf/forge-core";
import { type Context, Hono } from "hono";
import { type ResolveStaff, hasCapability } from "../../middleware/capability.ts";
import { approvePromotionRequest } from "./schema.ts";

/** The persisted approval loaded server-side (P-01.10) — the maker + candidate the pipeline recorded, so the
 *  approver's request body can supply nothing but the id. */
export interface LoadedApprovalRequest {
  requestedByUserId: string;
  status: string;
  candidate: PromotionCandidate;
}

export interface ReviewDeps {
  resolveStaff: ResolveStaff;
  promote: PromotionTx["promote"];
  loadApprovalRequest: (id: string) => Promise<LoadedApprovalRequest | null>;
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

    // Load the maker + candidate from the persisted approval_request (P-01.10) — the body carries only the id.
    // The approver cannot forge the maker (to defeat checker≠maker), the confidence (to clear VERIFY_THRESHOLD),
    // or the fields (to promote arbitrary data): all of it is what the verify stage recorded server-side.
    const req = await deps.loadApprovalRequest(parsed.data.approvalRequestId);
    if (!req || req.status !== "pending") {
      return Response.json({ error: "approval_request_not_found" }, { status: 404 });
    }
    try {
      const result = await approvePromotion(
        { promote: deps.promote },
        {
          id: parsed.data.approvalRequestId,
          requestedByUserId: req.requestedByUserId,
          candidates: [req.candidate],
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
