// imports.ts — the `imports` queue processor. It validates the typed job payload and calls the SAME
// packages/core import pipeline apps/api uses (one implementation, two transports — 16 §3.2). Heavy CSV/XLSX
// imports are diverted here so the request thread stays free; the result is the new-vs-matched summary.

import { type RunImportInput, runImport } from "@leadwolf/core";
import type { ImportSummary } from "@leadwolf/types";
import type { Job } from "bullmq";

export const IMPORTS_QUEUE = "imports";

/** The job payload IS a RunImportInput (rows already parsed before enqueue). */
export type ImportJobData = RunImportInput;

export async function processImport(job: Job<ImportJobData>): Promise<ImportSummary> {
  return runImport(job.data);
}
