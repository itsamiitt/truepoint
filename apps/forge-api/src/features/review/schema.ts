// schema.ts — the review approval-request wire shape (Phase 5, four-eyes; 10 §5). After P-01.10 the body carries
// ONLY the approval-request id: the maker + candidate (fields, confidence, channels) are loaded server-side from
// the persisted forge.approval_request the verify stage wrote, never trusted from the client — a client-supplied
// maker would defeat checker≠maker, a client-supplied confidence would clear VERIFY_THRESHOLD, and client-
// supplied fields would promote arbitrary data. Fold into @leadwolf/types when the wire vocabulary is centralised.
import { z } from "zod";

export const approvePromotionRequest = z.object({
  approvalRequestId: z.string().uuid(),
});
export type ApprovePromotionRequest = z.infer<typeof approvePromotionRequest>;
