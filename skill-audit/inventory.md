# Skill Audit — Phase 0 Inventory (round 2, 2026-07-22)

Method: all numbers produced this session by `phase0-inventory.mjs` (scratchpad) run under Bun 1.3.14 from the repo root; frontmatter parsed with `Bun.YAML.parse` (real YAML parser, not regex). Line counts use `wc -l` semantics.

**Prior round:** an audit dated 2026-07-20/21 (commit `63270cc`) covered the six platform skills and applied fixes F-01–F-10; its reports (previous versions of these files) are preserved in git history. This round covers all **nine** skills — the three `truepoint-extension-*` skills (added in `8b035a2`) have never been audited — and re-verifies the prior fixes against current source.

## Skills found: 9 (77 files, 10,008 lines total)

All under `.claude/skills/`. Every skill = one `SKILL.md` + one `references/` directory of `.md` files. No scripts, no assets, no other file types in the tree.

| Skill | `name` (len) | desc len (parsed value) | Frontmatter keys | YAML parses | Body lines | Files | Total lines |
|---|---|---|---|---|---|---|---|
| truepoint-architecture | truepoint-architecture (22) | 826 | name, description | yes | 328 | 15 | 2633 |
| truepoint-data | truepoint-data (14) | 813 | name, description | yes | 87 | 7 | 970 |
| truepoint-design | truepoint-design (16) | 654 | name, description | yes | 308 | 10 | 2026 |
| truepoint-extension-architecture | truepoint-extension-architecture (32) | **1117** | name, description | yes | 101 | 7 | 333 |
| truepoint-extension-auth | truepoint-extension-auth (24) | **1142** | name, description | yes | 70 | 6 | 243 |
| truepoint-extension-linkedin | truepoint-extension-linkedin (28) | **1102** | name, description | yes | 66 | 6 | 237 |
| truepoint-operations | truepoint-operations (20) | 740 | name, description | yes | 68 | 5 | 486 |
| truepoint-platform | truepoint-platform (18) | 774 | name, description | yes | 161 | 9 | 1378 |
| truepoint-security | truepoint-security (18) | 889 | name, description | yes | 165 | 12 | 1702 |

Measurement notes: "desc len" = length of the parsed `description` value (YAML folded scalar `>`), trailing newline stripped. No tabs in any frontmatter; no unknown keys; all `name` values match `^[a-z0-9-]+$`; none contain reserved words; no XML tags in any description; all frontmatters open at line 1 and close properly. Body lines all ≤500 (max 328).

## Bundled files per skill (line counts)

- **truepoint-architecture** — references/: auth 142, cicd 195, customer-repo 180, database 120, dependency-wiring 239, feature-flags 100, internal-repo 145, multi-agent 154, pre-build-thinking 310, removal-cleanup 111, shared-packages 142, state-and-data 194, testing 148, ui-consolidation 112
- **truepoint-data** — references/: data-model 187, enrichment-pipeline 163, ownership-and-sharing 132, retention-and-deletion 146, search-infrastructure 135, verification 106
- **truepoint-design** — references/: accessibility 137, brand 153, components 431, i18n 104, interaction 125, large-data 113, patterns 300, tokens 233, writing 110
- **truepoint-extension-architecture** — references/: build-release-and-store 43, manifest 42, messaging 35, service-worker-lifecycle 32, state-and-storage 26, ui-surfaces 38
- **truepoint-extension-auth** — references/: api-client 32, companion-handoff 36, enablement 31, threats 32, token-lifecycle 26
- **truepoint-extension-linkedin** — references/: anti-fingerprint-and-tos 32, dom-extraction 32, hovercard 28, site-adapters 34, spa-navigation 29
- **truepoint-operations** — references/: breach-notification 95, finops 120, incident-response 107, runbooks 83
- **truepoint-platform** — references/: api-contract 169, async-jobs 141, caching 117, data-platform 172, observability 125, scaling-playbook 119, service-topology 145, tenancy 216
- **truepoint-security** — references/: abuse-and-edge 135, access-control 195, api-security 136, compliance 117, data-protection 205, dependencies 90, enterprise-iam 136, frontend-security 119, input-and-injection 152, integrations 108, secrets 129

## Other locations checked

| Location | Result |
|---|---|
| `~/.claude/skills/` (user-level) | absent |
| `.claude/commands/`, `.claude/agents/`, `.claude/workflows/` | absent |
| `.claude/hooks/` | present — `check-architecture-map.mjs`, `gen-architecture-map.mjs`, `lib/arch-map.mjs` (hooks, not skills; conflict-detection scope) |
| `.claude/settings.json` | present — single key `hooks` (one Stop hook → check-architecture-map.mjs). No `settings.local.json`. |
| `*.mdc`, `.cursorrules`, `.cursor/rules` | none |
| Root `CLAUDE.md` (77 lines), `docs/planning/main-agent-prompt.md` (280 lines) | present — conflict-detection scope, never edit targets |

## Out of scope — not audited, not edited

- `.claude/worktrees/**` — 74 stale agent-worktree checkouts (other branches' trees; contain historical skill sets incl. `scalable-architecture` etc.). Never edit or prune.
- `files (2)/**` (untracked download artifacts — extracted copies of truepoint-data/-design/-operations skills) and `.ds-sync/storybook/SKILL.md` — artifacts, not live skills.
- Plugin skills (caveman etc., under `~/.claude/plugins/cache/`) and session-provided skills (dataviz, deep-research, …) — conflict-detection only.
