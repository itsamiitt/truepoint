// types.ts — view-model constants for the import wizard. Domain types come from @leadwolf/types (type-only,
// so zod never enters the browser bundle); this file holds presentation concerns: the source picklist and
// the mappable-field labels/grouping the column-mapper renders.

import type { CanonicalField, SourceName } from "@leadwolf/types";

export const SOURCE_OPTIONS: { value: SourceName; label: string }[] = [
  { value: "manual", label: "Manual / other CSV" },
  { value: "apollo", label: "Apollo" },
  { value: "zoominfo", label: "ZoomInfo" },
  { value: "clearbit", label: "Clearbit" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "sales_navigator", label: "Sales Navigator" },
  { value: "hubspot", label: "HubSpot" },
  { value: "salesforce", label: "Salesforce" },
];

export interface MappableField {
  field: CanonicalField;
  label: string;
  group: "Identity" | "Person" | "Company" | "Location";
}

export const MAPPABLE_FIELDS: MappableField[] = [
  { field: "email", label: "Email", group: "Identity" },
  { field: "linkedinUrl", label: "LinkedIn URL", group: "Identity" },
  { field: "linkedinPublicId", label: "LinkedIn public id", group: "Identity" },
  { field: "salesNavLeadId", label: "Sales Nav lead id", group: "Identity" },
  { field: "firstName", label: "First name", group: "Person" },
  { field: "lastName", label: "Last name", group: "Person" },
  { field: "jobTitle", label: "Job title", group: "Person" },
  { field: "seniorityLevel", label: "Seniority", group: "Person" },
  { field: "department", label: "Department", group: "Person" },
  { field: "phone", label: "Phone", group: "Person" },
  { field: "accountName", label: "Company name", group: "Company" },
  { field: "accountDomain", label: "Company domain", group: "Company" },
  { field: "locationCountry", label: "Country", group: "Location" },
  { field: "locationCity", label: "City", group: "Location" },
];

/** At least one of these must be mapped — they are the per-workspace dedup identity keys. */
export const IDENTITY_FIELDS: CanonicalField[] = [
  "email",
  "linkedinUrl",
  "linkedinPublicId",
  "salesNavLeadId",
];
