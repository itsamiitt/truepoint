// Internal barrel for the reports export concern (charts + export are private to the slice; the slice's only
// public surface stays ReportsPage via ../index.ts). Groups the format-agnostic dataset builders, the XLSX
// byte writer, and the two download triggers (CSV via the shared api.downloadCsv, XLSX via downloadXlsx).
"use client";

import { downloadCsv } from "../api";
import { downloadXlsx } from "./downloadXlsx";
import type { ReportDataset } from "./exportData";

export type { ReportDataset } from "./exportData";
export {
  creditUsageDataset,
  dataHealthDataset,
  funnelDataset,
  teamDataset,
} from "./exportData";
export { downloadXlsx } from "./downloadXlsx";
export { buildXlsx, type XlsxCell, type XlsxSheet } from "./xlsxWriter";

/** The two export formats the page offers from a single dataset. */
export type ExportFormat = "csv" | "xlsx";

/** Download a built dataset in the chosen format — identical columns/values either way (CSV reuses downloadCsv). */
export function downloadDataset(dataset: ReportDataset, format: ExportFormat): void {
  if (format === "xlsx") {
    downloadXlsx(dataset);
    return;
  }
  downloadCsv(`${dataset.filename}.csv`, dataset.headers, dataset.rows);
}
