// arch-map.mjs — shared library for the architecture-map generator and the Stop-hook detector.
// Single responsibility: discover source files under the roots, hash the file SET (tree shape, not
// content), and deterministically bucket each file into a domain/shared/unassigned slot.
// Pure + side-effect-free except for filesystem READS. See navigation-map-spec.md for the contract.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, posix, sep } from "node:path";

export const ROOTS = ["apps", "packages"];

const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".git",
]);

// Canonical domain enumeration — sourced from docs/planning/05 (modules) + 11 §2/§6 (6 destinations).
// A folder segment outside this list is still bucketed but surfaces in warnings[].
export const CANONICAL_DOMAINS = [
  "auth",
  "workspaces",
  "import",
  "enrichment",
  "sales-navigator",
  "search",
  "reveal",
  "lists",
  "scoring",
  "activity",
  "billing",
  "export",
  "outreach",
  "crm-sync",
  "api-public",
  "ai",
  "ai-usage",
  "alerts",
  "compliance",
  "admin-settings",
  "home",
  "prospect",
  "sequences",
  "inbox",
  "reports",
  "settings",
  "templates",
  "notifications",
  "data-health",
  "storage",
  "retention",
  "imports",
  // Settings destination is composed of per-area web slices (12 §1–§5).
  "settings-billing",
  "settings-compliance",
];

// Declared maps for the cases where the domain is NOT encoded in the path (extend as code grows).
export const QUEUE_DOMAIN = {
  enrichment: "enrichment",
  scoring: "scoring",
  imports: "import",
  bulkImports: "import",
  dataRetentionSweep: "compliance",
  "crm-sync": "crm-sync",
  outreach: "outreach",
  "search-sync": "search",
  webhook: "api-public",
  dsar: "compliance",
  reverification: "data-health",
  reverificationSweep: "data-health",
  dataQualitySnapshotSweep: "data-health",
  lowBalanceNotifierSweep: "billing",
  billingReconSweep: "billing",
  ledgerBackfillSweep: "billing",
  subscriptionGrantSweep: "billing",
  subscriptionDunningSweep: "billing",
};
export const REPO_DOMAIN = {
  contact: "reveal",
  account: "reveal",
  list: "lists",
  score: "scoring",
  outreach: "outreach",
  sequence: "outreach",
  outreachLog: "outreach",
  outreach_log: "outreach",
  salesNavLink: "sales-navigator",
  sales_nav_link: "sales-navigator",
  source_import: "import",
  sourceImport: "import",
  importJob: "import",
  importStaging: "import",
  suppression: "compliance",
  retentionPolicy: "compliance",
  retentionRun: "compliance",
  retentionScan: "compliance",
  tenant: "billing",
  user: "auth",
  workspace: "workspaces",
  api_key: "api-public",
  apiKey: "api-public",
  purchase: "billing",
  notification: "notifications",
  aiRequest: "ai",
  activity: "activity",
  intentSignal: "scoring",
  intent_signal: "scoring",
  providerCall: "enrichment",
  provider_call: "enrichment",
  reveal: "reveal",
  credit: "billing",
  stripeCustomer: "billing",
  subscription: "billing",
  audit: "compliance",
  idempotency: "billing",
  consent: "compliance",
  dsar: "compliance",
  verificationJob: "data-health",
  dataQualitySnapshot: "data-health",
};
export const PROVIDER_DOMAIN = {
  salesforce: "crm-sync",
  hubspot: "crm-sync",
  pipedrive: "crm-sync",
  apollo: "enrichment",
  zoominfo: "enrichment",
  clearbit: "enrichment",
  linkedin: "sales-navigator",
};

// The ALLOWED dependency graph (16 §5) — stamped into the JSON for the human map's reference.
export const DEPENDENCIES = {
  types: [],
  config: ["types"],
  db: ["types", "config"],
  search: ["types", "config"],
  email: ["types", "config"],
  ui: ["types"],
  analytics: ["types", "config"],
  observability: ["types", "config"],
  auth: ["db", "types", "config"],
  core: ["db", "search", "types", "config"],
  integrations: ["core", "types", "config"],
};

const FEATURE_BUCKETS = ["web", "admin", "api", "core", "db", "workers", "integrations"];

/** Recursively collect source-file paths under `root`, as POSIX-relative paths from `cwd`. */
function walk(absRoot, relRoot, out) {
  let entries;
  try {
    entries = readdirSync(absRoot, { withFileTypes: true });
  } catch {
    return; // root missing or unreadable
  }
  for (const entry of entries) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
    const abs = join(absRoot, entry.name);
    const rel = posix.join(relRoot, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const s = statSync(abs);
        isDir = s.isDirectory();
        isFile = s.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) {
      walk(abs, rel, out);
    } else if (isFile) {
      const dot = entry.name.lastIndexOf(".");
      const ext = dot >= 0 ? entry.name.slice(dot) : "";
      if (entry.name.endsWith(".d.ts")) continue;
      if (SOURCE_EXT.has(ext)) out.push(rel);
    }
  }
}

/**
 * List all source files under ROOTS for the given cwd, sorted ascending (POSIX paths).
 * Deterministic and immune to filesystem ordering.
 */
export function listSourceFiles(cwd) {
  const out = [];
  for (const root of ROOTS) {
    const abs = join(cwd, root.split("/").join(sep));
    if (existsSync(abs)) walk(abs, root, out);
  }
  out.sort();
  return out;
}

/** Stable hash of the file SET (sorted POSIX paths joined by \n). Captures tree shape, not content. */
export function fileSetHash(sortedPaths) {
  const h = createHash("sha256");
  h.update(sortedPaths.join("\n"));
  return "sha256:" + h.digest("hex");
}

/** True if any of the roots exists on disk. */
export function rootsExist(cwd) {
  return ROOTS.some((r) => existsSync(join(cwd, r.split("/").join(sep))));
}

function baseName(p) {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
function stripExt(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(0, i) : name;
}

/**
 * Classify a single POSIX path into a slot. Returns one of:
 *   { kind: "feature", domain, bucket }
 *   { kind: "shared",  area }
 *   { kind: "unassigned" }
 * First match wins — see navigation-map-spec.md §2.
 */
export function classify(p) {
  let m;

  // App feature slices (destination/domain-keyed by their own folder).
  if ((m = p.match(/^apps\/web\/src\/features\/([^/]+)\//)))
    return { kind: "feature", domain: m[1], bucket: "web" };
  if ((m = p.match(/^apps\/admin\/src\/features\/([^/]+)\//)))
    return { kind: "feature", domain: m[1], bucket: "admin" };
  if ((m = p.match(/^apps\/api\/src\/features\/([^/]+)\//)))
    return { kind: "feature", domain: m[1], bucket: "api" };

  // core domains (ports + top-level files are shared, not a domain).
  if ((m = p.match(/^packages\/core\/src\/ports\//)))
    return { kind: "shared", area: "packages/core/ports" };
  if ((m = p.match(/^packages\/core\/src\/([^/]+)\//)))
    return { kind: "feature", domain: m[1], bucket: "core" };
  if (/^packages\/core\/src\/[^/]+\.(c|m)?[tj]sx?$/.test(p))
    return { kind: "shared", area: "packages/core" };

  // db repositories -> domain via REPO_DOMAIN; rest of db is shared.
  if ((m = p.match(/^packages\/db\/src\/repositories\/(.+?)Repository\.(c|m)?[tj]sx?$/))) {
    const entity = m[1];
    const domain = REPO_DOMAIN[entity] ?? REPO_DOMAIN[entity.toLowerCase()];
    return domain ? { kind: "feature", domain, bucket: "db" } : { kind: "unassigned" };
  }
  if (/^packages\/db\//.test(p)) return { kind: "shared", area: "packages/db" };

  // worker queues -> domain via QUEUE_DOMAIN; rest of workers is shared.
  if ((m = p.match(/^apps\/workers\/src\/queues\/([^/]+)\.(c|m)?[tj]sx?$/))) {
    const domain = QUEUE_DOMAIN[m[1]];
    return domain ? { kind: "feature", domain, bucket: "workers" } : { kind: "unassigned" };
  }
  if (/^apps\/workers\//.test(p)) return { kind: "shared", area: "apps/workers" };

  // integrations -> domain via PROVIDER_DOMAIN; else shared.
  if (
    (m = p.match(/^packages\/integrations\/([^/]+)\//)) ||
    (m = p.match(/^packages\/integrations\/src\/([^/]+)\//))
  ) {
    const domain = PROVIDER_DOMAIN[m[1]];
    return domain
      ? { kind: "feature", domain, bucket: "integrations" }
      : { kind: "shared", area: "packages/integrations" };
  }

  // App routing/shared/lib/middleware.
  if ((m = p.match(/^apps\/api\/src\/middleware\//)))
    return { kind: "shared", area: "apps/api/middleware" };
  if ((m = p.match(/^apps\/([^/]+)\/src\/(app|shared|lib|components)\//)))
    return { kind: "shared", area: `apps/${m[1]}/${m[2]}` };
  if ((m = p.match(/^apps\/([^/]+)\/src\/[^/]+\.(c|m)?[tj]sx?$/)))
    return { kind: "shared", area: `apps/${m[1]}` };

  // Leaf / platform packages.
  if ((m = p.match(/^packages\/(types|config|ui|auth|search|email|analytics|observability)\//)))
    return { kind: "shared", area: `packages/${m[1]}` };

  return { kind: "unassigned" };
}

function emptyFeature() {
  const f = {};
  for (const b of FEATURE_BUCKETS) f[b] = [];
  return f;
}

/**
 * Build the full map data structure from the cwd. Returns the object that the generator serializes
 * (minus the constant header fields). Deterministic: arrays sorted, keys insertion-controlled.
 */
export function buildMap(cwd) {
  const files = listSourceFiles(cwd);
  const features = {};
  const shared = {};
  const unassigned = [];
  const encountered = new Set();

  for (const p of files) {
    const c = classify(p);
    if (c.kind === "feature") {
      encountered.add(c.domain);
      (features[c.domain] ??= emptyFeature())[c.bucket].push(p);
    } else if (c.kind === "shared") {
      (shared[c.area] ??= []).push(p);
    } else {
      unassigned.push(p);
    }
  }

  // Sort every array for byte-stability.
  for (const dom of Object.values(features)) for (const b of FEATURE_BUCKETS) dom[b].sort();
  for (const area of Object.keys(shared)) shared[area].sort();
  unassigned.sort();

  const warnings = [];
  for (const d of [...encountered].sort()) {
    if (!CANONICAL_DOMAINS.includes(d)) {
      warnings.push(
        `undeclared domain '${d}' — add to CANONICAL_DOMAINS in lib/arch-map.mjs or rename the folder`,
      );
    }
  }

  const domains = [...new Set([...CANONICAL_DOMAINS, ...encountered])].sort();

  // Re-key features and shared in sorted order for stable JSON.
  const sortedFeatures = {};
  for (const d of Object.keys(features).sort()) sortedFeatures[d] = features[d];
  const sortedShared = {};
  for (const a of Object.keys(shared).sort()) sortedShared[a] = shared[a];

  return {
    fileCount: files.length,
    fileSetHash: fileSetHash(files),
    domains,
    features: sortedFeatures,
    shared: sortedShared,
    unassigned,
    warnings,
  };
}
