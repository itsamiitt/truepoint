// rawClientRatchet.test.ts — the set of repositories that use the RAW client may not grow silently.
//
// WHAT THIS IS ABOUT. Repositories normally take a `tx` from a seam — `withTenantTx`, `withReplicaTx`,
// `withErTx`, `withForgeTx`, `withPlatformTx`, `withPrivilegedTx`, `withSystemTx` — and the seam is what sets
// the RLS GUCs for the query. A repository that reaches for the module-level `db` client instead runs on a
// connection with no tenant set: either it fails closed, or, on the owner connection, RLS does not apply at
// all and the query sees every tenant's rows.
//
// Audit 32 §6.4 counted ~40 such call sites across 18 repositories. Some are DELIBERATE and documented at the
// call site — the retention purge carries an explicit tenant predicate and writes `retention_runs`; the
// scheduler takes a 60-second lease; partition maintenance is DDL with no tenant at all; `userRepository` and
// `workspaceRepository` are pre-tenant reads the auth service makes before any GUC exists. Fixing the list is
// a real project with real judgement in it.
//
// WHAT THIS TEST DOES INSTEAD is stop it growing while nobody is looking. Adding a raw-client query to a NEW
// repository is currently invisible — no gate, no review signal, and the query works fine in development where
// there is one tenant. That is the moment worth catching, and it costs one line here to make it a conscious
// act rather than an accident. Same shape as `migrationSnapshots.test.ts`'s EXPECTED_DEFICIT: pin the known
// number, let it fall, never let it rise by inattention.
//
// IF YOU ARE HERE BECAUSE THIS FAILED: your new repository is doing raw `db.` access. Route it through the
// seam that matches its plane. If it genuinely cannot — a pre-tenant read, DDL, a documented cross-tenant
// sweep — add it below WITH the reason, the way the existing entries carry theirs.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_DIR = join(import.meta.dir, "repositories");

/**
 * Repositories known to use the module-level client, generated from the regex below rather than by hand.
 *
 * The count is 25, not the ~18 audit 32 §6.4 reported. That is not drift — it is that the audit's grep looked
 * for `db.` on one line, and a chained call broken across lines (`= db
  .select(...)`) is the same bypass
 * written differently. Anything counting these has to match the multi-line form or it undercounts by a third.
 * Entries carrying a note are the ones whose reason is stated at their own call site.
 */
const RAW_CLIENT_REPOSITORIES: ReadonlySet<string> = new Set([
  "accountChildRepository.ts",
  "accountScoreRepository.ts", // SYSTEM census (ids only) — the jobChangeSweepRepository twin, MI-S4
  "announcementRepository.ts",
  "contactChannelRepository.ts",
  "contactRepository.ts",
  "creditRepository.ts",
  "crmConnectionRepository.ts",
  "crmFieldMappingRepository.ts",
  "crmHealthRepository.ts",
  "crmOauthStateRepository.ts",
  "dsarRepository.ts", // erasure fan-out — cross-tenant by design, audited
  "idempotencyRepository.ts",
  "impersonationRepository.ts",
  "importJobRepository.ts",
  "jobChangeSweepRepository.ts",
  "mailboxRepository.ts",
  "marketRollupRepository.ts", // owner-conn cache rebuild — keeps leadwolf_er never-DELETE (0130 header)
  "signalFanoutRepository.ts", // SYSTEM census (ids only) — the C-02 boundary, MI-S6
  "oauthConnectStateRepository.ts",
  "outboxRepository.ts",
  "partitionRepository.ts", // DDL; partitions have no tenant
  "platformStaffRepository.ts", // staff authz lookup, pre-tenant by nature
  "retentionScanRepository.ts", // explicit tenant predicate + retention_runs audit row
  "scheduledImportRepository.ts",
  "schedulerRepository.ts", // 60-second lease, not a privileged read
  "userRepository.ts", // PRE-tenant: the auth service reads identity before any GUC exists
  "webauthnCredentialRepository.ts",
  "workspaceRepository.ts", // pre-tenant membership graph (listForUser, getTenantStatus)
]);

/** `db.` used as a query root — not `tx.`, and not the word "db" inside an identifier. */
const RAW_USE = /(?:await|return|=)\s+db\s*\./;

function repositoriesUsingRawClient(): string[] {
  // EVERY .ts in the directory, not just *Repository.ts. The first version filtered on that suffix and missed
  // a planted raw-client call in `listCaps.ts` — data access does not have to be in a file whose name says so,
  // and a helper beside the repositories is exactly where an unnoticed one would live.
  return readdirSync(REPO_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => RAW_USE.test(readFileSync(join(REPO_DIR, f), "utf8")))
    .sort();
}

describe("raw-client usage in repositories", () => {
  test("the scan finds repositories at all (guards against matching nothing)", () => {
    // A negative assertion on an empty list is the classic vacuous guard; this is the floor that prevents it.
    expect(readdirSync(REPO_DIR).filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(80);
    expect(repositoriesUsingRawClient().length).toBeGreaterThan(10);
  });

  test("no NEW repository has started using the raw client", () => {
    const unexpected = repositoriesUsingRawClient().filter((f) => !RAW_CLIENT_REPOSITORIES.has(f));
    expect(unexpected).toEqual([]);
  });

  test("the ratchet only turns one way", () => {
    // If a repository is refactored onto a seam, DELETE it from the set above — that is the ratchet tightening
    // and it should be a visible, celebrated diff. This assertion catches a stale entry so the list cannot
    // quietly overstate the problem either.
    const actual = new Set(repositoriesUsingRawClient());
    const stale = [...RAW_CLIENT_REPOSITORIES].filter((f) => !actual.has(f));
    expect(stale).toEqual([]);
  });
});
