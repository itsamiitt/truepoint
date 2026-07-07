// @forge/core parser registry + selection (08 §Parser selection, §Lifecycle). Mirrors TruePoint's connector
// registry (ecosystem-facts §A) and adds a VERSION axis: a parser is keyed by (source, endpoint) and resolves
// to a SELECTED parser_version by (source, endpoint, schema_version). Selection is a FRAMEWORK responsibility
// (invariant 5) so a parser cannot mis-route itself. The one-active-version invariant makes cut-over atomic;
// the (source,endpoint)→active map is cached with explicit invalidation on any lifecycle transition (OQ-R16).
import type { Parser } from "./parser.ts";

export type VersionStatus = "draft" | "active" | "deprecated" | "retired";

export interface ParserVersion {
  id: string;
  /** the parser's own SchemaVer (08 §Schema evolution). */
  version: string;
  status: VersionStatus;
  parser: Parser;
  /** upstream schema_versions this version admits without a fingerprint fallback. */
  acceptedInputVersions: string[];
  /** the expected raw-shape fingerprint (08 §selection step 3; carried on the raw_captures row). */
  shapeFingerprint: string;
  supersedesVersionId?: string;
}

interface ParserEntry {
  source: string;
  endpoint: string;
  versions: ParserVersion[];
}

export type SelectionOutcome =
  | { kind: "parse"; version: ParserVersion }
  | {
      kind: "quarantine";
      route: "NO_PARSER" | "NO_ACTIVE_VERSION" | "SHAPE_DRIFT";
      reason: string;
    };

const key = (source: string, endpoint: string): string => `${source}::${endpoint}`;

export class ParserRegistry {
  private readonly parsers = new Map<string, ParserEntry>();
  private readonly activeCache = new Map<string, ParserVersion | null>();

  /** Register a parser for (source, endpoint) — idempotent (mirrors registerBuiltinConnectors, §A). */
  registerParser(source: string, endpoint: string): void {
    const k = key(source, endpoint);
    if (!this.parsers.has(k)) this.parsers.set(k, { source, endpoint, versions: [] });
  }

  /** Add a version (defaults to `draft`). Publishing is a separate, guarded transition. */
  addVersion(
    source: string,
    endpoint: string,
    version: Omit<ParserVersion, "status"> & { status?: VersionStatus },
  ): void {
    this.registerParser(source, endpoint);
    const entry = this.parsers.get(key(source, endpoint));
    if (!entry) return;
    entry.versions.push({ status: version.status ?? "draft", ...version });
    this.invalidate(source, endpoint);
  }

  /** PUBLISH draft→active (08 §Lifecycle): enforces exactly ONE active per parser (atomic cut-over),
   *  deprecates the prior active, and invalidates the selection cache. Maker-checker approval + golden-fixture
   *  gate are enforced upstream (P4 approval_requests + P2 §B.5); this is the atomic registry mutation. */
  publish(source: string, endpoint: string, versionId: string): void {
    const entry = this.parsers.get(key(source, endpoint));
    if (!entry) throw new Error(`no parser for ${key(source, endpoint)}`);
    const target = entry.versions.find((v) => v.id === versionId);
    if (!target) throw new Error(`no version ${versionId}`);
    if (target.status !== "draft" && target.status !== "deprecated") {
      throw new Error(`version ${versionId} is ${target.status}, not publishable`);
    }
    for (const v of entry.versions) {
      if (v.status === "active" && v.id !== versionId) v.status = "deprecated";
    }
    target.status = "active";
    this.invalidate(source, endpoint);
  }

  /** Deprecate the active version (08 §Lifecycle) — rollback re-promotes a prior version via publish(). */
  deprecate(source: string, endpoint: string, versionId: string): void {
    const entry = this.parsers.get(key(source, endpoint));
    const v = entry?.versions.find((x) => x.id === versionId);
    if (v && v.status === "active") {
      v.status = "deprecated";
      this.invalidate(source, endpoint);
    }
  }

  /** The single active version (≤1 by the one-active invariant), cached with explicit invalidation. */
  activeVersion(source: string, endpoint: string): ParserVersion | null {
    const k = key(source, endpoint);
    if (this.activeCache.has(k)) return this.activeCache.get(k) ?? null;
    const active = this.parsers.get(k)?.versions.find((v) => v.status === "active") ?? null;
    this.activeCache.set(k, active);
    return active;
  }

  invalidate(source: string, endpoint: string): void {
    this.activeCache.delete(key(source, endpoint));
  }

  /** Selection (08 §Parser selection): the three-route drift disambiguation, one quarantine lane. */
  select(
    source: string,
    endpoint: string,
    schemaVersion: string,
    fingerprint: string,
  ): SelectionOutcome {
    if (!this.parsers.has(key(source, endpoint))) {
      return { kind: "quarantine", route: "NO_PARSER", reason: "unmatched_endpoint" };
    }
    const active = this.activeVersion(source, endpoint);
    if (!active) {
      return { kind: "quarantine", route: "NO_ACTIVE_VERSION", reason: "no_active_version" };
    }
    if (active.acceptedInputVersions.includes(schemaVersion)) {
      return { kind: "parse", version: active };
    }
    // Newer/unknown schema_version → fall back to the raw-shape fingerprint (BACKWARD tolerance).
    if (fingerprint === active.shapeFingerprint) {
      return { kind: "parse", version: active };
    }
    return { kind: "quarantine", route: "SHAPE_DRIFT", reason: `shape_drift:${fingerprint}` };
  }
}
