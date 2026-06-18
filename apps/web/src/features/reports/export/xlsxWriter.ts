// xlsxWriter.ts — a dependency-free, single-sheet XLSX (Office Open XML SpreadsheetML) writer. We deliberately
// avoid pulling in a heavy spreadsheet library: a report export is a flat headers + rows table, so we emit the
// four minimal OOXML parts (workbook, sheet, styles, content-types + rels) and pack them into a STORED (no
// compression) ZIP. Stored entries need no deflate dependency — just CRC-32 + the local/central-directory
// records — and Excel/Numbers/LibreOffice open them identically to a compressed .xlsx.
//
// PII-free by construction: the caller (exportData.ts) only ever passes already-aggregated, workspace-scoped
// rollup rows, so this writer never sees raw contact data. It is pure (no DOM, no fetch) so it is unit-testable.

/** A worksheet cell is either text or a number; numbers render right-aligned with Excel's numeric type. */
export type XlsxCell = string | number;

/** The single-sheet table to serialize. `headers` becomes the first (bold) row; `rows` follow. */
export interface XlsxSheet {
  /** Sheet tab name (Excel caps this at 31 chars and forbids []:*?/\\). */
  name: string;
  headers: string[];
  rows: XlsxCell[][];
}

// ── CRC-32 (IEEE 802.3) — required by the ZIP local + central-directory headers ────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

const textEncoder = new TextEncoder();

/** Escape the five XML predefined entities so cell text can never break the SpreadsheetML markup. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Excel column letters for a zero-based index: 0→A, 25→Z, 26→AA … (cells need an A1-style reference). */
function columnRef(index: number): string {
  let ref = "";
  let n = index;
  do {
    ref = String.fromCharCode(65 + (n % 26)) + ref;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return ref;
}

/** Sheet names are capped at 31 chars and may not contain []:*?/\\ — sanitize so Excel never rejects the file. */
function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, " ").trim();
  return (cleaned || "Sheet1").slice(0, 31);
}

function cellXml(cell: XlsxCell, ref: string, isHeader: boolean): string {
  const style = isHeader ? ' s="1"' : "";
  if (typeof cell === "number" && Number.isFinite(cell)) {
    return `<c r="${ref}"${style}><v>${cell}</v></c>`;
  }
  // Everything else (incl. NaN/Infinity) serializes as inline text so the value is never silently dropped.
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(cell))}</t></is></c>`;
}

function rowXml(cells: XlsxCell[], rowIndex: number, isHeader: boolean): string {
  const r = rowIndex + 1; // SpreadsheetML rows are 1-based
  const body = cells.map((cell, col) => cellXml(cell, `${columnRef(col)}${r}`, isHeader)).join("");
  return `<row r="${r}">${body}</row>`;
}

/** The worksheet part: the header row (style 1 = bold) followed by the data rows. */
function buildSheetXml(sheet: XlsxSheet): string {
  const headerRow = rowXml(sheet.headers, 0, true);
  const dataRows = sheet.rows.map((cells, i) => rowXml(cells, i + 1, false)).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${headerRow}${dataRows}</sheetData></worksheet>`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

// Two cell styles: index 0 (default) and index 1 (bold) — the header row references s="1". The named "Normal"
// cellStyle keeps strict readers (openpyxl, Numbers) from warning about a missing default style.
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function workbookXml(sheetName: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

// ── Minimal STORED-ZIP packer (no deflate) ─────────────────────────────────────────────────────────────────
interface ZipEntry {
  path: string;
  data: Uint8Array;
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * Pack entries into a ZIP using STORED (method 0, no compression). A stored ZIP is just, per entry, a local
 * file header + the raw bytes, then a central directory + end-of-central-directory record. No deflate library
 * is needed; Excel reads it as a normal .xlsx. A fixed DOS date/time keeps output deterministic (testable).
 */
function packStoredZip(entries: ZipEntry[]): Uint8Array {
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = 0x21; // 1980-01-01 — fixed so the bytes are reproducible
  const localChunks: number[][] = [];
  const central: number[][] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.path);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = [
      ...u32(0x04_03_4b_50), // local file header signature
      ...u16(20), // version needed
      ...u16(0), // general purpose flag
      ...u16(0), // method 0 = stored
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(size), // compressed size = size (stored)
      ...u32(size), // uncompressed size
      ...u16(nameBytes.length),
      ...u16(0), // extra field length
      ...nameBytes,
      ...entry.data,
    ];
    localChunks.push(local);

    central.push([
      ...u32(0x02_01_4b_50), // central directory header signature
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0),
      ...u16(0), // stored
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0), // extra
      ...u16(0), // comment
      ...u16(0), // disk number
      ...u16(0), // internal attrs
      ...u32(0), // external attrs
      ...u32(offset), // local header offset
      ...nameBytes,
    ]);
    offset += local.length;
  }

  const centralStart = offset;
  const centralBytes = central.flat();
  const end = [
    ...u32(0x06_05_4b_50), // end of central directory signature
    ...u16(0), // disk number
    ...u16(0), // central dir start disk
    ...u16(entries.length), // entries on this disk
    ...u16(entries.length), // total entries
    ...u32(centralBytes.length), // central dir size
    ...u32(centralStart), // central dir offset
    ...u16(0), // comment length
  ];

  return Uint8Array.from([...localChunks.flat(), ...centralBytes, ...end]);
}

/**
 * Build a complete single-sheet .xlsx workbook from a headers + rows table and return its raw bytes. The bytes
 * are deterministic (fixed ZIP timestamps) so the writer can be asserted byte-for-byte in tests.
 */
export function buildXlsx(sheet: XlsxSheet): Uint8Array {
  const sheetName = sanitizeSheetName(sheet.name);
  const entries: ZipEntry[] = [
    { path: "[Content_Types].xml", data: textEncoder.encode(CONTENT_TYPES_XML) },
    { path: "_rels/.rels", data: textEncoder.encode(ROOT_RELS_XML) },
    { path: "xl/workbook.xml", data: textEncoder.encode(workbookXml(sheetName)) },
    { path: "xl/_rels/workbook.xml.rels", data: textEncoder.encode(WORKBOOK_RELS_XML) },
    { path: "xl/styles.xml", data: textEncoder.encode(STYLES_XML) },
    { path: "xl/worksheets/sheet1.xml", data: textEncoder.encode(buildSheetXml(sheet)) },
  ];
  return packStoredZip(entries);
}
