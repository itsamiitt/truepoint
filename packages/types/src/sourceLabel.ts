// sourceLabel.ts — the ONE map from an internal source/provider id to customer-facing copy
// (Layer-0-as-database plan, slice 7 [S-10]).
//
// Which upstream vendor supplied a field is INTERNAL: it is a commercial detail of how the platform buys
// data, it changes without the customer's involvement, and naming it in the product turns every provider
// swap into a UI migration. The customer-facing vocabulary is therefore: what THEY did (manual entry, an
// import, the browser extension), what THEIR systems did (HubSpot, Salesforce), or "Data source" /
// "TruePoint database" for anything the platform sourced. Confidence is still expressed the honest way —
// as a SOURCE COUNT — which names nobody.
export const VENDOR_SOURCE_IDS = [
  "apollo",
  "zoominfo",
  "clearbit",
  "pdl",
  "coresignal",
  "linkedin_api",
  "coop",
  "forge",
] as const;

const LABELS: Readonly<Record<string, string>> = {
  manual: "Manual entry",
  hubspot: "HubSpot",
  salesforce: "Salesforce",
  chrome_extension: "Browser extension",
  database: "TruePoint database",
  internal: "TruePoint",
  // The user's OWN export/import of their LinkedIn data — their action, so it keeps its name.
  linkedin: "LinkedIn export",
  sales_navigator: "LinkedIn export",
};

/** Customer-facing label for a source/provider id. Anything not listed is "Data source" by design. */
export function sourceLabel(id: string | null | undefined): string {
  if (!id) return "Data source";
  return LABELS[id] ?? "Data source";
}
