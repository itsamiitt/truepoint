# Skill Audit — Inventory (Phase 0)

Repo: `DuskWolf` (npm root `leadwolf`, brand "TruePoint"). Generated this audit session.

## In scope — canonical project skills (`.claude/skills/`)

All six parse as valid YAML frontmatter; every frontmatter has exactly two keys
(`name`, `description`); all names are lowercase/digit/hyphen, ≤64 chars, no reserved
words; all descriptions ≤1024 chars; all bodies ≤500 lines. Every `references/*.md`
listed in each SKILL.md's table exists on disk.

| Skill | Path | name (len) | desc len | body lines | bundled refs | YAML |
|---|---|---|---|---|---|---|
| truepoint-architecture | `.claude/skills/truepoint-architecture/SKILL.md` | truepoint-architecture (22) | 826 | 341 | 14 | ✅ |
| truepoint-data | `.claude/skills/truepoint-data/SKILL.md` | truepoint-data (14) | 813 | 101 | 6 | ✅ |
| truepoint-design | `.claude/skills/truepoint-design/SKILL.md` | truepoint-design (16) | 654 | 320 | 9 | ✅ |
| truepoint-operations | `.claude/skills/truepoint-operations/SKILL.md` | truepoint-operations (20) | 740 | 81 | 4 | ✅ |
| truepoint-platform | `.claude/skills/truepoint-platform/SKILL.md` | truepoint-platform (18) | 774 | 174 | 8 | ✅ |
| truepoint-security | `.claude/skills/truepoint-security/SKILL.md` | truepoint-security (18) | 889 | 180 | 11 | ✅ |

Bundled reference files (52 total):
- **architecture (14):** auth, cicd, customer-repo, database, dependency-wiring,
  feature-flags, internal-repo, multi-agent, pre-build-thinking, removal-cleanup,
  shared-packages, state-and-data, testing, ui-consolidation
- **data (6):** data-model, enrichment-pipeline, ownership-and-sharing,
  retention-and-deletion, search-infrastructure, verification
- **design (9):** accessibility, brand, components, i18n, interaction, large-data,
  patterns, tokens, writing
- **operations (4):** breach-notification, finops, incident-response, runbooks
- **platform (8):** api-contract, async-jobs, caching, data-platform, observability,
  scaling-playbook, service-topology, tenancy
- **security (11):** abuse-and-edge, access-control, api-security, compliance,
  data-protection, dependencies, enterprise-iam, frontend-security,
  input-and-injection, integrations, secrets

Reference-file spec notes: largest is `truepoint-design/references/components.md`
(426 lines) — all refs ≤500, so none requires splitting. No backslash/Windows paths;
no reference nested deeper than one level; no MCP tools referenced. TOC-above-100-lines
convention is unmet on the larger refs (tracked as one Low finding, not per-file).

## Out of scope — not audited, not edited

- `.claude/worktrees/agent-*/.claude/skills/…` — throwaway git-worktree copies of these
  same six skills, **plus** an older set (`codebase-discipline`, `enterprise-architecture`,
  `plan-weaver`, `scalable-architecture`) that exists ONLY inside worktrees. Duplicates /
  historical; never edit or blind-prune.
- `files (2)/…` and `.ds-sync/storybook/SKILL.md` — download/extract artifacts.
- Plugin skills under `~/.claude/plugins/cache/` (`caveman`, `ponytail`) — global tooling,
  not repo codegen governance. Considered for conflict-detection only.
- `~/.claude/skills/`, `.claude/commands/` — empty / absent.
- No `.mdc`, `.cursorrules`, or nested `CLAUDE.md`; only root `CLAUDE.md` (project rules).

## Interaction surfaces relevant to conflict-detection
- Root `CLAUDE.md` — brand/code-identity split (TruePoint vs `@leadwolf`), Bun+Turbo+Biome,
  two-tier tenancy, skill routing table.
- A Stop hook rebuilds `docs/ARCHITECTURE_MAP.md` / `docs/architecture-map.json`; both are
  currently in an **unresolved merge conflict** (`UU`) — pre-existing, unrelated to skills.
