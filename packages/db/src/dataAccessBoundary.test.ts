// dataAccessBoundary.test.ts — only packages/db may talk to the database. Static, DB-free.
//
// THE RULE. CLAUDE.md: "Repositories in `packages/db/src/repositories/` are the ONLY data-access layer."
// A `drizzle-orm` or `postgres` import anywhere else is a query that skipped the tenancy seams
// (`withTenantTx` / `withReplicaTx` / `withPrivilegedTx` / `withErTx` / `withForgeTx` / `withPlatformTx` /
// `withSystemTx`). Those seams are what SET the RLS GUCs, so a raw connection either fails closed with no
// tenant, or — on an owner connection — has no RLS at all and reads every tenant's rows.
//
// WHY A TEST AND NOT A dependency-cruiser RULE. That was the obvious home and it does not work: this repo
// installs through bun's `node_modules/.bun/` layout and dependency-cruiser records NO npm dependency for
// `drizzle-orm` at all — cruising packages/db/src/client.ts, which imports it directly, returns only the local
// and workspace edges. A rule written there is unfireable, and an unfireable rule is worse than none: it reads
// as coverage in a config file full of real rules. Verified before abandoning it, not assumed.
//
// ITESTS ARE EXEMPT, deliberately. packages/db/test/*.itest.ts and apps/workers/test/*.itest.ts open raw
// `postgres` connections on purpose — that is how they prove RLS blocks a foreign tenant, and going through a
// repository would prove nothing about the wall.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");

/** Source files under `roots`, excluding tests and build output. */
function sourceFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // a root that does not exist is not a failure
    }
    for (const name of entries) {
      if (name === "node_modules" || name === "dist" || name === ".next") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      if (/\.(test|itest)\.tsx?$/.test(name)) continue; // see the header: itests may hold raw connections
      out.push(p);
    }
  };
  for (const r of roots) walk(join(REPO_ROOT, r));
  return out;
}

const DB_CLIENTS = /from\s+"(drizzle-orm[^"]*|postgres)"/;

describe("only packages/db reaches the database", () => {
  test("the scan actually reads files (guards against matching nothing)", () => {
    // Without this floor, a wrong REPO_ROOT makes every assertion below pass on an empty list — the exact
    // way a static guard rots into decoration.
    expect(sourceFiles(["apps", "packages"]).length).toBeGreaterThan(800);
  });

  test("packages/db itself does import the ORM (positive control)", () => {
    const inDb = sourceFiles(["packages/db"]).filter((f) =>
      DB_CLIENTS.test(readFileSync(f, "utf8")),
    );
    // If this ever hits zero the regex has stopped matching and the whole file is vacuous.
    expect(inDb.length).toBeGreaterThan(50);
  });

  test("no app or non-db package imports drizzle-orm or postgres", () => {
    const roots = ["apps", "packages"];
    const offenders = sourceFiles(roots)
      .filter((f) => !f.replace(/\\/g, "/").includes("/packages/db/"))
      .filter((f) => DB_CLIENTS.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(/\\/g, "/").replace(`${REPO_ROOT.replace(/\\/g, "/")}/`, ""));

    // If this fails: move the query into a repository under packages/db/src/repositories/ and call it through
    // the seam that matches its plane. A raw client here bypasses the RLS GUCs entirely.
    expect(offenders).toEqual([]);
  });
});
