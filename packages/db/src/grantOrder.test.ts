// grantOrder.test.ts — two invariants in applyMigrations' grant block that are load-bearing, documented, and
// were until now enforced only by a comment. Static and DB-free.
//
// 1. THE PARTITION-ACL MIRROR MUST BE LAST. Partition ACLs do not inherit: Postgres checks privileges on the
//    relation NAMED in the query, so a parent-level REVOKE says nothing about `provenance_event_2026_08`.
//    `mirror_partition_acl` copies each parent's ACL onto its partitions, so it has to run after every GRANT
//    and REVOKE that could change a parent.
//
//    This has ALREADY FAILED ONCE. applyMigrations records it: the mirror sat above the leadwolf_er grants,
//    "its own comment said 'this MUST run last' and it did not", so on a fresh database each partition was
//    mirrored from a parent ACL that did not yet carry the er grant. The block now ends with "Anything
//    appended to this block from now on must go ABOVE this mirror, not below it" — an instruction with
//    nothing behind it, in a block people append to whenever a table is added. That is what this test is.
//
// 2. THE FORGE FIREWALL RUNS BOTH WAYS. leadwolf_forge owns the forge schema end-to-end (ADR-0047) and gets
//    no grant on public; leadwolf_app gets the blanket grants IN SCHEMA public and none in forge. The
//    separation is currently implicit — it holds because every grant happens to name the right schema, and
//    one carelessly-scoped GRANT would join the two planes with nothing objecting.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "applyMigrations.ts"), "utf8");

/** The GRANTS template literal — the block whose ORDER matters. */
function grantsBlock(): string {
  const start = src.indexOf("const GRANTS = `");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("`;", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** Strip `--` line comments so prose about GRANTs is never mistaken for a GRANT.
 *  No `$` anchor: on a CRLF checkout each split line ends in `\r`, which `.` does not match, so an
 *  anchored `--.*$` silently strips NOTHING and every comment mentioning a GRANT trips the assertions
 *  below — the exact way this file sat red on Windows working copies. `--.*` alone stops at the `\r`
 *  naturally and needs no anchor. */
function withoutComments(sql: string): string {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*/, ""))
    .join("\n");
}

describe("the partition-ACL mirror runs last", () => {
  test("no GRANT or REVOKE statement follows mirror_partition_acl", () => {
    const block = withoutComments(grantsBlock());
    const at = block.indexOf("mirror_partition_acl");
    expect(at).toBeGreaterThan(-1);

    const after = block.slice(at);
    // A GRANT/REVOKE below the mirror re-opens exactly the hole the mirror exists to close: the parent's ACL
    // changes and the partitions keep the ACL mirrored from BEFORE that change, under predictable names like
    // `<table>_2026_08` that a raw query can address directly.
    expect(after).not.toMatch(/\bGRANT\b/i);
    expect(after).not.toMatch(/\bREVOKE\b/i);
  });

  test("the mirror is guarded on the function existing", () => {
    // Kept so a database migrated only as far as 0101 still converges rather than erroring mid-migrate.
    expect(grantsBlock()).toMatch(/pg_proc WHERE proname = 'mirror_partition_acl'/);
  });
});

describe("the forge firewall runs both ways", () => {
  test("leadwolf_forge is never granted anything IN SCHEMA public", () => {
    // Statement-scoped with [^;] — a match that runs across statements picks up the neighbouring public
    // grants and fails on correct code. (Third time this trap has appeared in a static SQL assertion here.)
    const bad = [
      ...withoutComments(src).matchAll(/GRANT[^;]*?IN SCHEMA public[^;]*?TO\s+leadwolf_forge/gi),
    ];
    expect(bad.map((m) => m[0])).toEqual([]);
  });

  test("leadwolf_app is never granted anything IN SCHEMA forge", () => {
    const bad = [
      ...withoutComments(src).matchAll(/GRANT[^;]*?IN SCHEMA forge[^;]*?TO\s+leadwolf_app/gi),
    ];
    expect(bad.map((m) => m[0])).toEqual([]);
  });

  test("the forge role still gets its own schema (the plane works at all)", () => {
    // The firewall assertions above are satisfied by granting NOTHING, so this is the positive control that
    // stops them passing on a broken migrator.
    const clean = withoutComments(src);
    expect(clean).toMatch(/GRANT USAGE ON SCHEMA forge TO leadwolf_forge/);
    expect(clean).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA forge/);
  });
});
