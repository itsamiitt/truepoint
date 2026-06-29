// defaultMappings.hubspot.ts — the out-of-box HubSpot field-mapping presets (crm-sync §4.3). Each row is one
// CrmFieldMapping: `tpField` is a REAL contacts/accounts column (packages/db/src/schema/contacts.ts — `email`
// is the logical PII field stored as `email_enc`/`email_blind_index`, likewise `phone` → `phone_enc`), and
// `crmField` is the standard HubSpot property. The default direction + authority follow §4.3 + the §6.1/§6.2
// merge ladder, in three buckets:
//   (1) shared identity (email, first/last name, company name, domain) → BIDIRECTIONAL, authority unset, so
//       the §6.1 last-write-wins tiebreak lets either side update.
//   (2) TruePoint-enriched (verified phone, job title, firmographics) → OUTBOUND, authority "truepoint": we
//       fill HubSpot and the inbound merge never lets stale CRM data overwrite our verified values; a
//       confThreshold keeps low-confidence enrichment out of the CRM (planOutboundPush §6.2).
//   (3) CRM-owned process (lifecycle stage) → INBOUND, authority "crm": HubSpot is the system of record.
// These are TUNABLE defaults — a tenant overrides any row later. PURE data: no IO, no DB, no network.

import type { CrmFieldMapping } from "@leadwolf/types";

/** HubSpot defaults for contacts (object "contacts") + companies (object "account"). */
export const HUBSPOT_DEFAULT_MAPPINGS: CrmFieldMapping[] = [
  // ── Contacts ── (1) shared identity → bidirectional + LWW; email is the dedup/match key.
  {
    objectType: "contact",
    tpField: "email",
    crmField: "email",
    direction: "bidirectional",
    transform: "lowercase",
    isDedupKey: true,
    enabled: true,
  },
  {
    objectType: "contact",
    tpField: "firstName",
    crmField: "firstname",
    direction: "bidirectional",
    transform: "passthrough",
    enabled: true,
  },
  {
    objectType: "contact",
    tpField: "lastName",
    crmField: "lastname",
    direction: "bidirectional",
    transform: "passthrough",
    enabled: true,
  },
  // (2) TruePoint-enriched → outbound + authority "truepoint"; confThreshold gates low-confidence writes.
  {
    objectType: "contact",
    tpField: "jobTitle",
    crmField: "jobtitle",
    direction: "outbound",
    authority: "truepoint",
    confThreshold: 0.5,
    transform: "passthrough",
    enabled: true,
  },
  {
    objectType: "contact",
    tpField: "phone",
    crmField: "phone",
    direction: "outbound",
    authority: "truepoint",
    confThreshold: 0.7,
    transform: "phone_e164",
    enabled: true,
  },
  // (3) CRM-owned process → inbound + authority "crm". picklist_map translates the HubSpot lifecycle stage
  // into the TP outreach_status enum (the value map is tenant config); disable if TP drives outreach itself.
  {
    objectType: "contact",
    tpField: "outreachStatus",
    crmField: "lifecyclestage",
    direction: "inbound",
    authority: "crm",
    transform: "picklist_map",
    enabled: true,
  },
  // ── Accounts ── (1) shared identity → bidirectional + LWW; HubSpot `domain` is a bare dedup key.
  {
    objectType: "account",
    tpField: "name",
    crmField: "name",
    direction: "bidirectional",
    transform: "passthrough",
    enabled: true,
  },
  {
    objectType: "account",
    tpField: "domain",
    crmField: "domain",
    direction: "bidirectional",
    transform: "lowercase",
    isDedupKey: true,
    enabled: true,
  },
  // (2) Firmographics → outbound + authority "truepoint" (TruePoint is the authority on firmographic data).
  {
    objectType: "account",
    tpField: "industry",
    crmField: "industry",
    direction: "outbound",
    authority: "truepoint",
    confThreshold: 0.5,
    transform: "passthrough",
    enabled: true,
  },
  {
    objectType: "account",
    tpField: "employeeCount",
    crmField: "numberofemployees",
    direction: "outbound",
    authority: "truepoint",
    confThreshold: 0.5,
    transform: "passthrough",
    enabled: true,
  },
];
