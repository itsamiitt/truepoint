/**
 * .dependency-cruiser.cjs — TruePoint import-boundary rules (the mechanical gate for docs/planning 16 §5).
 *
 * Installed from .claude/skills/enterprise-architecture/templates/dependency-cruiser.cjs.
 * Run via `bun run lint:boundaries` (depcruise apps packages) in CI so a forbidden import FAILS the build.
 * The Mermaid graph in the navigation map only *visualizes* these edges; THIS file is what *catches*
 * violations.
 */
module.exports = {
  // ── VERIFIED TO FIRE (13 Aug 2026) ────────────────────────────────────────────────────────────────────
  // A lint rule that cannot fail is indistinguishable from one that passes, and this session found three
  // guards in this repo that could not fail (a no-orphans rule blind to `@/` aliases, a PII tripwire whose
  // patterns did not match the vocabulary of the roots it scanned, and a coverage test satisfied by an import
  // line). So the ERROR-level rules below were checked empirically rather than assumed.
  //
  // Method: plant a real violating import, run `bun run lint:boundaries`, confirm the named rule reports the
  // exact edge, revert, confirm exit 0. Seven fired correctly and each named its edge:
  //
  //   no-circular                     core -> integrations -> core
  //   apps-never-import-apps          apps/api/src/cache.ts -> apps/web/src/lib/maybeList.ts
  //   core-must-not-import-integrations   packages/core/src/index.ts -> packages/integrations/src/index.ts
  //   types-is-a-leaf                 packages/types -> packages/db
  //   config-imports-only-types       packages/config -> packages/core
  //   extension-stays-thin            apps/extension -> packages/db
  //   forge-capture-sdk-stays-thin    packages/forge-capture-sdk -> packages/core
  //   no-deep-import-from-app         apps/api -> packages/db/src/repositories/listCaps.ts
  //   no-deep-import-cross-package    packages/core -> packages/db/src/repositories/listCaps.ts
  //   no-cross-feature-import         web features/inbox -> web features/sequences
  //
  // ALL TEN fire. Nothing here is taken on trust: each was made to fail on purpose and named the exact edge.
  //
  // ── ELEVENTH, VERIFIED 2026-08-22, AND THE METHOD MATTERS ──────────────────────────────────────────────
  //   doc-app-holds-no-data-path      apps/doc -> packages/db/src/index.ts
  //
  // This one was missing from the list above, and trying to verify it the obvious way is what explains why.
  // Planting `import { pingDb } from "@leadwolf/db"` in apps/doc reports NOTHING — 0 errors, exit 0 — which
  // reads like a dead rule. It is not. apps/doc declares only @leadwolf/ui and @leadwolf/app-shell, so
  // `apps/doc/node_modules/@leadwolf/` holds exactly those two and the specifier is UNRESOLVABLE. An
  // unresolved dependency keeps the bare string `@leadwolf/db` as its `resolved` value, and every `to.path`
  // here is anchored on `^packages/`, so no rule can match it. A cruiser rule can only fire on an edge the
  // resolver could follow.
  //
  // That is not a hole, because the two mechanisms cover different halves and between them cover the ways in:
  //   • bare specifier, dependency NOT declared → depcruise is silent, but `tsc` fails with TS2307
  //     ("Cannot find module '@leadwolf/db'"). Verified. The typecheck gate is the wall here, not this file.
  //   • RELATIVE import (`../../../packages/db/src/index.ts`) → resolves fine, so `tsc` is perfectly happy —
  //     and THIS rule is the only thing that catches it. Verified: it errors and names the exact edge.
  //   • dependency declared and then imported → resolves, rule fires. The deliberate case.
  //
  // So when re-verifying any "must not import X" rule in this file, plant a RELATIVE import. A bare specifier
  // for an undeclared workspace package proves nothing about the rule, only about the package.json.
  // The two deep-import rules matter most to re-check if this file is ever refactored — their `pathNot`
  // carries a `$1` backreference and an index.ts exemption, which is the kind of expression that keeps
  // matching after it has stopped meaning what it says.
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
        "An app may import a package ONLY through its public index.ts or a named `src/entries/*` entry point declared in the package's exports map — no deep imports (16 §6; entries/* added by perf-checklist PA-2/PA-3 so an intent-deferred surface like the command palette can be its own module instead of welded into the barrel every consumer loads eagerly). CSS is exempt: stylesheets (packages/ui tokens.css) cannot ship through a TS barrel.",
      severity: "error",
      from: { path: "^apps/[^/]+/" },
      to: {
        path: "^packages/[^/]+/src/",
        pathNot: [
          "^packages/[^/]+/src/index\\.(ts|tsx|js|mjs|cjs)$",
          "^packages/[^/]+/src/entries/[^/]+\\.(ts|tsx|js|mjs|cjs)$",
          "\\.css$",
        ],
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
        "Inside an app, a feature must not import another feature's internals; route via a public index, a named `entries/*` entry point, or shared/ (16 §3.3; entries/* added by perf-checklist PA-2 — a public contract that isn't one module with the whole slice, so a borrowing route stops shipping everything the owner route needs).",
      severity: "error",
      from: { path: "^apps/([^/]+)/src/features/([^/]+)/" },
      to: {
        path: "^apps/[^/]+/src/features/([^/]+)/",
        pathNot: [
          "^apps/$1/src/features/$2/",
          "^apps/[^/]+/src/features/[^/]+/index\\.(ts|tsx|js|jsx)$",
          "^apps/[^/]+/src/features/[^/]+/entries/[^/]+\\.(ts|tsx|js|jsx)$",
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
      name: "extension-stays-thin",
      comment:
        "apps/extension is an untrusted thin client — never import @leadwolf/db or @leadwolf/integrations (no DB access, no provider keys on the client; ADR-0043, docs/planning/chrome-extension/02 §1).",
      severity: "error",
      from: { path: "^apps/extension/" },
      to: { path: "^packages/(db|integrations)/" },
    },
    {
      name: "doc-app-holds-no-data-path",
      comment:
        "apps/doc (doc.truepoint.in) is an anonymous, statically-rendered marketing/documentation site: it may consume @leadwolf/ui and @leadwolf/app-shell (design system + brand lockup) and NOTHING else from packages/*. No config (which validates env at import and would give a public site a database-shaped build dependency), no db, no auth, no core, no integrations. This is what lets it build with zero environment and makes it structurally incapable of causing a data incident — ADR-0048 §D2. Any page that needs live data belongs on apps/web, behind a session.",
      severity: "error",
      from: { path: "^apps/doc/" },
      to: { path: "^packages/(?!ui/|app-shell/)[^/]+/" },
    },
    {
      name: "forge-capture-sdk-stays-thin",
      comment:
        "@leadwolf/forge-capture-sdk ships into the untrusted MV3 extension process — it imports ONLY @leadwolf/types, never db/integrations/core (docs/planning/forge/04, ADR-0046).",
      severity: "error",
      from: { path: "^packages/forge-capture-sdk/" },
      to: { path: "^packages/(?!forge-capture-sdk/|types/)[^/]+/" },
    },
    {
      name: "forge-core-must-not-import-integrations",
      comment:
        "@leadwolf/forge-core declares ports; @leadwolf/integrations implements them. forge-core never imports integrations (mirrors core-must-not-import-integrations; docs/planning/forge/04).",
      severity: "error",
      from: { path: "^packages/forge-core/" },
      to: { path: "^packages/integrations/" },
    },
    {
      name: "no-orphans",
      // WARNING — DO NOT TREAT THIS RULE'S OUTPUT AS EVIDENCE OF DEAD CODE. It cannot see `@/...` imports.
      //
      // Every app defines its own `@/*` -> `./src/*` alias in its OWN tsconfig, and tsconfig.base.json has no
      // `paths` entry for dependency-cruiser's `tsConfig` option to point at. So alias imports never resolve
      // and every alias-imported module looks unreachable. Measured on the current tree: ALL 14 reported
      // orphans are false positives. apps/web/src/lib/problemMessage.ts has 25 importers, maybeList.ts 14,
      // queryKeys.ts 6; apps/auth's authUrl / OtpInput / magicCarry are referenced by 8 / 5 / 2 files. The
      // remainder are next.config.mjs entry points and one build artifact under apps/extension/dist.
      //
      // A 100% false-positive rate, and the failure mode is not noise but DELETION: someone tidying "dead
      // code" on this rule's say-so would remove a module that 25 files import. Grep for the module name
      // before acting on any entry here.
      //
      // Left enabled rather than removed: it still covers non-aliased locations, and the eight error-level
      // boundary rules above are what this cruise is really for. Fixing it properly means a per-app cruise
      // using that app's tsconfig -- a build-tooling change, not a rule tweak.
      //
      // ── 2026-08-22: the alias blindness is NOT confined to this warning ────────────────────────────────
      // The note above stops at orphans, which reads as "one noisy warning". The same unresolved edge blinds
      // an ERROR-level rule: `no-cross-feature-import` matches on `^apps/web/src/features/`, so it cannot see
      // `@/features/prospect` either. apps/web has NINE cross-feature imports today and that rule has never
      // reported one of them. Quantified: 251 `@/` imports in apps/web, 0 resolved.
      //   → `scripts/lint-cross-feature-imports.mjs` (`bun run lint:cross-feature`) closes that hole by
      //     reading the import TEXT, and ratchets the nine so they cannot become ten.
      //
      // The blindness is now fully scoped, so nobody has to fear the worst or wave it away:
      //   • no-cross-feature-import — blind, 9 live instances, covered by the script above.
      //   • no-orphans             — blind, ~14 false positives, documented here.
      //   • no-circular            — blind in principle, and MEASURED CLEAN: an alias-aware cycle scan over
      //     all six apps (976 modules: web 490, admin 204, auth 100, doc 82, extension 54, forge 46) found
      //     ZERO cycles. Nothing is hiding there today.
      //   • every other error rule — unaffected. They target `packages/*` and `apps/*` edges written as
      //     workspace specifiers or relative paths, neither of which goes through `@/`.
      comment:
        "Flag unreachable modules (dead code). NOTE: blind to `@/...` alias imports -- see above.",
      severity: "warn",
      from: { orphan: true, pathNot: "\\.(d\\.ts|test\\.[tj]sx?)$" },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      // `/dist/` joins the list because build OUTPUT is not source: apps/extension/dist held a bundled
      // `.js` chunk that cruised as a module and reported as an orphan, which is true and meaningless.
      path:
        "(\\.test\\.[tj]sx?$|\\.itest\\.[tj]sx?$|\\.d\\.ts$|/__tests__/|/__cassettes__/|/\\.next/|/dist/)",
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};
