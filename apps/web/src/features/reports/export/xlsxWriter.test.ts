// xlsxWriter.test.ts — pins the dependency-free XLSX (stored-ZIP OOXML) writer's contract: the output is a
// well-formed ZIP (local-header + central-directory + EOCD signatures, entry count, CRC-32 integrity), carries
// the six required OOXML parts, and the worksheet XML faithfully encodes headers (bold style), numbers (typed
// numeric cells), strings (XML-escaped inline text), and A1 column refs. Pure bytes in → bytes asserted; no DOM.

import { describe, expect, it } from "bun:test";
import { buildXlsx } from "./xlsxWriter";

const LOCAL_SIG = 0x04_03_4b_50;
const CENTRAL_SIG = 0x02_01_4b_50;
const EOCD_SIG = 0x06_05_4b_50;

const decoder = new TextDecoder();

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u32LE(bytes: Uint8Array, offset: number): number {
  return view(bytes).getUint32(offset, true);
}

function u16LE(bytes: Uint8Array, offset: number): number {
  return view(bytes).getUint16(offset, true);
}

// Re-implement CRC-32 here (independent of the writer) so the integrity check is a genuine cross-check.
function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xed_b8_83_20 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/** Walk the local file headers (stored entries only) and return path → uncompressed bytes. */
function readStoredEntries(zip: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  let i = 0;
  while (i + 4 <= zip.length && u32LE(zip, i) === LOCAL_SIG) {
    const crcStored = u32LE(zip, i + 14);
    const size = u32LE(zip, i + 18);
    const nameLen = u16LE(zip, i + 26);
    const extraLen = u16LE(zip, i + 28);
    const nameStart = i + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = decoder.decode(zip.subarray(nameStart, nameStart + nameLen));
    const data = zip.subarray(dataStart, dataStart + size);
    expect(crc32(data)).toBe(crcStored); // CRC in the header matches the bytes
    entries.set(name, data);
    i = dataStart + size;
  }
  return entries;
}

describe("buildXlsx", () => {
  const sheet = {
    name: "Credit usage",
    headers: ["Section", "Item", "Reveals", "Credits"],
    rows: [
      ["By reveal type", "Email", 12, 12] as (string | number)[],
      ["By reveal type", 'Phone "P"', 3, 9] as (string | number)[],
    ],
  };

  it("emits a well-formed ZIP with the six OOXML parts", () => {
    const bytes = buildXlsx(sheet);
    expect(bytes.length).toBeGreaterThan(0);
    expect(u32LE(bytes, 0)).toBe(LOCAL_SIG);

    const entries = readStoredEntries(bytes);
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]) {
      expect(entries.has(part)).toBe(true);
    }
  });

  it("records the entry count + EOCD signature in the central directory", () => {
    const bytes = buildXlsx(sheet);
    // The EOCD record is the last 22 bytes (no comment).
    const eocd = bytes.length - 22;
    expect(u32LE(bytes, eocd)).toBe(EOCD_SIG);
    expect(u16LE(bytes, eocd + 10)).toBe(6); // total entries
    // The central directory offset must point at a central-directory header signature.
    const cdOffset = u32LE(bytes, eocd + 16);
    expect(u32LE(bytes, cdOffset)).toBe(CENTRAL_SIG);
  });

  it("encodes headers, numbers, and XML-escaped strings in the worksheet", () => {
    const bytes = buildXlsx(sheet);
    const sheetXml = decoder.decode(
      readStoredEntries(bytes).get("xl/worksheets/sheet1.xml") as Uint8Array,
    );
    // Header row uses the bold style index and the first cell ref is A1.
    expect(sheetXml).toContain('<c r="A1" s="1"');
    expect(sheetXml).toContain("Section");
    // Numbers are typed numeric cells (a <v> with no inlineStr).
    expect(sheetXml).toContain("<v>12</v>");
    // Strings with quotes are XML-escaped, never raw.
    expect(sheetXml).toContain("Phone &quot;P&quot;");
    expect(sheetXml).not.toContain('Phone "P"');
    // Second data row lands on row 3 (header=1, first data=2).
    expect(sheetXml).toContain('r="A3"');
  });

  it("puts the (sanitized) sheet name in the workbook", () => {
    const bytes = buildXlsx({ name: "A/B*C[bad]", headers: ["x"], rows: [] });
    const workbook = decoder.decode(readStoredEntries(bytes).get("xl/workbook.xml") as Uint8Array);
    // Forbidden chars (/ * [ ]) are stripped to spaces — none survive in the sheet name attribute.
    expect(workbook).not.toMatch(/name="[^"]*[/*[\]][^"]*"/);
    expect(workbook).toContain("<sheet ");
  });

  it("is deterministic (same input → identical bytes)", () => {
    expect(buildXlsx(sheet)).toEqual(buildXlsx(sheet));
  });
});
