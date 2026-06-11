// useImport.ts — view state for running an import: busy flag, the returned summary, and any error. Wraps
// the slice's api.postImport; holds no business logic (the pipeline runs server-side in packages/core).
"use client";

import type { ColumnMapping, ImportSummary, SourceName } from "@leadwolf/types";
import { useState } from "react";
import { postImport } from "../api";

export interface RunArgs {
  file: File;
  sourceName: SourceName;
  mapping: ColumnMapping;
}

export function useImport() {
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(args: RunArgs): Promise<ImportSummary | null> {
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const s = await postImport(args);
      setSummary(s);
      return s;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { summary, error, busy, run };
}
