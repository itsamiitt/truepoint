# navigation-map-spec — exact format for the navigation graph

The navigation graph is **two files** with a clear division of labor:

- **`docs/architecture-map.json`** — machine-readable, **generated** by
  [`.claude/hooks/gen-architecture-map.mjs`](../../../hooks/gen-architecture-map.mjs). Deterministic and
  byte-stable. **Never hand-edit it.** It is the source of truth for *paths* and the `fileSetHash` the
  Stop hook checks.
- **`docs/ARCHITECTURE_MAP.md`** — human-readable, **authored by Claude** from the JSON + this spec. It is
  the source of truth for *one-line purposes* and the Mermaid graph.

The JSON owns *where things are*; the prose owns *what they're for*. Keep them consistent: after running
the generator, refresh the prose from the new JSON.

---

## 1. `architecture-map.json` schema

```jsonc
{
  "status": "planned" | "live",        // "planned" iff no source files exist yet (fileCount === 0)
  "generatedBy": ".claude/hooks/gen-architecture-map.mjs",
  "generatedFrom": ["docs/planning/16-code-organization.md", "docs/planning/02-architecture.md",
                    "docs/planning/05-features-modules.md", "docs/planning/11-information-architecture.md"],
  "roots": ["apps", "packages"],
  "domains": ["…sorted union of canonical + encountered domain slugs…"],
  "fileCount": 0,
  "fileSetHash": "sha256:<hex>",       // hash of the sorted source-path list (see §3)
  "features": {                         // one entry per domain that has files
    "<domain>": { "web": [], "admin": [], "api": [], "core": [], "db": [], "workers": [], "integrations": [] }
  },
  "shared": {                           // non-domain platform code, keyed by area
    "<area>": []                        // e.g. "packages/types", "apps/api/middleware", "apps/web/shared"
  },
  "unassigned": [],                     // source files that matched no rule — a placement/naming violation
  "warnings": [],                       // e.g. "undeclared domain 'foo' — add to canonical list or rename"
  "dependencies": {                     // the ALLOWED graph (16 §5), not the observed one
    "types": [], "config": ["types"], "db": ["types","config"], "search": ["types","config"],
    "email": ["types","config"], "ui": ["types"], "analytics": ["types","config"],
    "observability": ["types","config"], "auth": ["db","types","config"],
    "core": ["db","search","types","config"], "integrations": ["core","types","config"]
  }
}
```

- **`status`** — `"planned"` when there is no code yet (the prose map then describes *target* paths; see
  §4). Flips to `"live"` automatically once any source file exists.
- **`dependencies`** is the **allowed** import graph from 16 §5 — a constant the generator stamps in. The
  actual imports are checked separately by `dependency-cruiser`; this section is for the human map's
  reference and the Mermaid graph, not a record of observed imports.
- Arrays are **sorted**; object keys are emitted in a **fixed order**. The file ends with a trailing
  newline. Two runs on the same tree produce byte-identical output.

## 2. Domain bucketing rules (deterministic; first match wins)

A source file is assigned by its **own path** — never by guessing which domain it "relates to." This is
what prevents two sessions from fragmenting the index. Given a POSIX relative path `p`:

| Path pattern | Goes to |
|---|---|
| `apps/web/src/features/<d>/**` | `features[d].web` |
| `apps/admin/src/features/<d>/**` | `features[d].admin` |
| `apps/api/src/features/<d>/**` | `features[d].api` |
| `packages/core/src/<d>/**` (d ≠ `ports`) | `features[d].core` |
| `packages/db/src/repositories/<Entity>Repository.*` | `features[domain].db` via `REPO_DOMAIN[<entity>]`, else `unassigned` |
| `apps/workers/src/queues/<queue>.*` | `features[domain].workers` via `QUEUE_DOMAIN[<queue>]`, else `unassigned` |
| `packages/integrations/<provider>/**` | `features[domain].integrations` via `PROVIDER_DOMAIN[<provider>]`, else `shared["packages/integrations"]` |
| `apps/api/src/middleware/**` | `shared["apps/api/middleware"]` |
| `apps/<app>/src/app/**` · `…/shared/**` · `…/lib/**` | `shared["apps/<app>/app" | "…/shared" | "…/lib"]` |
| `apps/<app>/src/{app.ts,server.ts,index.ts,register.ts}` | `shared["apps/<app>"]` |
| `packages/core/src/ports/**` | `shared["packages/core/ports"]` |
| `packages/core/src/*.ts` (top-level: `requestContext.ts`, `withWorkspaceTx.ts`, `index.ts`) | `shared["packages/core"]` |
| `packages/db/src/{schema,migrations,rls}/**` · `packages/db/src/index.ts` | `shared["packages/db"]` |
| `packages/{types,config,ui,auth,search,email,analytics,observability}/**` | `shared["packages/<name>"]` |
| anything else under a root | `unassigned[]` |

**Important modelling note (the "spanning" question):** web slices are **destination-keyed**
(`prospect`, `sequences`, `settings` — the 6 destinations), while api/core/db are **resource/domain-keyed**
(`reveal`, `lists`, `billing`). They are *different keys on purpose*. The reveal domain's API lives in
`features.reveal.api`; its UI lives in `features.prospect.web`. A file has exactly **one** home — its own
folder — so it is never listed twice. The prose map's "Destinations" cross-reference (see §4) is where you
note that the *prospect* destination surfaces the reveal/search/lists/contacts domains. Shared logic that
genuinely spans domains lives in `packages/core` (its own domain folder) or `shared/` and is listed under
that **single** key.

### Declared maps (seeded in the generator; extend as the code grows)
- `QUEUE_DOMAIN`: `enrichment→enrichment, scoring→scoring, imports→import, crm-sync→crm-sync,
  outreach→outreach, search-sync→search, webhook→api-public`.
- `REPO_DOMAIN`: e.g. `contact→reveal, account→reveal, list→lists, score→scoring, outreach→outreach,
  source_import→import, suppression→compliance, tenant→billing, user→auth, workspace→workspaces,
  api_key→api-public, purchase→billing, activity→activity` (extend per `packages/db/src/schema`).
- `PROVIDER_DOMAIN`: `salesforce→crm-sync, hubspot→crm-sync, pipedrive→crm-sync, apollo→enrichment,
  zoominfo→enrichment, clearbit→enrichment, linkedin→sales-navigator`.

### Canonical domain list (the single authoritative enumeration)
Sourced from [`05-features-modules.md`](../../../../docs/planning/05-features-modules.md) (modules) and
[`11-information-architecture.md`](../../../../docs/planning/11-information-architecture.md) §2/§6 (the 6
destinations). Embedded in the generator as `CANONICAL_DOMAINS`:

```
auth, workspaces, import, enrichment, sales-navigator, search, reveal, lists, scoring, activity,
billing, export, outreach, crm-sync, api-public, ai, alerts, compliance, admin-settings,
home, prospect, sequences, inbox, reports, settings, templates, notifications, data-health
```

A folder segment not in this list is still bucketed (nothing is lost) but added to `warnings[]` so the
list can be corrected or the folder renamed. `domains[]` in the output is the sorted union of
`CANONICAL_DOMAINS` and the segments actually encountered.

## 3. `fileSetHash` (what the Stop hook compares)

The hash captures **tree shape**, not content — so it changes only when files are added, removed, moved, or
renamed (exactly when the feature→files index needs refreshing), and is immune to mtime/content churn from
`git checkout`/`pull`/`npm install`.

Algorithm (identical in generator and hook — both import
[`.claude/hooks/lib/arch-map.mjs`](../../../hooks/lib/arch-map.mjs)):
1. Recursively list files under each root in `roots`.
2. Keep only **source files**: extensions `.ts .tsx .mts .cts .js .jsx .mjs .cjs`; exclude `*.d.ts` and any
   path containing a segment in `{node_modules, dist, build, .next, coverage, .turbo}`.
3. Normalize to POSIX relative paths (forward slashes), **sort** ascending.
4. `sha256` of the paths joined by `\n`; prefix `"sha256:"`.

Empty set (no code) → `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. The
generator stamps that into the `planned` bootstrap so the hook stays silent until real code appears.

## 4. `ARCHITECTURE_MAP.md` structure (Claude-authored)

Use [`../templates/ARCHITECTURE_MAP.md`](../templates/ARCHITECTURE_MAP.md). Sections, in order:

1. **Header** — `status` (planned/live), generated-from, and a line: "Paths come from
   `architecture-map.json` (generated); do not edit paths here by hand."
2. **Repo tree** — folders + key files, each with a **one-line purpose**. When `status:"planned"`, prefix
   the tree with "⚠ Planned — these paths are targets, not locations; the code does not exist yet."
3. **FEATURE → FILES index** — one subsection per domain (from `features`), listing every file across
   `web / admin / api / core / db / workers / integrations`. Mirror the JSON exactly.
4. **Destinations cross-reference** — the 6 web destinations → which resource domains they surface (from
   11 §6). This is where cross-domain relationships live (since the index itself never cross-lists).
5. **DEPENDENCY section** — which features/packages depend on which shared packages (from `dependencies`),
   in prose + the table.
6. **Mermaid graph** — the allowed module-dependency graph (copy the flowchart from
   `architecture-contract.md` §4 / 16 §5) so a forbidden edge is visually obvious. Note that
   `dependency-cruiser` is what *enforces* it.
7. **Shared / unassigned** — list `shared` areas; if `unassigned[]` is non-empty, surface it as
   **Violations to fix** (a misplaced/misnamed file), not as a normal section.

## 5. Trust rules (read before relying on the map)
- **`status:"planned"`** → every path is a **target, not a location**. Do not open these as real files.
- **`status:"live"`** → the JSON lists only files that exist (generated from globs). Still validate a path
  before depending on it; if code and map disagree, the **code wins** — regenerate.
- The map is a **starting index**. For multi-file tasks, re-derive from the filesystem rather than trusting
  a snapshot you read earlier in the same task (it can go stale mid-task).
