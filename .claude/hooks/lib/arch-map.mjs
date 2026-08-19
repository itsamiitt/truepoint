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
  "forge",
  "api-public",
  "ai",
  "ai-usage",
  "alerts",
  // The Signals web DESTINATION (market-intelligence MI-P2, D-9 IA regroup). Web slices are
  // destination-keyed while api/core/db stay resource-keyed under `alerts` — the reveal/prospect split.
  "signals",
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
  // The customer-facing READ surface over the Layer-0 graph (0108): typed traversals on a tenant-visible
  // account — "what does this company build" vs "what does it run". Distinct from `master-sync`, which is
  // the Forge→Layer-0 WRITE ingress; these are opposite directions across the same wall.
  "account-intelligence",
  "storage",
  "retention",
  "imports",
  // Settings destination is composed of per-area web slices (12 §1–§5).
  "settings-billing",
  "settings-compliance",
  "teams",
];

// Declared maps for the cases where the domain is NOT encoded in the path (extend as code grows).
export const QUEUE_DOMAIN = {
  // Backfill of the previously unbucketed queues. Colocated .test/.itest files place with their queue.
  bulkEnrichment: "enrichment",
  bulkReveal: "reveal",
  dedup: "contacts-dedup",
  erSweep: "er",
  firmographics: "enrichment",
  masterBackfill: "master-sync",
  masterBackfillSweep: "master-sync",
  // linkedin_api company-refresh sweep (docs/planning/linkedin-source-ingestion/): a Layer-0 platform lane
  // feeding the same system-owned graph the master* queues do.
  linkedinCompanyRefresh: "master-sync",
  // The 30-day URL-registry fetch sweep (docs/planning ecosystem) — a Layer-0 platform lane feeding the
  // same system-owned graph the master* queues do.
  linkedinLinkFetchSweep: "master-sync",
  // The customer-triggered per-account company refresh — tenant-metered like enrichment, so it lives there.
  accountRefresh: "enrichment",
  partitionSweep: "data-ops",
  projectionSweep: "projection",
  retentionSweep: "retention",
  sequenceTick: "outreach",
  tokenRefresh: "email",
  // crm-sync's consumers. crmSync carries pull/inbound/push/backfill (one file, four processors — they share
  // the run-ledger and gate plumbing); crmSyncSweep is the leader-locked scheduler; crmErase is the DSAR path.
  crmSync: "crm-sync",
  crmSyncSweep: "crm-sync",
  crmErase: "crm-sync",
  enrichment: "enrichment",
  scoring: "scoring",
  imports: "import",
  bulkImports: "import",
  importNotify: "import",
  importReaperSweep: "import",
  importPromotionSweep: "import",
  importArtifactSweep: "import",
  channelBackfillSweep: "reveal",
  channelReconcileSweep: "reveal",
  accountBackfillSweep: "reveal",
  scheduledImportSweep: "import",
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
  gmailInboxPoll: "outreach",
  gmailInboxPollSweep: "outreach",
  // The S-13 job-change fan-out sweep (intelligence-platform 07 §4 slice 7.1) — the trigger the shipped
  // detectJobChange/recordJobChange stack never had. Freshness/decay, so data-health rather than scoring.
  jobChangeSweep: "data-health",
  // The company-signal fan-out sweep (market-intelligence MI-S6) — the alerts substrate's delivery step.
  signalFanout: "alerts",
};
export const REPO_DOMAIN = {
  // Backfill of every repository that was previously unbucketed. Each maps to a domain that ALREADY has code
  // in the map — no new vocabulary was invented to make a file fit. Where no existing domain was clearly
  // right the file is deliberately left unassigned: a confidently wrong home is worse than an honest gap,
  // because the map is what a newcomer navigates by.
  authAllowedOrigins: "auth",
  authPolicy: "auth-policy",
  effectivePolicy: "auth-policy",
  oauthConnectState: "email",
  webauthnCredential: "auth",
  ssoConfig: "auth",
  scimToken: "scim",
  impersonation: "staff",
  jitElevation: "staff",
  platformStaff: "staff",
  staff: "staff",
  domain: "tenants",
  // entitlements ALREADY has code in the map (packages/core/src/entitlements/{entitlementGate,resolveEntitlement}),
  // so this is the db layer of an existing domain, not a new vocabulary invented to fit a file. Deliberately NOT
  // "billing": decision D2 makes entitlements a cap layer ABOVE credits that never reads a balance, and filing it
  // under billing would encode in the map the exact conflation the code refuses to make.
  entitlement: "entitlements",
  accountHold: "billing",
  creditPack: "pricing",
  planTemplate: "plans",
  providerConfig: "provider-configs",
  // The data-source origin fleet (0117) — provider infrastructure beside providerConfig; the admin
  // surface is the data-sources slice, the consumer is core's origin router.
  providerOrigin: "provider-configs",
  // The URL fetch registry (0118, docs/planning ecosystem) — the 30-day freshness clock feeding the
  // linkedin_api landing; belongs with the master-sync graph population.
  sourceFetchRegistry: "master-sync",
  accountSearch: "account-search",
  contactExternalId: "contacts-resolve",
  contactMerge: "contacts-merge",
  customField: "custom-fields",
  tag: "tags",
  savedSearch: "saved-searches",
  search: "search",
  pipelineStage: "pipeline-stages",
  emailAnalytics: "email",
  emailEvent: "email",
  emailMessage: "email",
  emailTemplate: "email",
  emailThread: "email",
  mailbox: "email",
  sendQuota: "email",
  sendingDomain: "email",
  enrichmentJob: "enrichment-jobs",
  enrichmentPolicy: "enrichment",
  revealJob: "reveal",
  masterGraph: "master-sync",
  // Layer-0 technology/product catalog + the company-technology adoption edge (intelligence-platform
  // Group A/B, migrations 0100-0101). Same domain as masterGraph: it is the same system-owned graph.
  masterTechnology: "master-sync",
  // Layer-0 canonical signal store (migration 0103) — same system-owned graph.
  masterSignals: "master-sync",
  // Layer-0 confidence-policy constants (migration 0107; C9 resolution 2026-08-19) — same system-owned
  // graph, read under the same withErTx access path as its siblings.
  masterConfidencePolicy: "master-sync",
  // The signal fan-out pair (market-intelligence MI-S6): the owner-conn census and the tenant_signals
  // projection. Registered under the canonical `alerts` domain — tenant_signals IS the alerts substrate.
  signalFanout: "alerts",
  tenantSignals: "alerts",
  // Watchlists + signal subscriptions (MI-S5) — the opt-in layer of the same alerts substrate.
  watchlist: "alerts",
  // Layer-0 company/person completeness tables (migration 0104) — same system-owned graph.
  masterCompanyDetail: "master-sync",
  // Layer-0 person↔organization EDUCATION edge (migration 0108) — same system-owned graph. The sibling of
  // master_employment: schools are master_companies rows with org_kind='school', so "works at" and
  // "studied at" traverse one catalog.
  masterEducation: "master-sync",
  // READ side of the Layer-0 employment edge (plan 33 · A2) — same system-owned graph, split from
  // masterGraphRepository because that module owns the ingest-critical write path.
  masterEmploymentRead: "master-sync",
  // Layer-0 profile/edge/series writers for the linkedin_api landing (0112-0115) — same system-owned
  // graph; split from masterGraphRepository for the same reason masterEmploymentRead is: that module owns
  // the resolve chokepoint, this one owns the fold-applied fact writes.
  masterProfile: "master-sync",
  // The CUSTOMER read seams over the same Layer-0 graph (Layer-0-as-database): the visibility-filtered
  // person read, the global database search, and the reveal channel read. Same system-owned tables and the
  // same withErTx access path as the writers above — they differ only in direction.
  masterPersonRead: "master-sync",
  masterPersonSearch: "master-sync",
  masterChannelRead: "master-sync",
  er: "er",
  evidence: "ingestion",
  projector: "projection",
  reports: "reports",
  subProcessor: "compliance",
  retentionClassPolicy: "retention",
  validationRule: "validation",
  featureFlag: "feature-flags",
  announcement: "announcements",
  supportNote: "staff",
  webhook: "webhooks",
  partition: "data-ops",
  scheduler: "imports",
  // The flat Forge sync repository. Its siblings live under repositories/forge/ and are matched by a path
  // rule instead — this one is at the top level, so it needs an entry.
  forgeSync: "forge",
  // CRM bidirectional sync (crm-sync). The domain was already declared in CANONICAL_DOMAINS; these are its
  // repositories. Registered here rather than renamed in code because the file names are already correct —
  // the map's rule is "one entity per repository", and each of these owns a distinct table.
  crmConnection: "crm-sync",
  crmOauthState: "crm-sync",
  crmFieldMapping: "crm-sync",
  crmRecordLink: "crm-sync",
  crmSyncState: "crm-sync",
  crmSyncRun: "crm-sync",
  crmSyncConflict: "crm-sync",
  crmDeadLetter: "crm-sync",
  crmHealth: "crm-sync",
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
  // Contact-channel overlay (contact_emails/contact_phones, import-and-data-model-redesign S-CH1+):
  // rides the contact/reveal domain like the contact repo itself.
  contactChannel: "reveal",
  source_import: "import",
  sourceImport: "import",
  importJob: "import",
  importStaging: "import",
  importMappingTemplate: "import",
  // Per-workspace import policy (who_can_import + strategy defaults; P0 of import-and-data-model-redesign).
  importPolicy: "import",
  // P5 scheduled imports (import-and-data-model-redesign 08 §9): the recurring-import definition + fires.
  scheduledImport: "import",
  // 06-family company children (account_domains/account_locations/hierarchy; Phase 4) — reveal, like accounts.
  accountChild: "reveal",
  suppression: "compliance",
  // The customer's controls over what of their data reaches the shared graph (Phase 4 contributor controls).
  // compliance, not crm-sync: the exclusion list is deliberately channel-agnostic, so filing it under the
  // channel that prompted it would misdescribe what it governs.
  contributionPolicy: "compliance",
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
  // The S-13 job-change fan-out sweep's data access (intelligence-platform 07 §4 slice 7.1). Filed under
  // data-health, not scoring: it reads Layer-0 employment to decide whether a record has gone stale, which is
  // the freshness question — the intent_signal it ultimately writes is the OUTPUT, not the subject.
  jobChangeSweep: "data-health",
  // The corroboration half of the S-10 confidence badge ("⟨k⟩ independent sources"), read under withErTx
  // because provenance_event is REVOKE'd from leadwolf_app. Was unassigned; data-health is where its twin
  // (the freshness half, computeContactDataQuality) already lives.
  provenanceBadge: "data-health",
  providerCall: "enrichment",
  provider_call: "enrichment",
  // The transactional outbox (worker_outbox + event_outbox, ADR-0027): generic mechanism. Originally only the
  // bulk-enrichment confirm→drive publish; import now co-adopts it (import.rollups/import.notify, S-Q3/S-Q4).
  // Shared infra in practice; kept under enrichment (first + primary producer) since the map has no "shared repo".
  outbox: "enrichment",
  eventOutbox: "enrichment",
  reveal: "reveal",
  credit: "billing",
  stripeCustomer: "billing",
  subscription: "billing",
  team: "teams",
  audit: "compliance",
  idempotency: "billing",
  consent: "compliance",
  dsar: "compliance",
  verificationJob: "data-health",
  dataQualitySnapshot: "data-health",
};
/**
 * Folder slugs that mean the SAME domain under a different name.
 *
 * Domains derived from a folder name inherit whatever that folder is called, so one concept split across two
 * layers with two spellings becomes two unrelated domains in the map. That is the specific harm a navigation
 * map exists to prevent: `apps/api/src/features/ingest/` and `packages/core/src/ingestion/` are one ingestion
 * path, and a reader asking "where does ingestion live" was being shown half of it.
 *
 * The API/web feature-folder spelling wins, because that is the name the `/api/v1` surface already publishes.
 * Aliasing rather than renaming the folder is deliberate: a rename touches every importer for a cosmetic gain,
 * and CLAUDE.md is explicit that structure rules never justify churn in correctness-bearing code.
 */
/**
 * `packages/core/src/*` folders that are cross-cutting infrastructure, NOT feature domains.
 *
 * The core rule turns any folder name into a domain, which is right for `scoring/` or `retention/` — those
 * have api/web/db counterparts and are genuinely features. It is wrong for the PORTS. CLAUDE.md states core
 * "owns all ports", and a port is consumed by every domain rather than belonging to one: `storage/fileStore.ts`
 * and `security/malwareScanner.ts` describe themselves as siblings in exactly that role, and `cache/readThrough`
 * is a tier sitting in front of other domains' reads.
 *
 * Listing them as domains made the map claim three features that do not exist, and diluted the domain list —
 * which is the thing a newcomer reads to learn what this product DOES. Each is core-only (verified: no api,
 * web or db file buckets to any of them), so nothing is orphaned by moving them to the shared area.
 *
 * Keep this list SHORT and explicit. A new core folder should surface as a domain and get a deliberate
 * decision, exactly as REPO_DOMAIN's header argues — not be silently absorbed into "shared".
 */
export const CORE_SHARED_FOLDERS = new Set(["cache", "security", "storage"]);

export const DOMAIN_ALIAS = {
  ingestion: "ingest",
};

export const PROVIDER_DOMAIN = {
  "crm-sync": "crm-sync", // the shared connector/budget-store folder (the per-vendor files live inside it)
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
  if ((m = p.match(/^packages\/core\/src\/([^/]+)\//))) {
    if (CORE_SHARED_FOLDERS.has(m[1])) return { kind: "shared", area: "packages/core" };
    return { kind: "feature", domain: DOMAIN_ALIAS[m[1]] ?? m[1], bucket: "core" };
  }
  if (/^packages\/core\/src\/[^/]+\.(c|m)?[tj]sx?$/.test(p))
    return { kind: "shared", area: "packages/core" };

  // Forge data-plane repositories live in a subfolder (packages/db/src/repositories/forge/), which the flat
  // rule below cannot match — its capture would be "forge/read" rather than an entity name. They are all one
  // domain, so a single rule is more honest than nine registry entries keyed on a path fragment.
  if (/^packages\/db\/src\/repositories\/forge\//.test(p))
    return { kind: "feature", domain: "forge", bucket: "db" };

  // db repositories -> domain via REPO_DOMAIN; rest of db is shared.
  if ((m = p.match(/^packages\/db\/src\/repositories\/(.+?)Repository\.(c|m)?[tj]sx?$/))) {
    const entity = m[1];
    const raw = REPO_DOMAIN[entity] ?? REPO_DOMAIN[entity.toLowerCase()];
    const domain = raw ? (DOMAIN_ALIAS[raw] ?? raw) : raw;
    return domain ? { kind: "feature", domain, bucket: "db" } : { kind: "unassigned" };
  }
  if (/^packages\/db\//.test(p)) return { kind: "shared", area: "packages/db" };

  // worker queues -> domain via QUEUE_DOMAIN; rest of workers is shared. Colocated `.test`/`.itest`
  // files place with their queue (strip the suffix before lookup).
  if ((m = p.match(/^apps\/workers\/src\/queues\/([^/]+?)(?:\.i?test)?\.(c|m)?[tj]sx?$/))) {
    const raw = QUEUE_DOMAIN[m[1]];
    const domain = raw ? (DOMAIN_ALIAS[raw] ?? raw) : raw;
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

  // Browser extension (apps/extension, MV3) — its surfaces (background SW, content scripts, ui, i18n) are
  // app-platform code, not domain features; extension-scoped so it never affects web/admin/api bucketing.
  if ((m = p.match(/^apps\/extension\/src\/([^/]+)\//)))
    return { kind: "shared", area: `apps/extension/${m[1]}` };
  if (/^apps\/extension\/(scripts\/|[^/]+\.(c|m)?[tj]sx?$)/.test(p))
    return { kind: "shared", area: "apps/extension" };

  // TruePoint Forge (ADR-0047) — the operator console and its BFF. Treated like apps/extension: a separate
  // surface whose slices are its own, not customer-facing domains. Minting five new domains (overview,
  // captures, parsers, review, sync-status) to hold them would pollute the vocabulary the rest of the map
  // navigates by.
  if (/^apps\/forge-api\//.test(p)) return { kind: "shared", area: "apps/forge-api" };
  if (/^apps\/forge-worker\//.test(p)) return { kind: "shared", area: "apps/forge-worker" };
  if (/^apps\/forge\/src\/features\//.test(p))
    return { kind: "shared", area: "apps/forge/features" };
  if (/^apps\/forge\//.test(p)) return { kind: "shared", area: "apps/forge" };

  // App routing/shared/lib/middleware.
  if ((m = p.match(/^apps\/api\/src\/middleware\//)))
    return { kind: "shared", area: "apps/api/middleware" };
  if ((m = p.match(/^apps\/([^/]+)\/src\/(app|shared|lib|components)\//)))
    return { kind: "shared", area: `apps/${m[1]}/${m[2]}` };
  if ((m = p.match(/^apps\/([^/]+)\/src\/[^/]+\.(c|m)?[tj]sx?$/)))
    return { kind: "shared", area: `apps/${m[1]}` };

  // Leaf / platform packages.
  // Leaf/platform packages. auth-client, identity, forge-core and forge-capture-sdk belong here for the same
  // reason the rest do: they are shared platform code consumed across domains, not a domain of their own.
  // Listing them explicitly rather than making this a catch-all keeps the failure LOUD — a genuinely new
  // package shows up as unassigned and gets a deliberate decision, instead of silently becoming "shared".
  if (
    (m = p.match(
      /^packages\/(types|config|ui|app-shell|auth|auth-client|identity|forge-core|forge-capture-sdk|search|email|analytics|observability)\//,
    ))
  )
    return { kind: "shared", area: `packages/${m[1]}` };

  // Build/tooling config at an app or package ROOT (next.config.mjs, postcss.config.mjs, …). This is not
  // domain code and never can be — Next.js requires next.config at exactly this path — so reporting it as a
  // placement violation is noise. It mattered: four such files sat permanently in `unassigned`, which the
  // navigation-map spec renders as "Violations to fix". A violations list that can never reach zero trains
  // readers to ignore it, and then a genuinely misplaced file hides among the furniture. Scoped to *.config.*
  // at a ROOT only, so a stray file inside src/ still surfaces loudly.
  if ((m = p.match(/^(apps|packages)\/([^/]+)\/[^/]*\.config\.(c|m)?[tj]s$/)))
    return { kind: "shared", area: `${m[1]}/${m[2]}` };

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
