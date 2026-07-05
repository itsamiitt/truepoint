import { describe, expect, test } from "bun:test";
// admission.test.ts — S-S1 upload-admission envelope (import-redesign 13 §1; T-S7 admission-matrix class).
// CI-RUN: this sandbox cannot execute bun; these tests are the CI gate for the sniffing/encoding controls.
// Admission is by CONTENT, never extension or declared type: an .xlsx must be an OOXML ZIP workbook (415
// unsupported_media_type otherwise, per 08 §2.3's slug), a "CSV" must match no known binary magic, carry no
// NUL bytes outside BOM-declared UTF-16, and decode without SYSTEMIC mojibake (whole-file 422).

import { ImportValidationError, UnsupportedMediaTypeError } from "@leadwolf/types";
import * as XLSX from "xlsx";
import {
  assertCsvPrefixAdmissible,
  assertXlsxAdmissible,
  decodeAdmittedCsv,
  hasZipMagic,
} from "./admission.ts";

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
