// api.ts — the single data seam for the extension slice. The metadata is a same-origin STATIC
// file (public/downloads/extension-meta.json), refreshed whenever the extension zip is repackaged.
// Plain fetch, no Bearer: the file is public build metadata served by this app, not an
// /api/v1/admin resource — fetchWithAuth would only add a pointless token round-trip.
import type { ExtensionMeta } from "./types";

export async function fetchExtensionMeta(): Promise<ExtensionMeta> {
  const res = await fetch("/downloads/extension-meta.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Extension metadata unavailable (${res.status})`);
  return (await res.json()) as ExtensionMeta;
}

/** The static download path for the packaged zip (same origin, no auth needed). */
export function extensionZipHref(meta: ExtensionMeta): string {
  return `/downloads/${meta.filename}`;
}
