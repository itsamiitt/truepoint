// titleTaxonomy.ts — the seed canonical job-title taxonomy behind the synonym/abbreviation layer
// (24 §4, ADR-0035). Each canonical title carries the surface forms ("aliases") people actually type —
// including abbreviations like "CEO" — so a typed term collapses to one occupation regardless of spelling.
// This is the curated MVP seed; the production taxonomy is backfilled from O*NET-SOC/ESCO (ADR-0035 §14).
// Data only — no logic. Normalization + lookup live in normalizeTitle.ts / canonicalizeTitle.ts.

import type { SeniorityLevel, TitleFunction } from "@leadwolf/types";

/** A canonical occupation: its stable id, display label, derived seniority + function, and typed aliases. */
export interface CanonicalTitle {
  /** Stable slug id, e.g. "chief_executive_officer". Used as the index facet value (24 §4.2). */
  id: string;
  /** Display label, e.g. "Chief Executive Officer". */
  label: string;
  seniority: SeniorityLevel;
  jobFunction: TitleFunction;
  /** Surface forms a user might type (abbreviations + variants). Normalized at lookup-build time. */
  aliases: string[];
}

// ── Executive / C-suite ────────────────────────────────────────────────────────────────────────────────
const EXECUTIVE: CanonicalTitle[] = [
  {
    id: "chief_executive_officer",
    label: "Chief Executive Officer",
    seniority: "c_suite",
    jobFunction: "executive",
    aliases: ["ceo", "chief exec", "chief exec officer", "chief executive", "founder ceo"],
  },
  {
    id: "chief_technology_officer",
    label: "Chief Technology Officer",
    seniority: "c_suite",
    jobFunction: "engineering",
    aliases: ["cto", "chief tech officer", "chief technology"],
  },
  {
    id: "chief_financial_officer",
    label: "Chief Financial Officer",
    seniority: "c_suite",
    jobFunction: "finance",
    aliases: ["cfo", "chief finance officer", "chief financial"],
  },
  {
    id: "chief_operating_officer",
    label: "Chief Operating Officer",
    seniority: "c_suite",
    jobFunction: "operations",
    aliases: ["coo", "chief ops officer", "chief operations officer"],
  },
  {
    id: "chief_marketing_officer",
    label: "Chief Marketing Officer",
    seniority: "c_suite",
    jobFunction: "marketing",
    aliases: ["cmo", "chief marketing"],
  },
  {
    id: "chief_information_officer",
    label: "Chief Information Officer",
    seniority: "c_suite",
    jobFunction: "it",
    aliases: ["cio", "chief info officer"],
  },
  {
    id: "chief_revenue_officer",
    label: "Chief Revenue Officer",
    seniority: "c_suite",
    jobFunction: "sales",
    aliases: ["cro", "chief revenue"],
  },
  {
    id: "chief_product_officer",
    label: "Chief Product Officer",
    seniority: "c_suite",
    jobFunction: "product",
    aliases: ["cpo", "chief product"],
  },
  {
    id: "chief_information_security_officer",
    label: "Chief Information Security Officer",
    seniority: "c_suite",
    jobFunction: "it",
    aliases: ["ciso", "chief security officer", "cso"],
  },
  {
    id: "chief_data_officer",
    label: "Chief Data Officer",
    seniority: "c_suite",
    jobFunction: "data",
    aliases: ["cdo", "chief data"],
  },
  {
    id: "founder",
    label: "Founder",
    seniority: "c_suite",
    jobFunction: "executive",
    aliases: ["co founder", "cofounder", "founding partner"],
  },
];

// ── VP / Director / Manager / IC across functions ──────────────────────────────────────────────────────
const ENGINEERING: CanonicalTitle[] = [
  {
    id: "vp_engineering",
    label: "VP of Engineering",
    seniority: "vp",
    jobFunction: "engineering",
    aliases: ["vp eng", "vp engineering", "vice president engineering", "vp of eng", "head of engineering"],
  },
  {
    id: "engineering_manager",
    label: "Engineering Manager",
    seniority: "manager",
    jobFunction: "engineering",
    aliases: ["eng manager", "em", "manager engineering", "software engineering manager"],
  },
  {
    id: "software_engineer",
    label: "Software Engineer",
    seniority: "ic",
    jobFunction: "engineering",
    aliases: ["swe", "software developer", "software dev", "developer", "programmer"],
  },
  {
    id: "senior_software_engineer",
    label: "Senior Software Engineer",
    seniority: "ic",
    jobFunction: "engineering",
    aliases: ["senior swe", "senior software developer", "sr software engineer", "staff software engineer"],
  },
  {
    id: "data_engineer",
    label: "Data Engineer",
    seniority: "ic",
    jobFunction: "data",
    aliases: ["data eng", "etl engineer"],
  },
];

const PRODUCT_DESIGN: CanonicalTitle[] = [
  {
    id: "product_manager",
    label: "Product Manager",
    seniority: "manager",
    jobFunction: "product",
    aliases: ["pm", "product mgr", "senior product manager", "sr product manager", "group product manager"],
  },
  {
    id: "vp_product",
    label: "VP of Product",
    seniority: "vp",
    jobFunction: "product",
    aliases: ["vp product", "vice president product", "head of product"],
  },
  {
    id: "product_designer",
    label: "Product Designer",
    seniority: "ic",
    jobFunction: "design",
    aliases: ["ux designer", "ui designer", "ux ui designer", "designer"],
  },
];

const GTM: CanonicalTitle[] = [
  {
    id: "vp_sales",
    label: "VP of Sales",
    seniority: "vp",
    jobFunction: "sales",
    aliases: ["vp sales", "vice president sales", "head of sales"],
  },
  {
    id: "sales_development_representative",
    label: "Sales Development Representative",
    seniority: "ic",
    jobFunction: "sales",
    aliases: ["sdr", "bdr", "business development representative", "sales dev rep"],
  },
  {
    id: "account_executive",
    label: "Account Executive",
    seniority: "ic",
    jobFunction: "sales",
    aliases: ["ae", "senior account executive", "sr account executive", "enterprise account executive"],
  },
  {
    id: "vp_marketing",
    label: "VP of Marketing",
    seniority: "vp",
    jobFunction: "marketing",
    aliases: ["vp marketing", "vice president marketing", "head of marketing"],
  },
  {
    id: "marketing_manager",
    label: "Marketing Manager",
    seniority: "manager",
    jobFunction: "marketing",
    aliases: ["marketing mgr", "demand generation manager", "growth marketing manager"],
  },
  {
    id: "customer_success_manager",
    label: "Customer Success Manager",
    seniority: "manager",
    jobFunction: "customer_success",
    aliases: ["csm", "customer success mgr", "client success manager"],
  },
];

const OPS_FINANCE_HR: CanonicalTitle[] = [
  {
    id: "human_resources_manager",
    label: "Human Resources Manager",
    seniority: "manager",
    jobFunction: "hr",
    aliases: ["hr manager", "hr mgr", "people manager", "human resources"],
  },
  {
    id: "vp_people",
    label: "VP of People",
    seniority: "vp",
    jobFunction: "hr",
    aliases: ["vp people", "chro", "head of people", "vp human resources"],
  },
  {
    id: "operations_manager",
    label: "Operations Manager",
    seniority: "manager",
    jobFunction: "operations",
    aliases: ["ops manager", "ops mgr", "operations mgr"],
  },
  {
    id: "controller",
    label: "Controller",
    seniority: "manager",
    jobFunction: "finance",
    aliases: ["financial controller", "comptroller"],
  },
];

/** The full seed taxonomy. Order is not significant; lookup is by normalized alias. */
export const CANONICAL_TITLES: readonly CanonicalTitle[] = [
  ...EXECUTIVE,
  ...ENGINEERING,
  ...PRODUCT_DESIGN,
  ...GTM,
  ...OPS_FINANCE_HR,
];
