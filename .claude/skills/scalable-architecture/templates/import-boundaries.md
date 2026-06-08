# Enforcing import boundaries (principle #4)

Discipline is not enough — wire a lint rule so a cross-feature import fails CI. Pick ONE of the options
below for your stack and commit it during scaffold (Mode 1, step 4).

The rules to enforce:
1. **No cross-feature imports** — a file in `features/A` must not import from `features/B`.
2. **No deep imports** — outside code imports a feature only via `features/<x>/index.ts`, never
   `features/<x>/services/...`.
3. **`shared/` and `lib/` must not import from `features/`** (lower layers don't depend on higher ones).

---

## Option A — ESLint `no-restricted-imports` (flat config, zero extra deps)

```js
// eslint.config.js
export default [
  {
    files: ["src/features/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          // ban importing another feature's internals or the feature at all from a sibling feature
          { group: ["@/features/*/*", "**/features/*/*"],
            message: "No cross-feature deep imports. Use shared/ or the feature's public index." },
        ],
      }],
    },
  },
  {
    files: ["src/shared/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@/features/*", "**/features/*"],
            message: "shared/ and lib/ must not import from features/." },
        ],
      }],
    },
  },
];
```

## Option B — `eslint-plugin-boundaries` (declarative element graph)

```js
// eslint.config.js (excerpt)  — npm i -D eslint-plugin-boundaries
settings: {
  "boundaries/elements": [
    { type: "app", pattern: "src/app/*" },
    { type: "feature", pattern: "src/features/*", capture: ["name"] },
    { type: "shared", pattern: "src/shared/*" },
    { type: "lib", pattern: "src/lib/*" },
    { type: "config", pattern: "src/config/*" },
  ],
},
rules: {
  "boundaries/element-types": ["error", {
    default: "disallow",
    rules: [
      { from: "app",     allow: ["feature", "shared", "lib", "config"] },
      { from: "feature", allow: ["shared", "lib", "config", ["feature", { name: "${from.name}" }]] },
      { from: "shared",  allow: ["shared", "lib", "config"] },
      { from: "lib",     allow: ["lib", "config"] },
    ],
  }],
},
```

## Option C — `dependency-cruiser` (great for monorepos; runs in CI)

```js
// .dependency-cruiser.js  — npm i -D dependency-cruiser ; npx depcruise src
module.exports = {
  forbidden: [
    { name: "no-cross-feature",
      severity: "error",
      from: { path: "^src/features/([^/]+)/" },
      to:   { path: "^src/features/([^/]+)/", pathNot: "^src/features/$1/" } },
    { name: "no-deep-feature-import",
      severity: "error",
      from: { pathNot: "^src/features/([^/]+)/" },
      to:   { path: "^src/features/[^/]+/(?!index)" } },
    { name: "apps-never-depend-on-apps", // monorepo
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to:   { path: "^apps/([^/]+)/", pathNot: "^apps/$1/" } },
  ],
};
```

## Python — `import-linter` contracts

```ini
# setup.cfg / .importlinter
[importlinter]
root_package = myapp

[importlinter:contract:features-independent]
name = Features must not import each other
type = independence
modules =
    myapp.features.*

[importlinter:contract:layers]
name = Lower layers must not import features
type = layers
layers =
    myapp.features
    myapp.shared
    myapp.lib
```

Run the chosen check in CI (e.g. a `lint:boundaries` script) so violations block merges.
