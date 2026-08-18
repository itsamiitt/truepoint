// extractLead.ts — the Sales Navigator lead page (/sales/lead/<id>, /sales/people/<id>) extractor.
// Sales Navigator is a separate app with its own markup: the public-profile Artdeco classes match
// nothing here, and a bare `h1` is the app's page-level heading ("Sales Navigator Lead Page") — which is
// exactly how junk contacts named after page chrome were produced. This ladder prefers Sales-Nav's stable
// `data-anonymize` attributes (the ones the product itself uses to blur PII in demos), then the top-card
// classes, always SCOPED and always GUARDED. VISIBLE text only; no private-API reads.
import type { CapturedRecord } from "../../../shared/types.ts";
import {
  firstPlausible,
  isPlausiblePersonName,
  isPlausibleShortField,
} from "../../extract/guards.ts";

const NAME_SELECTORS = [
  '[data-anonymize="person-name"]',
  ".profile-topcard-person-entity__name",
  "section.profile-topcard h1",
  "main h1",
] as const;
const TITLE_SELECTORS = [
  '[data-anonymize="job-title"]',
  '[data-anonymize="headline"]',
  ".profile-topcard__summary-position-title",
  ".profile-topcard-person-entity__content .t-14",
] as const;
const COMPANY_SELECTORS = [
  '[data-anonymize="company-name"]',
  ".profile-topcard__summary-position-company",
  ".profile-topcard__current-positions a[href*='/sales/company/']",
] as const;
const LOCATION_SELECTORS = [
  '[data-anonymize="location"]',
  ".profile-topcard__location-data",
  ".profile-topcard-person-entity__location",
] as const;

export function extractSalesNavLead(
  url: URL,
  doc: Document,
  leadId: string,
): CapturedRecord | null {
  const root: ParentNode = doc.querySelector("main") ?? doc;
  const fullName = firstPlausible(root, NAME_SELECTORS, isPlausiblePersonName);
  const jobTitle = firstPlausible(root, TITLE_SELECTORS, (s) => isPlausibleShortField(s));
  const company = firstPlausible(root, COMPANY_SELECTORS, (s) => isPlausibleShortField(s, 100));
  const location = firstPlausible(root, LOCATION_SELECTORS, (s) => isPlausibleShortField(s, 100));
  return {
    subjectKey: `sales-lead:${leadId}`,
    adapter: "linkedin",
    pageType: "profile",
    fields: {
      fullName,
      jobTitle,
      company,
      location,
      profileUrl: `https://www.linkedin.com/sales/lead/${encodeURIComponent(leadId)}`,
      salesNavLeadId: leadId,
    },
    sourceUrl: url.href,
    capturedAt: new Date().toISOString(),
  };
}
