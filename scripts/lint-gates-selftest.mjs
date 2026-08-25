#!/usr/bin/env node
// lint-gates-selftest.mjs — prove each gate can still FAIL.
//
// A lint rule that cannot fail is indistinguishable from one that passes, and this repo has now produced
// SEVEN of them, every one silent in the same direction:
//
//   rlsCoverage.test.ts        read only pgTable — hand-authored migration tables were invisible
//   lint:import-pii            blind to ES6 shorthand: `{ rows }` passed, `{ rows: parsed }` failed
//   no-cross-feature-import    never saw a real violation — the cruise runs without a per-app tsconfig, so
//                              `@/*` never resolves, and every violation in this codebase is written that way
//   inkFourContrast ratchet    undercounted by 23 for the same shorthand-shaped reason
//   lint:batch-inserts (v1)    `\.values\(\s*(?!\{)` — \s* backtracks, so the lookahead passed on every
//                              multi-line object literal; 40 findings, nearly all false
//   line numbering (two gates) `/^\s*\/\/.*$/gm` — \s MATCHES NEWLINES, so stripping a comment deleted the
//                              blank lines above it and shifted every later line (698 newlines became 609)
//   comment blindness (two)    a commented-out example counted as a live finding
//
// Each was found by planting a failure and watching for it. That habit is the only thing that caught any of
// them, and a habit is not a mechanism — so this runs it on every build.
//
// HOW IT WORKS: for each gate, write a file that MUST trip it, run the gate, require a non-zero exit that
// names the plant; delete the file, run again, require zero. A gate that passes its plant has gone blind and
// fails this check by name.
//
// Fixtures are written into the real tree because that is what the gates scan, under a directory named with
// this process's pid so two runs cannot collide, and removed in a finally block. If this process is killed
// mid-run, a `__gate_selftest_*` directory is the leftover — it is inert and safe to delete.
//
// CLEANUP IS THE DANGEROUS PART, and the first version of this script got it wrong: it planted three fixtures
// as `<real-dir>/__tag__.ts` and cleaned up with `rmSync(dirname(planted), { recursive: true })`. For a plant
// whose tag is in the FILENAME, `dirname` is the real directory — so it deleted packages/core/src/import,
// packages/db/src/repositories and packages/db/test outright. 337 tracked files, gone in the run that reported
// `ok 6 gate(s) proven able to fail`. They were committed, so `git checkout --` restored them exactly; had they
// not been, a script written to make verification trustworthy would have destroyed a day of work.
//
// Two rules now, and they are why every plant sits in its OWN tag-named directory rather than beside real code:
//   1. Cleanup removes only what THIS RUN CREATED. `mkdirSync(…, { recursive: true })` returns the topmost
//      directory it actually made, or `undefined` if the path already existed — so that return value, not a
//      path computed from the fixture, is what may be recursively removed. If the directory already existed,
//      only the planted file is unlinked.
//   2. The removal target must still be tag-named when it is removed, asserted immediately before the call.
// Neither alone is enough: (1) without (2) trusts a path built by string arithmetic, and (2) without (1) would
// happily delete a leftover directory this run did not create.
//
// TWO GATES NEED A DIFFERENT SHAPE, and this file used to claim they could not be covered at all:
//   • lint:secrets scans `git ls-files`, so an untracked fixture is invisible to it — proving it appeared to
//     require `git add`-ing a fake credential, which must never happen by accident.
//   • lint:prod-switches reads deploy/env.production.template, and arming a switch there — even briefly — is
//     a production-posture edit in a shared working copy.
//
// Both objections were about planting IN THIS REPO. Neither gate is bound to this repo: both resolve every
// path from the CURRENT WORKING DIRECTORY, so each runs against a throwaway tree under the OS temp dir with
// its own `git init`, and the fake credential never touches this checkout or its index. That is what
// SANDBOX_CASES below do. No change to either gate was required — only noticing that "cannot be tested"
// actually meant "cannot be tested the way the other five are".
//
// All seven script gates are therefore covered.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const TAG = `__gate_selftest_${process.pid}__`;

/**
 * Gates that read from the CURRENT WORKING DIRECTORY, exercised against a throwaway tree in the OS temp dir.
 *
 * `build(dir)` lays out the smallest tree that must trip the gate; the gate then runs with that directory as
 * its cwd. Nothing is written inside this repository, so the planted credential never reaches this checkout,
 * its index, or any file a later `git add -A` could sweep up.
 */
const SANDBOX_CASES = [
  {
    gate: "lint:secrets",
    script: "scripts/lint-committed-secrets.mjs",
    // A syntactically valid AWS access-key id that is not one: the AKIA prefix plus 16 uppercase characters
    // is the shape the scanner matches. It lives for milliseconds in a temp dir and is never committed
    // anywhere. The gate only sees TRACKED files, so the fixture must be `git add`-ed — inside its own
    // repository, which is the whole reason this case is a sandbox rather than a plant.
    expect: /AWS access key id/i,
    build(dir) {
      // autocrlf off: the fixture must be byte-exact, and on Windows git otherwise warns about line endings
      // on every run — noise in a check whose whole value is that its output is worth reading.
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });
      // ASSEMBLED, never written as a literal. The first version inlined the id, which made THIS file a
      // tracked file containing an AKIA-shaped string — and lint:secrets flagged it. The gate caught its own
      // test fixture, which is the gate working correctly. The other way out was a `lint-secrets-ok:`
      // exemption, and that is the wrong trade for a synthetic value that can simply be built: an exemption
      // is a hole someone later widens, while concatenation keeps the scanner strict and still hands the gate
      // under test a string that matches.
      const fakeAwsKeyId = `AKIA${"Q".repeat(16)}`;
      writeFileSync(join(dir, "leaked.ts"), `export const key = "${fakeAwsKeyId}";\n`);
      execFileSync("git", ["add", "leaked.ts"], { cwd: dir });
    },
  },
  {
    gate: "lint:prod-switches",
    script: "scripts/lint-prod-switches.mjs",
    // The gate reads the env schema for explicit-"true" switches, then checks the production template for any
    // that are armed. A switch armed here is unknown to its INTENTIONALLY_ARMED map, so it must be reported.
    expect: /PROBE_SELFTEST_ENABLED/,
    build(dir) {
      mkdirSync(join(dir, "packages", "config", "src"), { recursive: true });
      mkdirSync(join(dir, "deploy"), { recursive: true });
      writeFileSync(
        join(dir, "packages", "config", "src", "env.ts"),
        'export const schema = {\n  PROBE_SELFTEST_ENABLED: z.string().optional().transform((v) => v === "true"),\n};\n',
      );
      writeFileSync(
        join(dir, "deploy", "env.production.template"),
        "PROBE_SELFTEST_ENABLED=true\n",
      );
    },
  },
];

/**
 * Each plant is the smallest thing that must trip its gate.
 *
 * `dir` is ALWAYS tag-named and `name` never contains the tag: the fixture must be the only thing in its
 * directory, so cleanup can never reach a real file. Every gate here walks its roots recursively (verified —
 * lint:batch-inserts descends from packages/db/src, lint:itest-rejects from packages/db, lint:import-pii from
 * its ROOTS list), so an extra directory level does not hide the plant from the scan.
 */
const CASES = [
  {
    gate: "lint:roving-tabindex",
    script: "scripts/lint-roving-tabindex.mjs",
    dir: `apps/doc/src/${TAG}`,
    name: "Trap.tsx",
    content: `export function Trap() {
  return (
    <div role="radiogroup">
      <button type="button" role="radio" aria-checked={false} tabIndex={-1} onClick={() => {}}>
        one
      </button>
    </div>
  );
}
`,
  },
  {
    gate: "lint:design-tokens",
    script: "scripts/lint-design-tokens.mjs",
    dir: `apps/doc/src/${TAG}`,
    name: "probe.module.css",
    content: ".probe {\n  color: #ff00aa;\n}\n",
  },
  {
    gate: "lint:cross-feature",
    script: "scripts/lint-cross-feature-imports.mjs",
    dir: `apps/admin/src/features/${TAG}`,
    name: "probe.ts",
    content: 'import { x } from "@/features/tenants";\nexport const y = x;\n',
  },
  {
    // One planted file is enough: the violation is a test living outside src/ in a workspace that declares
    // no typecheck:tests. packages/ui is the fixture precisely because it keeps its tests colocated in src/,
    // so the plant CREATES the out-of-src condition instead of joining one that already exists.
    gate: "lint:typecheck-coverage",
    script: "scripts/lint-typecheck-coverage.mjs",
    dir: `packages/ui/test/${TAG}`,
    name: "probe.test.ts",
    content: 'import { expect, test } from "bun:test";\ntest("probe", () => expect(1).toBe(1));\n',
  },
  {
    // The only case needing a PAIR: one module cannot form a cycle. The two edges are written differently on
    // purpose — probeA reaches probeB relatively, probeB reaches probeA through the `@/` alias — so a plant
    // that passed would tell us the ALIAS half of the resolver is broken, which is the half depcruise lacks
    // and the only reason this gate exists.
    gate: "lint:alias-cycles",
    script: "scripts/lint-alias-cycles.mjs",
    dir: `apps/doc/src/${TAG}`,
    name: "probeA.ts",
    content: 'import { b } from "./probeB";\nexport const a = (): string => b();\n',
    extra: {
      name: "probeB.ts",
      content: `import { a } from "@/${TAG}/probeA";\nexport const b = (): string => a();\n`,
    },
  },
  {
    gate: "lint:batch-inserts",
    script: "scripts/lint-batch-insert-bounds.mjs",
    dir: `packages/db/src/repositories/${TAG}`,
    name: "probeRepository.ts",
    content: `import type { Tx } from "../../client.ts";
import { contacts } from "../../schema/contacts.ts";

export const probeRepository = {
  async insertMany(tx: Tx, rows: Array<{ tenantId: string }>): Promise<void> {
    await tx.insert(contacts).values(rows.map((r) => ({ tenantId: r.tenantId })));
  },
};
`,
  },
  {
    gate: "lint:queue-consumers",
    script: "scripts/lint-queue-consumers.mjs",
    dir: `apps/workers/src/queues/${TAG}`,
    name: "probeQueue.ts",
    // The NESTED generic is deliberate. The gate's first pattern was `tracedQueue<[^>]*>\(`, which stops at
    // the inner `>` and so PASSED this exact shape — it reported clean on a planted violation, which is how
    // the blind spot was found. Keep the nested form here; a plain `<Foo>` would no longer prove anything.
    content: `import { tracedQueue } from "../../tracedQueue.ts";

export const PROBE_QUEUE = "probe_queue";
export const probeQueue = tracedQueue<Record<string, never>>(
  PROBE_QUEUE,
  { connection: undefined as never },
);
`,
  },
  {
    gate: "lint:itest-rejects",
    script: "scripts/lint-itest-rejects.mjs",
    dir: `packages/db/test/${TAG}`,
    name: "probe.itest.ts",
    content: `import { expect, test } from "bun:test";
test("probe", async () => {
  await expect(Promise.reject(new Error("x"))).rejects.toThrow();
});
`,
  },
  {
    gate: "lint:import-pii",
    script: "scripts/lint-import-pii-logs.mjs",
    dir: `packages/core/src/import/${TAG}`,
    name: "probe.ts",
    content: `import { log } from "@leadwolf/auth";
export function probe(rows: unknown[], jobId: string): void {
  log.info("probe", { jobId, rows });
}
`,
  },
];

/** Run a gate. Returns { code, output } instead of throwing — a non-zero exit is the expected result here.
 *  `cwd` matters for the sandbox cases: those gates resolve every path from the working directory, so running
 *  them elsewhere is what points them at a fixture instead of this repo. The script path is resolved to an
 *  absolute one first, or a changed cwd would make node unable to find the gate itself. */
function runGate(script, cwd) {
  try {
    const output = execFileSync("node", [resolve(script)], {
      encoding: "utf8",
      stdio: "pipe",
      ...(cwd ? { cwd } : {}),
    });
    return { code: 0, output };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/**
 * Remove the fixture, and the directory ONLY if this run created it.
 *
 * `created` is whatever `mkdirSync(…, { recursive: true })` returned — the topmost directory it actually made,
 * or `undefined` when the path already existed. Removing that value (never a path derived from the fixture)
 * is what bounds the blast radius to this run's own work. The tag assertion is the second, independent check:
 * a recursive delete of anything not tag-named is a bug in this script, and it aborts rather than proceeds.
 */
function cleanup(created, planted, dir) {
  try {
    unlinkSync(planted);
  } catch {
    // already gone — the recursive remove below, or a previous failed run, got there first
  }
  if (typeof created !== "string" || created.length === 0) return;
  if (!basename(created).startsWith("__gate_selftest_")) {
    throw new Error(
      `refusing to remove ${created}: not a self-test directory. Fixture was ${dir}; this is a bug in ${basename(import.meta.url)}.`,
    );
  }
  rmSync(created, { recursive: true, force: true });
}

const failures = [];
let proven = 0;

for (const testCase of CASES) {
  const dir = join(process.cwd(), testCase.dir);
  const planted = join(dir, testCase.name);
  let created;
  try {
    created = mkdirSync(dir, { recursive: true });
    writeFileSync(planted, testCase.content);
    // A second file, for a gate whose violation needs a PAIR — an import cycle is not expressible in one
    // module. It lands in the same tag directory, which `cleanup` already removes recursively, so it needs no
    // separate teardown and cannot outlive the run.
    if (testCase.extra) writeFileSync(join(dir, testCase.extra.name), testCase.extra.content);

    const withPlant = runGate(testCase.script);
    if (withPlant.code === 0) {
      failures.push(
        `${testCase.gate} PASSED its own plant — the gate is blind.\n` +
          `    planted: ${testCase.dir}/${testCase.name}\n` +
          `    output : ${withPlant.output.trim().split("\n")[0] ?? "(none)"}`,
      );
      continue;
    }
    if (!withPlant.output.includes(TAG)) {
      failures.push(
        `${testCase.gate} failed, but did not NAME the planted file — a failure nobody can act on.\n` +
          `    expected the output to mention: ${TAG}`,
      );
      continue;
    }
    proven += 1;
  } finally {
    cleanup(created, planted, testCase.dir);
  }

  // And it must go quiet again once the plant is gone — otherwise the "failure" was pre-existing noise and
  // this case proved nothing about the plant at all.
  const afterRemoval = runGate(testCase.script);
  if (afterRemoval.code !== 0) {
    failures.push(
      `${testCase.gate} still fails after its plant was removed — it was already red, so the plant proved nothing.`,
    );
  }
}

// ── The cwd-scoped gates ───────────────────────────────────────────────────────────────────────────────────
// No "goes green again" half for these: the fixture directory IS the world the gate sees, and it is deleted
// wholesale. There is no residue to re-measure, unlike an in-repo plant where a lingering failure would mean
// the gate was already red for an unrelated reason.
for (const testCase of SANDBOX_CASES) {
  const sandbox = mkdtempSync(join(tmpdir(), "tp-gate-selftest-"));
  try {
    testCase.build(sandbox);

    const result = runGate(testCase.script, sandbox);
    if (result.code === 0) {
      failures.push(
        `${testCase.gate} PASSED its own sandbox plant — the gate is blind.\n` +
          `    sandbox: ${sandbox}\n` +
          `    output : ${result.output.trim().split("\n")[0] ?? "(none)"}`,
      );
      continue;
    }
    if (!testCase.expect.test(result.output)) {
      failures.push(
        `${testCase.gate} failed, but its output did not match ${testCase.expect} — so it failed for some\n    OTHER reason, and this case proved nothing about the planted shape.\n    output : ${result.output.trim().split("\n").slice(0, 3).join(" | ")}`,
      );
      continue;
    }
    proven += 1;
  } finally {
    // Whole sandbox, always. It is a mkdtemp path under the OS temp dir and contains a fake credential; it
    // must not survive this process even when an assertion above threw.
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (failures.length === 0) {
  process.stdout.write(`ok   ${proven} gate(s) proven able to fail, and to go green again\n`);
  process.exit(0);
}

process.stdout.write(
  `${failures.length} gate self-test failure(s):

${failures.join("\n\n")}

A gate that passes its own plant is not protecting anything, and every guard this repo has lost was lost
exactly this way — silently, while still reporting ok. Fix the gate rather than the plant: if the planted
shape is genuinely no longer a defect, delete the case and say why in the same commit.
`,
);
process.exit(1);
