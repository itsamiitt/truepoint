// migrationSnapshots.test.ts — a RATCHET on the drizzle snapshot chain (part of P-1.7).
//
// The chain is broken: there are 29 snapshots in meta/ against 83 journal entries. drizzle-kit derives the
// next migration by diffing the schema against the newest snapshot, so a chain with 54 missing links makes
// `generate` produce wrong output — and, worse, produce it silently. That is the real cost: not that the
// files are missing, but that the tool cannot tell you they are.
//
// Repairing it (stitching the snapshots until `generate` reports no further diff) is the actual P-1.7 work
// and is not done here. What IS done is stopping the gap from growing. Every hand-authored migration added
// without a snapshot widens the deficit and makes the eventual repair harder, and nothing currently notices.
//
// So this pins the deficit at its known value. Adding a migration without a snapshot fails this test, which
// is the signal to either add the snapshot or make the widening a conscious decision. When the chain is
// repaired, set EXPECTED_DEFICIT to 0 and this becomes the equality assertion P-1.7 asks CI for.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const META_DIR = join(import.meta.dir, "migrations", "meta");

/** The historical gap (P-1.7): 84 journal entries, 30 snapshots. NOT a target — a ceiling that must never
 *  rise. The chain has been REBASELINED (migration 0083 carries a snapshot derived from the current schema,
 *  so `generate` diffs correctly and reports no changes), but the 54 missing HISTORICAL snapshots are not
 *  restored and point-in-time diffing before 0083 remains impossible. That is acceptable — the chain is only
 *  consumed forward — and this constant keeps the gap from widening again. */
const EXPECTED_DEFICIT = 54;

function journalEntryCount(): number {
  const journal = JSON.parse(readFileSync(join(META_DIR, "_journal.json"), "utf8")) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

function snapshotCount(): number {
  return readdirSync(META_DIR).filter((f) => f.endsWith("_snapshot.json")).length;
}

describe("drizzle snapshot chain", () => {
  test("the snapshot deficit does not grow (P-1.7 ratchet)", () => {
    // A hand-authored migration added without a snapshot widens the break silently. This is the only thing
    // that notices.
    const deficit = journalEntryCount() - snapshotCount();
    expect(deficit).toBeLessThanOrEqual(EXPECTED_DEFICIT);
  });

  test("EXPECTED_DEFICIT is honest — tighten it whenever the gap shrinks", () => {
    // A ratchet that is never tightened stops being a ratchet. If snapshots get stitched back in and this
    // constant is left stale, the guard silently loosens by exactly the amount that was repaired.
    const deficit = journalEntryCount() - snapshotCount();
    expect(deficit).toBe(EXPECTED_DEFICIT);
  });

  test("every journal entry has a tag and they are unique", () => {
    // Identity is journal ORDER + the file's sha256, so a duplicate tag is not fatal to the migrator — but it
    // makes the chain unreadable to a human and is how the duplicate 0053_* pair P-1.7 mentions arose.
    const journal = JSON.parse(readFileSync(join(META_DIR, "_journal.json"), "utf8")) as {
      entries: Array<{ tag?: string }>;
    };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
    expect(new Set(tags).size).toBe(tags.length);
  });

  test("journal idx values are strictly increasing (the order the migrator replays)", () => {
    const journal = JSON.parse(readFileSync(join(META_DIR, "_journal.json"), "utf8")) as {
      entries: Array<{ idx: number }>;
    };
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]?.idx ?? -1;
      const cur = journal.entries[i]?.idx ?? -1;
      expect(cur).toBeGreaterThan(prev);
    }
  });
});
