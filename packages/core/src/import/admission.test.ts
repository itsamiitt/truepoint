import { describe, expect, test } from "bun:test";
// admission.test.ts — S-S1 upload-admission envelope (import-redesign 13 §1; T-S7 admission-matrix class).
// CI-RUN: this sandbox cannot execute bun; these tests are the CI gate for the sniffing/encoding controls.
// Admission is by CONTENT, never extension or declared type: an .xlsx must be an OOXML ZIP workbook (415
// unsupported_media_type otherwise, per 08 §2.3's slug), a "CSV" must match no known binary magic, carry no
// NUL bytes outside BOM-declared UTF-16, and decode without SYSTEMIC mojibake (whole-file 422).

import {
  ArchiveLimitsExceededError,
  ImportValidationError,
  UnsupportedMediaTypeError,
} from "@leadwolf/types";
import * as XLSX from "xlsx";
import {
  IMPORT_XLSX_MAX_ARCHIVE_ENTRIES,
  assertCsvPrefixAdmissible,
  assertXlsxAdmissible,
  assertXlsxArchiveWithinLimits,
  decodeAdmittedCsv,
  hasZipMagic,
} from "./admission.ts";
import { parseXlsx } from "./parseXlsx.ts";

/** A real (tiny) OOXML workbook, built the same way the parseXlsx tests build theirs. */
function realXlsxBytes(): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Email"], ["a@x.test"]]), "Sheet1");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("assertXlsxAdmissible (13 §1.1)", () => {
  test("admits a real OOXML workbook", () => {
    expect(() => assertXlsxAdmissible(realXlsxBytes())).not.toThrow();
  });

  test("rejects non-ZIP bytes as 415 unsupported_media_type", () => {
    for (const bytes of [
      utf8("Email\na@x.test\n"), // plain text renamed .xlsx
      utf8("%PDF-1.7 ..."),
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]), // legacy OLE2 .xls
      new Uint8Array(0),
    ]) {
      try {
        assertXlsxAdmissible(bytes);
        throw new Error("expected rejection");
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedMediaTypeError);
        const e = err as UnsupportedMediaTypeError;
        expect(e.status).toBe(415);
        expect(e.code).toBe("unsupported_media_type");
      }
    }
  });

  test("rejects a ZIP that is not a workbook (no [Content_Types].xml)", () => {
    // ZIP local-file magic + arbitrary non-workbook payload.
    const fakeZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...utf8("not a workbook at all")]);
    expect(hasZipMagic(fakeZip)).toBe(true);
    expect(() => assertXlsxAdmissible(fakeZip)).toThrow(UnsupportedMediaTypeError);
  });
});

describe("decodeAdmittedCsv (13 §1.1/§1.3)", () => {
  test("decodes plain UTF-8 unchanged", () => {
    expect(decodeAdmittedCsv(utf8("Email\na@x.test\n"))).toBe("Email\na@x.test\n");
  });

  test("strips a UTF-8 BOM (never leaks into the first header)", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("Email\na@x.test\n")]);
    expect(decodeAdmittedCsv(bytes)).toBe("Email\na@x.test\n");
  });

  test("decodes UTF-16LE per BOM (no mojibake)", () => {
    const text = "Email\njosé@x.test\n";
    const buf = new Uint8Array(2 + text.length * 2);
    buf[0] = 0xff;
    buf[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      const cu = text.charCodeAt(i);
      buf[2 + i * 2] = cu & 0xff;
      buf[3 + i * 2] = cu >> 8;
    }
    expect(decodeAdmittedCsv(buf)).toBe(text);
  });

  test("rejects known binary magics as 415 (CSV that is secretly a ZIP/PDF/EXE/image)", () => {
    const cases: Uint8Array[] = [
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), // ZIP — an .xlsx renamed .csv
      utf8("%PDF-1.4 stuff"),
      new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), // MZ
      new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), // ELF
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // PNG
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), // JPEG
      new Uint8Array([0x1f, 0x8b, 0x08, 0x00]), // gzip
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), // OLE2 legacy .xls
    ];
    for (const bytes of cases) {
      expect(() => decodeAdmittedCsv(bytes)).toThrow(UnsupportedMediaTypeError);
    }
  });

  test("rejects NUL bytes in a BOM-less 'CSV' as binary ⇒ 415", () => {
    const bytes = new Uint8Array([...utf8("Email\na@x."), 0x00, ...utf8("test\n")]);
    expect(() => decodeAdmittedCsv(bytes)).toThrow(UnsupportedMediaTypeError);
  });

  test("tolerates SPARSE undecodable bytes (warnings ride the new-path draft flow)", () => {
    // One stray invalid byte in an otherwise-large clean file: below both systemic thresholds.
    const bytes = new Uint8Array([...utf8(`Email\n${"a@x.test\n".repeat(5_000)}`), 0xff]);
    expect(() => decodeAdmittedCsv(bytes)).not.toThrow();
  });

  test("rejects SYSTEMIC mojibake as a whole-file 422", () => {
    // A latin-1-style byte salad: every other byte invalid UTF-8 ⇒ replacement-heavy decode.
    const bad = new Uint8Array(4_096);
    for (let i = 0; i < bad.length; i += 2) {
      bad[i] = 0xe9; // lone continuation-start byte → U+FFFD
      bad[i + 1] = 0x2c; // ','
    }
    try {
      decodeAdmittedCsv(bad);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(ImportValidationError);
      expect((err as ImportValidationError).status).toBe(422);
    }
  });
});

describe("assertCsvPrefixAdmissible (bulk streaming admission)", () => {
  test("admits a clean UTF-8 prefix and reports no BOM", () => {
    expect(assertCsvPrefixAdmissible(utf8("Email,Name\na@x.test,A\n"))).toBeNull();
  });

  test("reports a UTF-16 BOM so the caller can refuse what its parser can't decode", () => {
    expect(assertCsvPrefixAdmissible(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe("utf-16le");
    expect(assertCsvPrefixAdmissible(new Uint8Array([0xfe, 0xff, 0x00, 0x41]))).toBe("utf-16be");
  });

  test("rejects binary magic / NUL in the prefix", () => {
    expect(() => assertCsvPrefixAdmissible(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toThrow(
      UnsupportedMediaTypeError,
    );
    expect(() => assertCsvPrefixAdmissible(new Uint8Array([0x41, 0x00, 0x42]))).toThrow(
      UnsupportedMediaTypeError,
    );
  });
});

// ── S-S5: zip-bomb / archive caps (13 §1.4; T-S2 bomb fixtures) ─────────────────────────────────────────
// The fixtures are HAND-BUILT zip containers so the central-directory DECLARED sizes are fully under test
// control (the walker never inflates anything — a bomb here is a lie in the directory, exactly the attack).

interface ZipEntrySpec {
  name: string;
  data?: Uint8Array; // stored (method 0)
  declaredUncompressed?: number; // central-directory lie — what a hostile container declares
  declaredCompressed?: number;
}

/** Build a minimal, structurally valid zip: local headers + stored data, central directory, EOCD. */
function zipBytes(entries: ZipEntrySpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const ascii = (s: string) => new TextEncoder().encode(s);
  const u16 = (b: DataView, o: number, v: number) => b.setUint16(o, v, true);
  const u32 = (b: DataView, o: number, v: number) => b.setUint32(o, v, true);

  for (const e of entries) {
    const name = ascii(e.name);
    const data = e.data ?? new Uint8Array(0);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50);
    u16(lv, 4, 20);
    u32(lv, 18, data.length); // compressed (stored)
    u32(lv, 22, data.length); // uncompressed
    u16(lv, 26, name.length);
    local.set(name, 30);
    chunks.push(local, data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    u32(cv, 0, 0x02014b50);
    u16(cv, 4, 20);
    u16(cv, 6, 20);
    u32(cv, 20, e.declaredCompressed ?? data.length);
    u32(cv, 24, e.declaredUncompressed ?? data.length);
    u16(cv, 28, name.length);
    u32(cv, 42, offset); // local header offset
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + data.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  u32(ev, 0, 0x06054b50);
  u16(ev, 8, entries.length);
  u16(ev, 10, entries.length);
  u32(ev, 12, cdSize);
  u32(ev, 16, offset);

  const total = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const c of [...chunks, ...central, eocd]) {
    total.set(c, p);
    p += c.length;
  }
  return total;
}

function expectArchiveReject(bytes: Uint8Array, reason: string): void {
  try {
    assertXlsxArchiveWithinLimits(bytes);
    throw new Error(`expected archive rejection (${reason})`);
  } catch (err) {
    expect(err).toBeInstanceOf(ArchiveLimitsExceededError);
    const e = err as ArchiveLimitsExceededError;
    expect(e.status).toBe(422);
    expect(e.code).toBe("archive_limits_exceeded");
    expect(e.extensions.reason).toBe(reason);
  }
}

const CONTENT_TYPES = { name: "[Content_Types].xml", data: new TextEncoder().encode("<Types/>") };
const MIB = 1024 * 1024;

describe("assertXlsxArchiveWithinLimits (13 §1.4, S-S5)", () => {
  test("admits a REAL workbook (no false positive on small high-compression parts)", () => {
    expect(() => assertXlsxArchiveWithinLimits(realXlsxBytes())).not.toThrow();
  });

  test("rejects a high-expansion-ratio bomb at central-directory read", () => {
    // Declares 150 MiB inflating from ~1 KiB — a classic bomb shape; never extracted.
    const bomb = zipBytes([
      CONTENT_TYPES,
      {
        name: "xl/worksheets/sheet1.xml",
        declaredCompressed: 1024,
        declaredUncompressed: 150 * MIB,
      },
    ]);
    expectArchiveReject(bomb, "expansion_ratio");
  });

  test("rejects a per-entry uncompressed cap violation", () => {
    const bomb = zipBytes([
      {
        name: "xl/sharedStrings.xml",
        declaredCompressed: 100 * MIB,
        declaredUncompressed: 201 * MIB,
      },
    ]);
    expectArchiveReject(bomb, "entry_uncompressed");
  });

  test("rejects a total-uncompressed cap violation (entries individually under caps)", () => {
    const bomb = zipBytes([
      { name: "xl/a.xml", declaredCompressed: 100 * MIB, declaredUncompressed: 150 * MIB },
      { name: "xl/b.xml", declaredCompressed: 100 * MIB, declaredUncompressed: 150 * MIB },
    ]);
    expectArchiveReject(bomb, "total_uncompressed");
  });

  test("rejects an over-cap entry count", () => {
    const names = Array.from({ length: IMPORT_XLSX_MAX_ARCHIVE_ENTRIES + 1 }, (_, i) => ({
      name: `xl/p${i}.xml`,
    }));
    expectArchiveReject(zipBytes(names), "entry_count");
  });

  test("rejects a zero-entry archive (13's zero-entry edge)", () => {
    expectArchiveReject(zipBytes([]), "zero_entries");
  });

  test("rejects nested archives", () => {
    expectArchiveReject(
      zipBytes([CONTENT_TYPES, { name: "xl/media/payload.zip" }]),
      "nested_archive",
    );
  });

  test("rejects path-traversal entry names", () => {
    expectArchiveReject(zipBytes([CONTENT_TYPES, { name: "../evil.xml" }]), "path_traversal");
    expectArchiveReject(zipBytes([CONTENT_TYPES, { name: "/abs.xml" }]), "path_traversal");
    expectArchiveReject(zipBytes([CONTENT_TYPES, { name: "a\\b.xml" }]), "path_traversal");
  });

  test("rejects ZIP64 markers outright", () => {
    const z = zipBytes([
      CONTENT_TYPES,
      { name: "xl/big.xml", declaredCompressed: 1024, declaredUncompressed: 0xffffffff },
    ]);
    expectArchiveReject(z, "zip64");
  });

  test("treats structural garbage as the corrupt-file error, not a crash", () => {
    expect(() =>
      assertXlsxArchiveWithinLimits(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9])),
    ).toThrow(ImportValidationError);
  });

  test("parseXlsx runs the gate BEFORE extraction — a bomb never reaches SheetJS", () => {
    const bomb = zipBytes([
      CONTENT_TYPES,
      {
        name: "xl/worksheets/sheet1.xml",
        declaredCompressed: 512,
        declaredUncompressed: 200 * MIB,
      },
    ]);
    try {
      parseXlsx(bomb);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(ArchiveLimitsExceededError);
      expect((err as ArchiveLimitsExceededError).code).toBe("archive_limits_exceeded");
    }
  });
});
