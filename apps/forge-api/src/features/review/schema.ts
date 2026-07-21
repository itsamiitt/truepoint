// schema.ts — the review approval-request wire shape (Phase 5, four-eyes; 10 §5). Defined LOCALLY here because
// the Forge re-home only landed the medallion enums + envelope v2 into @leadwolf/types (packages/types/src/
// forge.ts) — the `approvePromotionRequest` Zod schema has no home there yet. This mirrors the original
// @forge/types definition verbatim so the route's validation contract is unchanged; fold it into
// @leadwolf/types when the promotion wire vocabulary is centralised.
import { z } from "zod";

export const promotionCandidateInput = z.object({
  contentHash: z.string().min(1),
  entityKind: z.enum(["person", "company"]),
  fields: z.unknown(),
  confidence: z.number().min(0).max(1),
  channels: z
    .object({ emailBlindIndex: z.string().optional(), phoneBlindIndex: z.string().optional() })
    .optional(),
});

export const approvePromotionRequest = z.object({
  approvalRequestId: z.string().uuid(),
  requestedByUserId: z.string().uuid(), // the maker — must differ from the deciding operator (four-eyes)
  candidates: z.array(promotionCandidateInput).min(1),
});
export type ApprovePromotionRequest = z.infer<typeof approvePromotionRequest>;
