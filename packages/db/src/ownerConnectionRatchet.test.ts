// ownerConnectionRatchet.test.ts — the raw owner connection inside repositories, counted so it can only shrink.
//
// `db` (client.ts:179) is the OWNER handle. It is not `leadwolf_app`, so **RLS does not apply to it**: a query
// written against `db` sees every tenant's rows regardless of policy. The tenancy seams — `withTenantTx`,
// `withReplicaTx`, `withPrivilegedTx`, `withErTx`, `withForgeTx`, `withPlatformTx` — exist so that access is
// scoped by the database rather than by whoever wrote the WHERE clause.
//
// Some owner use is correct and always will be: platform-owned tables the app role is REVOKE'd from, the
// migration/bootstrap paths, and the auth spine (session create/rotate/validate deliberately runs as owner —
// see docs/planning/audits/identity-grant-posture.md §3b, where that fact is what keeps the login path out of
// the blast radius of any grant change). This file does not try to judge which is which; a static scan cannot.
//
// WHAT IT DOES is stop the number growing unnoticed, because it already has. Audit 32 §9.3-2 counted
// "~40 raw-owner-connection call sites inside 18 repositories" and recommended migrating the sweeps and then
// un-exporting the raw handle, calling it "the root enabler". Nothing ratcheted it, and on 2026-08-22 the
// count was **49 across 20 repositories** — up roughly nine sites and two repositories since the audit was
// written. That drift is the whole argument for this file: the finding was recorded, agreed, and then
// quietly got worse, because a number in a document does not resist anything.
//
// Adding a call site is not forbidden — it is made deliberate. Raise OWNER_CALL_BUDGET and say why, the way
// migrationSnapshots.test.ts requires for the snapshot deficit. Lower it whenever a call site moves onto a
// seam, which is the direction the audit actually wants.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Measured 2026-08-22. Down = good; up = a conscious decision that needs a sentence next to it. */
const OWNER_CALL_BUDGET = 49;

const REPOSITORIES_DIR = join(import.meta.dir, "repositories");

/**
 * Query calls on the OWNER handle.
 *
 * `\bdb\.` deliberately does not match `appDb.`, `replicaDb.`, `forgeDb.` or `platformDb.` — those are the
 * pool-bound handles the seams use, and they are case-distinct (`Db.`) as well as boundary-distinct. `tx.`
 * is not matched either: a `tx` IS the seam, which is the whole point.
 */
const OWNER_QUERY = /\bdb\.(select|insert|update|delete|execute|transaction)\b/g;

function repositoryFiles(): string[] {
  return readdirSync(REPOSITORIES_DIR)
    .filter((f) => f.endsWith(".ts") && !f.includes(".test.") && !f.includes(".itest."))
    .sort();
}

function countByFile(): Array<[string, number]> {
  const rows: Array<[string, number]> = [];
  for (const file of repositoryFiles()) {
    const source = readFileSync(join(REPOSITORIES_DIR, file), "utf8");
    const n = (source.match(OWNER_QUERY) ?? []).length;
    if (n > 0) rows.push([file, n]);
  }
  return rows;
}

function totalOwnerCalls(): number {
  return countByFile().reduce((sum, [, n]) => sum + n, 0);
}

describe("raw owner-connection use in repositories", () => {
  test("the count does not grow", () => {
    // If this fails you added a query on the owner handle inside a repository. That query is NOT RLS-scoped.
    // Move it onto a seam (withTenantTx and friends), or — if owner really is correct here, as it is for
    // platform-owned tables and the auth spine — raise the budget below and write down which case it is.
    expect(totalOwnerCalls()).toBeLessThanOrEqual(OWNER_CALL_BUDGET);
  });

  test("OWNER_CALL_BUDGET is honest — tighten it whenever a call site moves onto a seam", () => {
    expect(totalOwnerCalls()).toBe(OWNER_CALL_BUDGET);
  });

  test("the scan finds the known concentrations (a silent zero would pass forever)", () => {
    const byFile = new Map(countByFile());
    expect(byFile.size).toBeGreaterThan(10);
    // The two heaviest when written. Named so that a regex that stopped matching shows up as a failure here
    // rather than as a suspiciously easy win on the budget above.
    expect(byFile.get("userRepository.ts")).toBeGreaterThan(0);
    expect(byFile.get("importJobRepository.ts")).toBeGreaterThan(0);
  });

  test("the seam handles are not counted as owner use", () => {
    // Guards the pattern itself: if `\bdb\.` ever started matching `appDb.select`, the count would jump and
    // the budget would be raised to absorb a false positive — the worst outcome available here.
    const seams = "appDb.select(); replicaDb.insert(); forgeDb.update(); tx.select();";
    expect(seams.match(OWNER_QUERY)).toBeNull();
    expect("db.select()".match(OWNER_QUERY)?.length).toBe(1);
  });
});
