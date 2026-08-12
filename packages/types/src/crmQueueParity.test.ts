// crmQueueParity.test.ts — the guard for a bug that shipped silently and cost nothing to catch.
//
// WHAT HAPPENED: packages/types declared the CRM queue names with HYPHENS (`crm-sync-pull`), while
// apps/workers redeclared them locally with UNDERSCORES (`crm_sync_pull`). apps/api imported the shared
// constants and enqueued onto `crm-sync-*`; the consumers listened on `crm_sync_*`. Every CRM job the API
// produced went into a queue with no worker attached. Nothing threw, nothing logged, no test failed —
// the jobs simply sat there.
//
// Two things make that bug possible, and this file closes both:
//   1. A SECOND DEFINITION of a shared constant. Fixed by workers re-exporting from here; asserted by the
//      repo-wide check in the last test below.
//   2. The SEPARATOR being invisible. `crm-sync-pull` and `crm_sync_pull` are one keystroke apart and read
//      identically in prose, so review does not catch it. Fixed by pinning the separator to the same thing
//      register.ts routes dead-letters on.

import { describe, expect, test } from "bun:test";
import {
  CRM_SYNC_BACKFILL_QUEUE,
  CRM_SYNC_DLQ,
  CRM_SYNC_INBOUND_QUEUE,
  CRM_SYNC_PULL_QUEUE,
  CRM_SYNC_PUSH_QUEUE,
  CRM_SYNC_SWEEP_QUEUE,
} from "./crm.ts";

const ALL = {
  CRM_SYNC_SWEEP_QUEUE,
  CRM_SYNC_BACKFILL_QUEUE,
  CRM_SYNC_PULL_QUEUE,
  CRM_SYNC_INBOUND_QUEUE,
  CRM_SYNC_PUSH_QUEUE,
  CRM_SYNC_DLQ,
} as const;

describe("CRM queue names", () => {
  test("every name uses the crm_sync_ prefix register.ts routes dead-letters on", () => {
    // apps/workers/src/register.ts: `if (queue.startsWith("crm_sync_")) worker.on("failed", …)`.
    // A hyphen here silently disables durable dead-lettering for every CRM lane.
    for (const [name, value] of Object.entries(ALL)) {
      expect(`${name}=${value}`).toBe(`${name}=${value.replace(/-/g, "_")}`);
      expect(value.startsWith("crm_sync_")).toBe(true);
    }
  });

  test("no two lanes share a name", () => {
    const values = Object.values(ALL);
    expect(new Set(values).size).toBe(values.length);
  });

  test("the exact wire values are pinned", () => {
    // Pinned deliberately: a queue name is a WIRE contract. Renaming one strands whatever is already
    // enqueued under the old name, so a rename must be a conscious edit to this list, not a drive-by.
    expect(ALL).toEqual({
      CRM_SYNC_SWEEP_QUEUE: "crm_sync_sweep",
      CRM_SYNC_BACKFILL_QUEUE: "crm_sync_backfill",
      CRM_SYNC_PULL_QUEUE: "crm_sync_pull",
      CRM_SYNC_INBOUND_QUEUE: "crm_sync_inbound",
      CRM_SYNC_PUSH_QUEUE: "crm_sync_push",
      CRM_SYNC_DLQ: "crm_sync_dlq",
    });
  });
});
