// defaultMappings.salesforce.ts — the out-of-box Salesforce field-mapping presets (crm-sync §4.3). Each row
// is one CrmFieldMapping: `tpField` is a REAL contacts/accounts column (packages/db/src/schema/contacts.ts —
// `email`/`phone` are the logical PII fields stored as `email_enc`/`phone_enc`), `crmField` is the standard
// SObject field. objectType "contact" → SObject Contact, "account" → SObject Account (matching salesforce.ts
// SOBJECT). The default direction + authority follow §4.3 + the §6.1/§6.2 merge ladder, in three buckets:
//   (1) shared identity (Email, FirstName, LastName, Name) → BIDIRECTIONAL, authority unset → §6.1 LWW.
//   (2) TruePoint-enriched (Title, verified Phone, firmographics) → OUTBOUND, authority "truepoint": we fill
//       Salesforce; the merge never lets stale CRM data overwrite our verified values (confThreshold gates
//       low-confidence writes, planOutboundPush §6.2). Account `Website` is outbound-only TP→CRM because TP's
//       registrable `domain` is a clean bare host while SObject Website is a full URL — there is no
//       URL→domain transform in the phase-1 closed registry to safely ingest it back.
// CRM-owned process fields (Lead status, OwnerId) are DEFERRED for Salesforce in phase 1: standard
// Contact/Account carry no lifecycle field, and owner mapping needs CRM-id→TP-user resolution (no Lead object
// + no owner transform yet). HubSpot's lifecyclestage preset covers the inbound/authority-"crm" bucket.
// These are TUNABLE defaults — a tenant overrides any row later. PURE data: no IO, no DB, no network.

import type { CrmFieldMapping } from "@leadwolf/types";

/** Salesforce defaults for the Contact + Account SObjects. */
export const SALESFORCE_DEFAULT_MAPPINGS: CrmFieldMapping[] = [
  // ── Contact ── (1) shared identity → bidirectional + LWW; Email is the dedup/match key.
  {
    objectType: "contact",
    tpField: "email",
    crmField: "Email",
    direction: "bidirectional",
    transform: "lowercase",
    isDedupKey: true,
    enabled: true,
  },
  {
    objectType: "contact",
    tpField: "firstName",
    crmField: "FirstName",
    direction: "bidirectional",
    transform: "passthrough",
    enabled: true,
  },
  {
    objectType: "contact",
    tpField: "lastName",
    crmField: "LastName",
    direction: "bidirectional",
    transform: "passthrough",
    enabled: true,
  },
  // (2) TruePoint-enriched → outbound + authority "truepoint"; confThreshold gates low-confidence writes.
  {
    objectType: "contact",
    tpField: "jobTitle",
    crmField: "Title",
    direction: "outbound",
    authority: "truepoint",
    confThreshold: 0.5,
    transform: "passthrough",
    enabled: true,
  },
  {
    objectType: "contact",
    tpField: "phone",
    crmField: "Phone",
    direction: "outbound",
    authority: "truepoint",
    confThreshold: 0.7,
    transform: "phone_e164",
    enabled: true,
  },
  // ── Account ── (1) shared identity → bidirectional + LWW.
  {
    objectType: "account",
    tpField: "name",
    crmField: "Name",
    direction: "bidirectional",
    transform: "passthrough",
    enabled: true,
  },
  // (2) Firmographics + clean domain → outbound + authority "truepoint" (TruePoint is the firmographic source).
  {
    objectType: "account",
    tpField: "domain",
    crmField: "Website",
    direction: "outbound",
    authority: "truepoint",
    transform: "passthrough",
    enabled: true,
  },
  {
    objectType: "account",
    tpField: "industry",
    crmField: "Industry",
    direction: "outbound",
    authority: "truepoint",
    confThreshold: 0.5,
    transform: "passthrough",
    enabled: true,
  },
  {
    objectType: "account",
    tpField: "employeeCount",
    crmField: "NumberOfEmployees",
    direction: "outbound",
    authority: "truepoint",
    confThreshold: 0.5,
    transform: "passthrough",
    enabled: true,
  },
];
