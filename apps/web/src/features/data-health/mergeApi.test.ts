// mergeApi.test.ts — unit coverage for the merge-review decision builder (S-U8). The IRREVERSIBLE merge sends
// only the LOSER overrides (survivor-wins is the server default, 04 §3.2), and a PINNED survivor field is
// structurally unoverwritable (DM6) — the builder must NEVER emit a loser decision for it, mirroring what
// planFieldWrite enforces server-side. These edges are pinned here so a regression surfaces in CI, not in a
// merge that silently ignored a pin.

import { describe, expect, test } from "bun:test";
import { buildMergeDecisions } from "./mergeDecisions.ts";

const fields: { field: "firstName" | "lastName" | "jobTitle"; survivorPinned: boolean }[] = [
  { field: "firstName", survivorPinned: false },
  { field: "lastName", survivorPinned: true },
  { field: "jobTitle", survivorPinned: false },
];

describe("buildMergeDecisions", () => {
  test("emits nothing when every field keeps the survivor default", () => {
    expect(buildMergeDecisions(fields, {})).toEqual([]);
    expect(buildMergeDecisions(fields, { firstName: "survivor", jobTitle: "survivor" })).toEqual([]);
  });

  test("emits only the loser overrides", () => {
    expect(buildMergeDecisions(fields, { firstName: "loser", jobTitle: "survivor" })).toEqual([
      { field: "firstName", winner: "loser" },
    ]);
  });

  test("never emits a loser decision for a pinned survivor field (DM6)", () => {
    expect(buildMergeDecisions(fields, { lastName: "loser" })).toEqual([]);
    // A pinned pick is dropped even alongside a valid unpinned override.
    expect(buildMergeDecisions(fields, { lastName: "loser", jobTitle: "loser" })).toEqual([
      { field: "jobTitle", winner: "loser" },
    ]);
  });
});
