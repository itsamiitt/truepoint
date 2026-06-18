// downloadXlsx.ts — the browser side of the XLSX export: turn a ReportDataset into .xlsx bytes (xlsxWriter) and
// trigger a client-side download. Mirrors downloadCsv (api.ts) so the page can offer CSV or XLSX from the SAME
// dataset. Side-effecting (touches document/Blob/URL) so it lives apart from the pure builders; the byte
// generation it delegates to is unit-tested.
"use client";

import type { ReportDataset } from "./exportData";
import { buildXlsx } from "./xlsxWriter";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Trigger a click-to-download for a Blob under `filename`, then revoke the object URL. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Build a single-sheet .xlsx from the dataset and download it (filename gets the .xlsx extension here). */
export function downloadXlsx(dataset: ReportDataset): void {
  const bytes = buildXlsx({
    name: dataset.sheetName,
    headers: dataset.headers,
    rows: dataset.rows,
  });
  // Copy into a fresh ArrayBuffer-backed view so the Blob is built from a plain ArrayBuffer (never a
  // SharedArrayBuffer), keeping the BlobPart type exact across TS DOM lib versions.
  const buffer = new Uint8Array(bytes);
  triggerDownload(new Blob([buffer], { type: XLSX_MIME }), `${dataset.filename}.xlsx`);
}
