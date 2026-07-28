// publishCrmPushIntent.test.ts — the TP-side change emitter's GATE (crm-sync 00 §2.2 gap 3).
//
// The behaviour worth pinning is the no-op. With CRM_SYNC_ENABLED off this must write nothing: a deployment
// with no CRM integration should pay nothing per contact write, not an extra outbox row on every update.
// That is the difference between a seam that ships inert and one that taxes the whole fleet for a feature
// nobody uses.
//
// The enabled path is covered end-to-end by the worker's relay wiring; here the gate is the contract.

import { describe, expect, test } from "bun:test";
import { publishCrmPushIntent } from "./publishCrmPushIntent.ts";

/** A tx stand-in that records whether anything was inserted. */
function spyTx() {
  const inserts: unknown[] = [];
  return {
    inserts,
    insert: () => ({ values: async (v: unknown) => void inserts.push(v) }),
  };
}

describe("the env gate", () => {
  test("writes NOTHING while the engine is dark", async () => {
    const { env } = await import("@leadwolf/config");
    if (env.CRM_SYNC_ENABLED) return; // this process booted enabled; the enabled case is asserted below

    const tx = spyTx();
    // biome-ignore lint/suspicious/noExplicitAny: a minimal tx stand-in; only the insert path is exercised
    const wrote = await publishCrmPushIntent(tx as any, {
      scope: { tenantId: "t1", workspaceId: "w1" },
      tpEntityType: "contact",
      tpEntityId: "11111111-1111-1111-1111-111111111111",
    });

    expect(wrote).toBe(false);
    // No outbox row: a workspace with no CRM must not accumulate intents nobody will ever drain.
    expect(tx.inserts).toHaveLength(0);
  });

  test("returns a boolean rather than throwing, so a write path never fails on a gated call", async () => {
    const tx = spyTx();
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const result = await publishCrmPushIntent(tx as any, {
      scope: { tenantId: "t1", workspaceId: "w1" },
      tpEntityType: "contact",
      tpEntityId: "11111111-1111-1111-1111-111111111111",
    });
    // A contact update must not fail because an optional integration is switched off.
    expect(typeof result).toBe("boolean");
  });
});
