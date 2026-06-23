/**
 * .dependency-cruiser.cjs — TruePoint import-boundary rules (the mechanical gate for docs/planning 16 §5).
 *
 * Installed from .claude/skills/enterprise-architecture/templates/dependency-cruiser.cjs.
 * Run via `bun run lint:boundaries` (depcruise apps packages) in CI so a forbidden import FAILS the build.
 * The Mermaid graph in the navigation map only *visualizes* these edges; THIS file is what *catches*
 * violations.
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "No import cycles (16 §5: the graph is acyclic via the port pattern).",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "apps-never-import-apps",
      comment:
        "apps/* are deployable processes; they may depend on packages/* but never on each other (16 §5).",
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/([^/]+)/", pathNot: "^apps/$1/" },
    },
    {
      name: "no-deep-import-from-app",
      comment:
        "An app may import a package ONLY through its public index.ts — no deep imports (16 §6). CSS is exempt: stylesheets (packages/ui tokens.css) cannot ship through a TS barrel.",
      severity: "error",
      from: { path: "^apps/[^/]+/" },
      to: {
        path: "^packages/[^/]+/src/",
        pathNot: ["^packages/[^/]+/src/index\\.(ts|tsx|js|mjs|cjs)$", "\\.css$"],
      },
    },
    {
      name: "no-deep-import-cross-package",
      comment:
        "A package may import another package ONLY through its index.ts; its own internals are fine.",
      severity: "error",
      from: { path: "^packages/([^/]+)/" },
      to: {
        path: "^packages/([^/]+)/src/",
        pathNot: ["^packages/$1/", "^packages/[^/]+/src/index\\.(ts|tsx|js|mjs|cjs)$"],
      },
    },
    {
      name: "no-cross-feature-import",
      comment:
        "Inside an app, a feature must not import another feature's internals; route via a public index or shared/ (16 §3.3).",
      severity: "error",
      from: { path: "^apps/([^/]+)/src/features/([^/]+)/" },
      to: {
        path: "^apps/[^/]+/src/features/([^/]+)/",
        pathNot: [
          "^apps/$1/src/features/$2/",
          "^apps/[^/]+/src/features/[^/]+/index\\.(ts|tsx|js|jsx)$",
        ],
      },
    },
    {
      name: "core-must-not-import-integrations",
      comment:
        "core declares ports; integrations implement them. core never imports integrations (16 §4/§5).",
      severity: "error",
      from: { path: "^packages/core/" },
      to: { path: "^packages/integrations/" },
    },
    {
      name: "types-is-a-leaf",
      comment: "packages/types imports nothing internal (16 §5).",
      severity: "error",
      from: { path: "^packages/types/" },
      to: { path: "^packages/(?!types/)[^/]+/" },
    },
    {
      name: "config-imports-only-types",
      comment: "packages/config may import only types (16 §5).",
      severity: "error",
      from: { path: "^packages/config/" },
      to: { path: "^packages/(?!config/|types/)[^/]+/" },
    },
    {
      name: "no-orphans",
      comment: "Flag unreachable modules (dead code).",
      severity: "warn",
      from: { orphan: true, pathNot: "\\.(d\\.ts|test\\.[tj]sx?)$" },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: "(\\.test\\.[tj]sx?$|\\.itest\\.[tj]sx?$|\\.d\\.ts$|/__tests__/|/__cassettes__/|/\\.next/)",
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};
