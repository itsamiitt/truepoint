// preview.test.ts — the pre-commit validation preview (G-IMP-1). total = valid + rejected + duplicate, where
// duplicate is the WITHIN-FILE collision count (first occurrence valid, later collisions duplicate) and
// rejected rows never count as duplicate. Pure — no DB (against-existing dedup is the worker's job).

import { describe, expect, test } from "bun:test";
import type { ColumnMapping } from "@leadwolf/types";
import type { RawRow } from "./columnMap.ts";
import { buildImportPreview } from "./preview.ts";

const MAPPING: ColumnMapping = { email: "Email", firstName: "First" };

describe("buildImportPreview", () => {
  test("counts valid / rejected / within-file duplicate rows; total reconciles", () => {
    const rows: RawRow[] = [
      { Email: "jane@acme.com", First: "Jane" }, // valid
      { Email: "jane@acme.com", First: "Jane Again" }, // within-file duplicate of #1
      { Email: "JANE+work@acme.com", First: "Jane Tag" }, // normalizes to jane@acme.com → duplicate
      { Email: "john@acme.com", First: "John" }, // valid
      { First: "NoId" }, // rejected: no identity key
      { Email: "garbage", First: "Bad" }, // rejected: malformed email + no key
    ];
    const p = buildImportPreview(rows, MAPPING);
    expect(p.total).toBe(6);
    expect(p.valid).toBe(2); // jane (first) + john
    expect(p.duplicate).toBe(2); // the two later jane collisions
    expect(p.rejected).toBe(2); // NoId + garbage
    expect(p.valid + p.duplicate + p.rejected).toBe(p.total);
  });

  test("samples rejected rows with reasons, bounded by sampleLimit", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ First: `NoId${i}` }));
    const p = buildImportPreview(rows, MAPPING, { sampleLimit: 3 });
    expect(p.rejected).toBe(10);
    expect(p.sampleRejectedRows).toHaveLength(3);
    expect(p.sampleRejectedRows[0]?.reason).toContain("no email");
  });

  test("an all-valid file has zero rejected and zero duplicate", () => {
    const rows = [
      { Email: "a@x.com", First: "A" },
      { Email: "b@x.com", First: "B" },
    ];
    const p = buildImportPreview(rows, MAPPING);
    expect(p).toMatchObject({ total: 2, valid: 2, rejected: 0, duplicate: 0 });
    expect(p.sampleRejectedRows).toHaveLength(0);
  });

  test("an empty file previews to all-zero", () => {
    const p = buildImportPreview([], MAPPING);
    expect(p).toEqual({ total: 0, valid: 0, rejected: 0, duplicate: 0, sampleRejectedRows: [] });
  });
});
