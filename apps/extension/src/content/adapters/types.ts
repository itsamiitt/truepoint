// SiteAdapter — the per-site contract (09 §3). Recognises a page, classifies it, derives a stable
// subject key, and extracts the VISIBLE profile into the shared CapturedRecord. Adding a site = adding
// an adapter, not a permission.
import type { CapturedRecord, PageType } from "../../shared/types.ts";

export interface SiteAdapter {
  id: "linkedin" | "generic";
  matches(url: URL): boolean;
  pageType(url: URL): PageType;
  subjectKey(url: URL): string | null;
  /** Extract the visible profile on a supported page, or null if nothing capturable is present. */
  extract(url: URL, doc: Document): CapturedRecord | null;
}
