// datasets.ts — the packaged flat-file datasets.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE SAMPLE ROWS BELOW ARE FABRICATED. Every name is invented and every domain is under example.com, which
// RFC 2606 reserves so it can never belong to a real company. That is not squeamishness — it is the only
// posture that survives review.
//
// The source brief (DocappPlan/10, weeks 3-4) asks for "a 25-row sample" of the real dataset on each public
// page. A public page carrying real business-contact records is an anonymous egress of personal data that
// nobody can suppress and nobody can erase: docs/strategy/09-compliance.md requires suppression enforced at
// EVERY egress and erasure propagated within 72 hours, and a statically-published HTML table satisfies
// neither — once it is served and cached, an opt-out cannot reach it. So the public page publishes the FIELD
// LIST, which is what a buyer is actually evaluating, with illustrative rows to show shape. A real sample
// goes out through an authenticated, suppression-checked, logged path. See ADR-0048 §D5.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

import type { Dataset } from "./types.ts";

export const SAMPLE_NOTICE =
  "Illustrative rows. These are fabricated records on reserved example.com domains, shown to demonstrate the shape of the file — not a sample of the data itself.";

const CONTACT_FIELDS = [
  { name: "company_name", type: "string", description: "Registered or trading name." },
  {
    name: "domain",
    type: "string",
    description: "Primary web domain — the join key you will use.",
  },
  {
    name: "employee_band",
    type: "string",
    description: "Headcount band rather than a false-precision number.",
  },
  { name: "city", type: "string", description: "Primary office city." },
  { name: "state", type: "string", description: "State or region." },
  {
    name: "contact_name",
    type: "string",
    description: "A decision-maker at the firm. One to three per company, depending on the tier.",
  },
  { name: "contact_title", type: "string", description: "That person's role." },
  {
    name: "contact_email",
    type: "string",
    description:
      "Verified work address. Rows failing verification are dropped rather than shipped.",
    provenance: true,
  },
  {
    name: "verified_at",
    type: "date",
    description:
      "When the address last passed verification. This is the field that tells you how old the file really is.",
    provenance: true,
  },
] as const;

export const DATASETS: readonly Dataset[] = [
  {
    slug: "us-accounting-firms",
    name: "US accounting and CPA firms",
    summary:
      "Independent US accounting and CPA firms in the 10–200 employee range, each with verified partner or owner contacts.",
    coverage: "United States · 10–200 employees",
    refresh: "Monthly, with verified_at stamped per row",
    availability: "planned",
    fields: CONTACT_FIELDS,
    sampleRows: [
      {
        company_name: "Northgate Tax Partners",
        domain: "northgate.example.com",
        employee_band: "50–99",
        city: "Columbus",
        state: "OH",
        contact_name: "Dana Whitfield",
        contact_title: "Managing Partner",
        contact_email: "d.whitfield@northgate.example.com",
        verified_at: "2026-08-04",
      },
      {
        company_name: "Beacon Ridge CPAs",
        domain: "beaconridge.example.com",
        employee_band: "10–49",
        city: "Tempe",
        state: "AZ",
        contact_name: "Marcus Iyer",
        contact_title: "Owner",
        contact_email: "marcus@beaconridge.example.com",
        verified_at: "2026-08-11",
      },
    ],
  },
  {
    slug: "us-managed-it-services",
    name: "US managed IT service providers",
    summary:
      "US MSPs and IT services firms, with owner or operations-lead contacts. The second vertical, chosen from customer conversations rather than guessed at.",
    coverage: "United States · 10–200 employees",
    refresh: "Monthly, with verified_at stamped per row",
    availability: "planned",
    fields: CONTACT_FIELDS,
    sampleRows: [
      {
        company_name: "Halden Systems Group",
        domain: "halden.example.com",
        employee_band: "10–49",
        city: "Raleigh",
        state: "NC",
        contact_name: "Priya Raman",
        contact_title: "Director of Operations",
        contact_email: "p.raman@halden.example.com",
        verified_at: "2026-07-29",
      },
    ],
  },
];

export function findDataset(slug: string): Dataset | undefined {
  return DATASETS.find((dataset) => dataset.slug === slug);
}
