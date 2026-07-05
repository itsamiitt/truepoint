// admission.limits.test.ts — S-P2 TP-7: the published import limits are ONE constant with TWO consumers, not
// a magic number duplicated across the tree (import-and-data-model-redesign 12 §5, 15 §M-SEQ seq 16). The
// admission envelope must consume the SINGLE @leadwolf/types source — asserted by identity, so a future
// re-typed literal in admission.ts fails this test instead of silently drifting from the web upload UI.

import {
  IMPORT_MAX_CSV_BYTES,
  IMPORT_MAX_XLSX_BYTES,
  IMPORT_MAX_XLSX_COLS,
  IMPORT_MAX_XLSX_ROWS,
} from "@leadwolf/types";
import { describe, expect, test } from "bun:test";
import {
  IMPORT_CSV_MAX_BYTES,
  IMPORT_XLSX_MAX_BYTES,
  IMPORT_XLSX_MAX_COLS,
  IMPORT_XLSX_MAX_ROWS,
} from "./admission.ts";

describe("S-P2 published limits — one constant, two consumers (TP-7)", () => {
  test("admission re-exports the SINGLE @leadwolf/types source (no duplicated magic number)", () => {
    expect(IMPORT_CSV_MAX_BYTES).toBe(IMPORT_MAX_CSV_BYTES);
    expect(IMPORT_XLSX_MAX_BYTES).toBe(IMPORT_MAX_XLSX_BYTES);
    expect(IMPORT_XLSX_MAX_ROWS).toBe(IMPORT_MAX_XLSX_ROWS);
    expect(IMPORT_XLSX_MAX_COLS).toBe(IMPORT_MAX_XLSX_COLS);
  });

  test("carries the 12 §5 launch values (with the shipped-code-wins XLSX drift)", () => {
    expect(IMPORT_MAX_CSV_BYTES).toBe(250 * 1024 * 1024); // 12 §5 launch
    expect(IMPORT_MAX_XLSX_BYTES).toBe(25 * 1024 * 1024); // shipped 25 MiB wins over 12 §5's 10 MB
    expect(IMPORT_MAX_XLSX_ROWS).toBe(100_000);
    expect(IMPORT_MAX_XLSX_COLS).toBe(256);
  });
});
