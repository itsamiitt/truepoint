// master-sync — POST /api/v1/master-sync (docs/planning/forge/11, ADR-0047). The one-way ingress that lands
// TruePoint Forge's governed verified records into the master_* graph. Machine-only (syncPrincipal, not the
// human chain). Per-item PARTIAL SUCCESS: each item is applied in its OWN withErTx (effectively-once via
// forgeSyncRepository), so one poison item is `rejected` without blocking the batch. Version is negotiated on
// X-Forge-Sync-Version; an unsupported version halts with 409 (never silently drops golden records).
import { forgeSyncRepository, withErTx } from "@leadwolf/db";
import { type MasterSyncItemResult, masterSyncRequest } from "@leadwolf/types";
import { Hono } from "hono";
import { type SyncPrincipalVariables, syncPrincipal } from "../../middleware/syncPrincipal.ts";

const SUPPORTED_VERSIONS = ["1-0-0"];

export const masterSyncRoutes = new Hono<{ Variables: SyncPrincipalVariables }>();
masterSyncRoutes.use("*", syncPrincipal);

masterSyncRoutes.post("/", async (c) => {
  const version = c.req.header("x-forge-sync-version") ?? "1-0-0";
  if (!SUPPORTED_VERSIONS.includes(version)) {
    return c.json({ type: "about:blank", title: "unsupported_sync_version", detail: version }, 409);
  }

  const parsed = masterSyncRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { type: "about:blank", title: "invalid_request", detail: parsed.error.issues[0]?.message },
      400,
    );
  }
  const { items, syncVersion, batchId } = parsed.data;

  const results: MasterSyncItemResult[] = [];
  for (const item of items) {
    try {
      // each item in its OWN tx → a poison item does not roll back the good ones (partial success).
      const applied = await withErTx((tx) =>
        forgeSyncRepository.applyItem(tx, {
          eventId: item.eventId,
          eventType: item.eventType,
          version: item.version,
          contentHash: item.contentHash,
          payload: item.payload,
        }),
      );
      results.push({ eventId: item.eventId, outcome: applied.outcome, masterId: applied.masterId });
    } catch (err) {
      results.push({
        eventId: item.eventId,
        outcome: "rejected",
        problem: {
          type: "about:blank",
          title: "apply_failed",
          detail: err instanceof Error ? err.message : "unknown",
        },
      });
    }
  }

  return c.json({ syncVersion, batchId, results }, 200);
});
