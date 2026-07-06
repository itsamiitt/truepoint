// routing.test.ts — T7's routing matrix at the decision seam (import-and-data-model-redesign 08 §1, 15
// §T-P2 seq 40: "T7 copy half"): the ONE fast-vs-copy decision both the one-shot POST and the draft commit
// consume. Copy half: over-threshold + ENGAGED ⇒ 'copy' (never a refusal); over-threshold + NOT engaged ⇒
// the honest ImportTooLargeError naming the ceiling (15 §R-P2's standing fallback — flipping either half of
// the BULK pair off restores the S-I5 refusal byte-identically); XLSX over-threshold refuses ALWAYS (the
// copy drive stages CSV only). Boundary rows/bytes (exactly at the ceiling) stay 'fast' in every gate state
// — the decision half of T-X2's boundary parity (the outcome-parity half rides CI's pipeline itest).

import { IMPORT_FASTPATH_MAX_BYTES, ImportTooLargeError } from "@leadwolf/types";
import { describe, expect, test } from "bun:test";
import { decideImportRouting } from "./routing.ts";

const CEILING = 5000; // the BULK_IMPORT_THRESHOLD_ROWS default — passed explicitly (the fn is env-free)

function facts(over: Partial<Parameters<typeof decideImportRouting>[0]> = {}) {
  return {
    fileName: "contacts.csv",
    byteSize: 1024,
    rowCount: 10,
    rowCeiling: CEILING,
    copyEngaged: false,
    ...over,
  };
}

function refusal(f: ReturnType<typeof facts>): ImportTooLargeError {
  try {
    decideImportRouting(f);
  } catch (e) {
    expect(e).toBeInstanceOf(ImportTooLargeError);
    return e as ImportTooLargeError;
  }
  throw new Error("expected an ImportTooLargeError refusal");
}

describe("decideImportRouting — the T7 routing matrix", () => {
  test("within the fast pair ⇒ fast, regardless of engagement", () => {
    expect(decideImportRouting(facts())).toBe("fast");
    expect(decideImportRouting(facts({ copyEngaged: true }))).toBe("fast");
  });

  test("boundary parity: EXACTLY at the row/byte ceilings ⇒ fast in every gate state (T-X2 decision half)", () => {
    for (const copyEngaged of [false, true]) {
      expect(decideImportRouting(facts({ rowCount: CEILING, copyEngaged }))).toBe("fast");
      expect(
        decideImportRouting(facts({ byteSize: IMPORT_FASTPATH_MAX_BYTES, copyEngaged })),
      ).toBe("fast");
    }
  });

  test("CSV one row over + NOT engaged ⇒ honest refusal naming the row ceiling (§R-P2 fallback)", () => {
    const err = refusal(facts({ rowCount: CEILING + 1 }));
    expect(err.code).toBe("file_too_large");
    expect(err.extensions).toEqual({ limit: CEILING, current: CEILING + 1, unit: "rows" });
  });

  test("CSV one row over + ENGAGED ⇒ copy (the S-I9 graduation — same facts, ceiling lifts)", () => {
    expect(decideImportRouting(facts({ rowCount: CEILING + 1, copyEngaged: true }))).toBe("copy");
  });

  test("CSV one byte over + NOT engaged ⇒ honest refusal naming the byte ceiling", () => {
    const err = refusal(facts({ byteSize: IMPORT_FASTPATH_MAX_BYTES + 1 }));
    expect(err.code).toBe("file_too_large");
    expect(err.extensions).toEqual({
      limit: IMPORT_FASTPATH_MAX_BYTES,
      current: IMPORT_FASTPATH_MAX_BYTES + 1,
      unit: "bytes",
    });
  });

  test("CSV one byte over + ENGAGED ⇒ copy (byte half alone routes; rows may be unmeasured 0)", () => {
    expect(
      decideImportRouting(
        facts({ byteSize: IMPORT_FASTPATH_MAX_BYTES + 1, rowCount: 0, copyEngaged: true }),
      ),
    ).toBe("copy");
  });

  test("XLSX over the row ceiling ⇒ xlsx_too_large ALWAYS — engaged or not (copy stages CSV only)", () => {
    for (const copyEngaged of [false, true]) {
      const err = refusal(
        facts({ fileName: "Contacts.XLSX", rowCount: CEILING + 1, copyEngaged }),
      );
      expect(err.code).toBe("xlsx_too_large");
    }
  });

  test("XLSX skips the CSV byte half (bytes are admission-capped upstream)", () => {
    expect(
      decideImportRouting(
        facts({ fileName: "contacts.xlsx", byteSize: IMPORT_FASTPATH_MAX_BYTES + 1 }),
      ),
    ).toBe("fast");
  });

  test("rowCeiling ≤ 0 disables the row half (the shipped S-I5 knob semantics)", () => {
    expect(decideImportRouting(facts({ rowCount: 1_000_000, rowCeiling: 0 }))).toBe("fast");
  });
});
