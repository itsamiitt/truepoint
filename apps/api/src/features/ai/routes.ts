// routes.ts — HTTP wiring for AI NL→structured search (23 §3, ADR-0023, M14). Transport only: scope comes
// from the verified token (never the body, 09 §1), validation is Zod at the edge, and ALL logic lives in
// core (compileSearchQuery) behind the injected AiPort. The endpoint returns the VALIDATED filter (a
// contactQuery) for the user to CONFIRM before applying — it does NOT run the search or return results
// (human-in-the-loop, 23 §1). The per-tenant budget guard + prompt-injection guard run inside core.
//
// Why this endpoint never returns raw SQL / results: the AI only ever produces a `contactQuery` (ADR-0023);
// applying it is a SEPARATE, confirmed call to /search/contacts with the same validated shape.

import { env } from "@leadwolf/config";
import {
  AiBudgetExceededError,
  AiInputRejectedError,
  AiParseError,
  compileSearchQuery,
} from "@leadwolf/core";
import { aiRequestRepository } from "@leadwolf/db";
import {
  AiBudgetExhaustedError,
  type AiRequestOutcome,
  AiUnavailableError,
  ForbiddenError,
  ValidationError,
  aiSearchRequest,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";
import { getAiBudgetStore, getAiPort } from "./aiPortProvider.ts";

export const aiSearchRoutes = new Hono<{ Variables: RoleVariables }>();

aiSearchRoutes.use("*", authn);
aiSearchRoutes.use("*", tenancy);

/**
 * POST /ai-search — compile a natural-language query into a validated structured filter for confirmation.
 * Body = { text }. Returns { query: ContactQuery, notes?, usedRepair }. The caller previews `query`, then
 * applies it via the existing POST /search/contacts on confirm.
 */
aiSearchRoutes.post("/", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const tenantId = c.get("tenantId");
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to search.");

  const parsed = aiSearchRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Describe what you're looking for.");

  const startedAt = Date.now();
  let outcome: AiRequestOutcome = "ok";
  let usedRepair = false;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  try {
    const result = await compileSearchQuery({
      nl: parsed.data.text,
      tenantId,
      ai: getAiPort(),
      budgetStore: getAiBudgetStore(),
      dailyBudget: env.AI_NL_SEARCH_DAILY_BUDGET,
    });
    usedRepair = result.usedRepair;
    inputTokens = result.usage?.inputTokens ?? null;
    outputTokens = result.usage?.outputTokens ?? null;
    // Return ONLY the client-facing shape — `usage` is internal metering, not part of the /ai-search contract.
    return c.json({ query: result.query, notes: result.notes, usedRepair: result.usedRepair }, 200);
  } catch (err) {
    // Classify for the usage log, then map core's transport-agnostic errors onto RFC-9457 Problem Details
    // (09 §6). The model/prompt are never surfaced — only the stable code + a safe message.
    outcome =
      err instanceof AiInputRejectedError
        ? "rejected"
        : err instanceof AiBudgetExceededError
          ? "budget_exceeded"
          : err instanceof AiParseError
            ? err.reason === "ai_unavailable"
              ? "unavailable"
              : "invalid_output"
            : "error";
    if (err instanceof AiInputRejectedError) throw new ValidationError(err.message);
    if (err instanceof AiBudgetExceededError) {
      throw new AiBudgetExhaustedError(err.message);
    }
    if (err instanceof AiParseError) {
      throw new AiUnavailableError(
        err.reason === "ai_unavailable"
          ? "AI search is temporarily unavailable."
          : "Couldn't turn that into a search. Try rephrasing.",
      );
    }
    throw err;
  } finally {
    // Best-effort AI-usage metering (M14) — fire-and-forget so it never affects the response. The NL text is
    // NEVER logged, only call metadata (task/model/outcome/latency).
    void aiRequestRepository
      .create(
        { tenantId, workspaceId },
        {
          userId: c.get("claims").sub,
          task: "nl_search",
          model: env.AI_NL_SEARCH_MODEL,
          outcome,
          usedRepair,
          latencyMs: Date.now() - startedAt,
          inputTokens,
          outputTokens,
        },
      )
      .catch(() => {
        // metering must not break search
      });
  }
});
