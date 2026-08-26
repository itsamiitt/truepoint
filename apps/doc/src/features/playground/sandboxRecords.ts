// sandboxRecords.ts — the playground's sample dataset.
//
// THESE RECORDS ARE FABRICATED (ADR-0048 §D5), and deliberately NOT the design mock's real companies: the
// mock seeded Stripe/Vercel/Monzo with invented firmographics, and publishing invented numbers about real
// companies is exactly the claim this site refuses to make anywhere else. The firms here are the same
// fictional ones the /datasets sample rows use — reserved *.example.com domains, invented values consistent
// with those rows' employee bands — so the whole portal tells one coherent fiction.
// content.test.ts asserts the reserved-domain rule for this file alongside the dataset samples.

import type { SandboxCompany } from "./sandbox.ts";

export const SANDBOX_BALANCE = 4821;

/** The one clearly-fake key the "Use sandbox key" button fills in. Passes the tp_live_ shape check and
 *  nothing else — it is not a working credential anywhere. */
export const SANDBOX_API_KEY = "tp_live_sandbox_not_a_real_key0";

export const SANDBOX_RECORDS: Readonly<Record<string, SandboxCompany>> = {
  "northgate.example.com": {
    domain: "northgate.example.com",
    name: "Northgate Tax Partners",
    website_url: "https://northgate.example.com",
    description: "Regional tax advisory and audit practice for owner-managed businesses.",
    industry: "Accounting",
    employee_count: 74,
    revenue_range: "$10M – $50M",
    ownership_type: "private",
    year_founded: 1998,
    specialties: ["tax advisory", "audit", "bookkeeping"],
    hq_country: "US",
    hq_city: "Columbus",
    last_updated: "2026-08-12T04:19:02.114Z",
  },
  "halden.example.com": {
    domain: "halden.example.com",
    name: "Halden Systems Group",
    website_url: "https://halden.example.com",
    description: "Managed IT services and cloud migration for mid-market firms.",
    industry: "IT Services",
    employee_count: 38,
    revenue_range: "$1M – $10M",
    ownership_type: "private",
    year_founded: 2011,
    specialties: ["managed IT", "cloud migration", "security operations"],
    hq_country: "US",
    hq_city: "Raleigh",
    last_updated: "2026-07-30T11:02:41.006Z",
  },
  "beaconridge.example.com": {
    domain: "beaconridge.example.com",
    name: "Beacon Ridge CPAs",
    website_url: "https://beaconridge.example.com",
    description: "Boutique CPA firm serving construction and real-estate clients.",
    industry: "Accounting",
    employee_count: 23,
    revenue_range: "$1M – $10M",
    ownership_type: "private",
    year_founded: 2007,
    specialties: ["assurance", "construction accounting"],
    hq_country: "US",
    hq_city: "Tempe",
    last_updated: "2026-08-04T09:47:15.882Z",
  },
};

/** The chip row under the domain field: three hits, one URL that demonstrates normalisation, one miss. */
export const SANDBOX_SAMPLES: readonly string[] = [
  "northgate.example.com",
  "halden.example.com",
  "beaconridge.example.com",
  "https://www.Northgate.example.com/pricing",
  "meridian.example.com",
];
