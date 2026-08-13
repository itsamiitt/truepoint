// tenantSuspensionCoverage.test.ts — every path that mints a session for a tenant must consult the §9E gate.
//
// WHY A SOURCE-LEVEL TEST. The gate ships in shadow, so a path that forgets to call it does not fail loudly —
// it just silently produces no signal, and then silently admits a suspended tenant on the day someone arms
// enforcement. That is the worst possible time to discover a hole. There is no runtime assertion that can
// catch "a call site that does not exist", so this reads the sources instead.
//
// It is deliberately dumb: it checks that each file mentions the decision helper. A test that tried to prove
// the call is reachable would need to execute four auth flows against a database, which is exactly the kind of
// coverage this repo keeps in itests — and it would still not catch the case that matters, which is a NEW file
// nobody added here. So the real guard is the list below plus the rule stated in it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every module that resolves a tenant for a session and mints or rotates a token against it.
 *
 * ADD TO THIS LIST when you write another one. The four here are: the login completion, the two switches, and
 * the rotation. If a fifth path appears and is not here, the gate has a hole and nothing else will say so.
 */
const TENANT_SELECTION_PATHS = [
  "flow.ts", // finalizeLogin — the org pick
  "switchOrg.ts", // tenant switch
  "switchWorkspace.ts", // workspace switch within a tenant
  "refresh.ts", // session rotation — the highest-volume path, and where shadow data actually accrues
] as const;

function source(file: string): string {
  return readFileSync(join(import.meta.dir, file), "utf8");
}

/**
 * The file with its import statements removed.
 *
 * This matters more than it looks: the first version of this test asserted the source merely CONTAINED
 * "tenantSuspensionDecision", which the import line satisfies on its own. Deleting the actual call left the
 * test green — verified by doing it. Stripping imports is what makes the assertion about the CALL.
 */
function body(file: string): string {
  return source(file).replace(/^import\s[^;]*;/gm, "");
}

describe("every tenant-selection path consults the suspension gate", () => {
  for (const file of TENANT_SELECTION_PATHS) {
    test(`${file} calls tenantSuspensionDecision`, () => {
      const src = body(file);
      expect(src).toContain("tenantSuspensionDecision(");
      // The decision alone is not enough — an unlogged shadow decision produces no signal, which defeats the
      // entire observe-first rollout.
      expect(src).toContain("tenantSuspensionLog(");
    });
  }

  test("all four consume the SHARED decision rather than re-deriving one", () => {
    // A local `status !== "active"` check would drift from the shared one the moment the vocabulary changes,
    // and the fail-closed classification is the part most likely to be got wrong when rewritten by hand.
    for (const file of TENANT_SELECTION_PATHS) {
      expect(source(file)).toContain('from "./tenantSuspension.ts"');
    }
  });

  test("the gate is imported, never inlined — one definition of 'suspended'", () => {
    const module = source("tenantSuspension.ts");
    expect(module).toContain('tenantStatus !== "active"');
    // Exactly one place decides what a suspended TENANT is. Note the assertion names tenantStatus rather than
    // matching `!== "active"` loosely: these files legitimately contain `user.status !== "active"`, which is
    // the USER check and a different control. A broader pattern fails on correct code.
    for (const file of TENANT_SELECTION_PATHS) {
      expect(body(file)).not.toContain('tenantStatus !== "active"');
    }
  });
});
