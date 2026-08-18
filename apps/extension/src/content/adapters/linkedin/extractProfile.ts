// extractProfile.ts — the public LinkedIn profile (/in/<slug>) extractor: VISIBLE top-card text only,
// SCOPED to the page's main region and passed through the plausibility guards so page chrome can never
// become a name (Layer-0-as-database plan, slice 5b). No private-API reads, no network patching.
import type { CapturedRecord } from "../../../shared/types.ts";
import {
  firstPlausible,
  isPlausiblePersonName,
  isPlausibleShortField,
} from "../../extract/guards.ts";

const NAME_SELECTORS = [
  "main h1",
  "section[data-member-id] h1",
  ".pv-top-card h1",
  ".pv-text-details__left-panel h1",
  "h1",
] as const;
const HEADLINE_SELECTORS = [
  ".pv-text-details__left-panel .text-body-medium.break-words",
  "main .text-body-medium.break-words",
  ".pv-top-card .text-body-medium",
  "main [data-generated-suggestion-target] .text-body-medium",
] as const;
const LOCATION_SELECTORS = [
  ".pv-text-details__left-panel .text-body-small.inline.t-black--light",
  "main .text-body-small.inline.t-black--light",
  "main span.text-body-small.inline",
] as const;
const COMPANY_SELECTORS = [
  ".pv-text-details__right-panel button[aria-label] span",
  ".pv-text-details__right-panel .inline-show-more-text",
  "main [aria-label^='Current company'] span[aria-hidden='true']",
] as const;

export function extractPublicProfile(
  url: URL,
  doc: Document,
  publicId: string,
): CapturedRecord | null {
  const root: ParentNode = doc.querySelector("main") ?? doc;
  const fullName = firstPlausible(root, NAME_SELECTORS, isPlausiblePersonName);
  const jobTitle = firstPlausible(root, HEADLINE_SELECTORS, (s) => isPlausibleShortField(s));
  const location = firstPlausible(root, LOCATION_SELECTORS, (s) => isPlausibleShortField(s, 100));
  const company = firstPlausible(root, COMPANY_SELECTORS, (s) => isPlausibleShortField(s, 100));
  const profileUrl = `${url.origin}/in/${encodeURIComponent(publicId)}`;
  return {
    subjectKey: publicId,
    adapter: "linkedin",
    pageType: "profile",
    fields: { fullName, jobTitle, location, company, profileUrl, publicId },
    sourceUrl: url.href,
    capturedAt: new Date().toISOString(),
  };
}
