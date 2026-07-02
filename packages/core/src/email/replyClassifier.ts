// replyClassifier.ts — the OPT-IN AI reply-classification (Part C, owner decision #5). GATED per tenant by the
// dynamic feature flag reply_classification_enabled (default OFF; created per tenant in the admin feature-flag
// UI). When enabled, an inbound reply's PLAINTEXT body is classified by the injected ReplyClassifierPort
// (Anthropic — disclosed as a sub-processor), the call is METERED via ai_requests, and the refined label
// overrides the header heuristic in recordInboundReply. FAIL-OPEN to the heuristic: disabled / no key / any
// error → returns null so the caller keeps its heuristic classification. Core owns the port; integrations
// implements it (16 §5 direction).

import {
  type TenantScope,
  aiRequestRepository as defaultAiRequestRepository,
  withTenantTx,
} from "@leadwolf/db";
import { isFlagEnabledForTenant as defaultIsFlagEnabled } from "../featureFlags/flagsForTenant.ts";
import type { ReplyClassification } from "./detectAutoReply.ts";

/** The dynamic per-tenant opt-in flag (default off). Shared so api/core/workers never drift on the key. */
export const REPLY_CLASSIFICATION_FLAG_KEY = "reply_classification_enabled";

export interface ReplyClassifierResult {
  /** The refined classification (the AI only sharpens human vs auto/ooo; bounce stays the delivery path's). */
  classification: "human" | "auto_reply" | "ooo";
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** The classification seam — integrations supplies the Anthropic adapter; tests inject a fake. */
export interface ReplyClassifierPort {
  classify(text: string): Promise<ReplyClassifierResult>;
}

export interface ClassifyReplyDeps {
  port: ReplyClassifierPort;
  aiRequestRepository?: Pick<typeof defaultAiRequestRepository, "create">;
  isFlagEnabled?: typeof defaultIsFlagEnabled;
}

/**
 * Classify an inbound reply's body IF the tenant opted in. Returns the refined classification, or null to mean
 * "not classified — keep the heuristic" (opt-out, or a metered failure). Manages its own short transactions (the
 * flag check + the metering row) so the slow AI network call never holds a DB connection.
 */
export async function classifyReplyIfEnabled(
  scope: TenantScope & { workspaceId: string },
  params: { userId: string | null; bodyText: string },
  deps: ClassifyReplyDeps,
): Promise<ReplyClassification | null> {
  const isFlagEnabled = deps.isFlagEnabled ?? defaultIsFlagEnabled;
  const aiRepo = deps.aiRequestRepository ?? defaultAiRequestRepository;

  const enabled = await withTenantTx(scope, (tx) =>
    isFlagEnabled(tx, scope.tenantId, REPLY_CLASSIFICATION_FLAG_KEY),
  );
  if (!enabled) return null;

  const started = Date.now();
  try {
    const result = await deps.port.classify(params.bodyText);
    await aiRepo.create(scope, {
      userId: params.userId,
      task: "reply_classify",
      model: result.model,
      outcome: "ok",
      usedRepair: false,
      latencyMs: Date.now() - started,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
    return result.classification;
  } catch {
    // Metered even on failure (the tenant's call was attempted); fall back to the heuristic.
    await aiRepo
      .create(scope, {
        userId: params.userId,
        task: "reply_classify",
        model: null,
        outcome: "error",
        usedRepair: false,
        latencyMs: Date.now() - started,
      })
      .catch(() => {});
    return null;
  }
}
