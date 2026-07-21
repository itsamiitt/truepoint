# Build, release & Chrome Web Store compliance

## Build

- **Vite 6 + `@crxjs/vite-plugin` + `@vitejs/plugin-react`** (`vite.config.ts`); the manifest is typed in
  `manifest.config.ts` and CRXJS emits `manifest.json` into `dist/`. Scripts: `dev`, `build`, `typecheck`
  (`apps/extension/package.json`). `bun run build` (or `vite build`) → `dist/`, loaded unpacked in Chrome for
  dev.
- It is a normal workspace package (`@leadwolf/extension`), auto-linked by `bun install`; Turbo's generic
  `build`/`typecheck` tasks pick it up (no per-package Turbo config). `tsconfig.json` extends
  `../../tsconfig.base.json` with `types: ["chrome", "node"]`, `jsx: react-jsx`.
- Depend only on `@leadwolf/types` + `@leadwolf/ui`; `.dependency-cruiser.cjs` `extension-stays-thin` forbids
  `@leadwolf/db`/`@leadwolf/integrations`. This host has no `bun`/`docker`, so typecheck/biome run in CI —
  self-review the diff and mirror a sibling before committing.

## No remotely-hosted code (MV3 hard rule + ADR-0043 §7)

- All executable logic ships in the reviewed bundle. **No** `<script src="remote">`, **no** `eval`/`new
  Function` on fetched strings, **no** interpreter over remote commands. The strict CSP (`script-src 'self'`)
  enforces it.
- **Remote config is data, not code.** The signed config (`src/background/config/remoteConfig.ts`) can only
  flip vetted feature flags or trip the kill switch; it can never change extraction rules or behavior. Its
  signature check must be fail-closed (currently a marked TODO — X09; treat an unverified/unsigned config as
  "all flags off").
- Feature flags gate *which shipped code path runs*, never *what code exists*. The gate pattern mirrors the
  platform's env-kill-switch + per-tenant flag dual gate.

## Release & versioning

- Bump `version` in the manifest per release; keep a changelog. An update ships a full new reviewed bundle;
  there is no partial/remote patch.
- Handle version migrations for persisted state (IndexedDB version, `storage.local` shape) on worker start.
- **Enterprise deployment:** admins force-install via the Chrome Enterprise `ExtensionInstallForcelist`
  policy against the published extension id — which is also the id pinned in `EXTENSION_ORIGINS` (see
  `truepoint-extension-auth/references/enablement.md`).

## Store-review checklist (before publish)

- Least-privilege permissions justified (no `*://*/*`; `optional_host_permissions` for the rest).
- A single narrow purpose per permission in the listing; a privacy policy covering the captured data.
- No remote code; strict CSP; self-hosted assets.
- The extension stays **dark until legal sign-off** (`CHROME_EXTENSION_ENABLED` + per-tenant flag, ADR-0043 §9;
  README §3). Publishing to get a stable id can precede enablement, but capture stays gated.
