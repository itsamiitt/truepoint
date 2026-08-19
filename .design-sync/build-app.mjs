#!/usr/bin/env node
// .design-sync/build-app.mjs — the reproducible "build" that lets /design-sync convert @leadwolf/ui PLUS
// one app's real feature components into a single design-system bundle.
//
// This generalizes build-ui.mjs, which did exactly this for apps/web's prospect slice and hard-coded every
// app-specific detail. Five apps now get their own Claude Design project, each carrying the shared
// primitives (so designs render on-brand) and that app's own components (so the design agent can build that
// app's real screens). The per-app inputs live in .design-sync/apps/<app>/:
//
//   manifest.json   which app, where its source and node_modules are, what to stub, how to type-check it
//   entry.tsx       the single source of truth for WHICH components ship (parsed, never duplicated here)
//   stubs/          app-specific replacements for modules that need a network, a server, or Next's runtime
//
// Shared, app-agnostic stubs live in .design-sync/stubs/ — an app's own stubs/ dir wins on name collision.
//
// What it produces (all gitignored scratch; the repo's real source and config are never modified):
//   packages/ui/dist/            a fake "built package" the converter can resolve
//     index.{js,d.ts}            @leadwolf/ui, tsc-emitted (real .d.ts ⇒ real prop contracts)
//     app.{js,d.ts} + app.css    the app slice: esbuild runtime + a REAL-types declaration pass
//     ds-entry.{js,d.ts}         both together — what package.json points at, so both are discovered
//     _compiled.css              Tailwind v4 build of the token/theme/primitive layers + the slice's CSS
//     _fonts.css + woff2         Geist, which the apps normally inject via next/font
//     _lucide.mjs                a narrow real-glyph icon barrel (see lib/gen-lucide.mjs)
//
// Usage from the repo root:  node .design-sync/build-app.mjs --app <web|admin|auth|forge|extension>

import {
  existsSync, readFileSync, writeFileSync, appendFileSync, rmSync, mkdirSync, cpSync, readdirSync, statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, relative, resolve, dirname } from 'node:path';
import { generateLucideBarrel } from './lib/gen-lucide.mjs';

const ROOT = process.cwd();
const UI = join(ROOT, 'packages', 'ui');
const SRC = join(UI, 'src');
const BUILT = join(UI, 'dist');
const UI_NM = join(UI, 'node_modules');
const DS_SYNC_NM = join(ROOT, '.ds-sync', 'node_modules');
const SHARED_STUBS = join(ROOT, '.design-sync', 'stubs');

const die = (m) => { console.error('✗ build-app: ' + m); process.exit(1); };
const step = (m) => console.error('» ' + m);
const posix = (p) => p.split('\\').join('/');

// ── args + manifest ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const appArg = argv[argv.indexOf('--app') + 1];
if (!appArg || appArg.startsWith('--')) die('usage: node .design-sync/build-app.mjs --app <name>');
const APP_DIR = join(ROOT, '.design-sync', 'apps', appArg);
const manifestPath = join(APP_DIR, 'manifest.json');
if (!existsSync(manifestPath)) die(`no manifest at ${relative(ROOT, manifestPath)}`);
const app = JSON.parse(readFileSync(manifestPath, 'utf8'));

const entryFile = app.entry ? join(ROOT, app.entry) : join(APP_DIR, 'entry.tsx');
if (!existsSync(entryFile)) die(`missing slice entry ${relative(ROOT, entryFile)}`);
const stubDirs = [app.stubsDir ? join(ROOT, app.stubsDir) : join(APP_DIR, 'stubs'), SHARED_STUBS];
const APP_NM = join(ROOT, app.nodeModules ?? join('apps', appArg, 'node_modules'));
const srcRoots = (app.srcRoots ?? [`apps/${appArg}/src`]).map((r) => join(ROOT, r));
// Every workspace package's source. Both the Tailwind scan and the lucide scan need it: an app slice
// reaches BOTH through shared packages (@leadwolf/app-shell renders utility-classed markup and imports
// seven icons of its own), and a class or icon missed there is an unstyled card or a hard bundle failure.
const pkgSrcRoots = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join(ROOT, 'packages', e.name, 'src'))
  .filter(existsSync);

/** Resolve a stub file name against the app's stubs dir first, then the shared one. */
function stub(name) {
  for (const d of stubDirs) {
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  die(`stub not found in ${stubDirs.map((d) => relative(ROOT, d)).join(' or ')}: ${name}`);
}

if (!existsSync(SRC)) die('packages/ui/src not found — run from the repo root');
console.error(`── building the design-system bundle for apps/${appArg} ──`);

// ── 1. reset scratch ───────────────────────────────────────────────────────
step('reset packages/ui/dist');
// Windows can EPERM-lock a dir transiently (indexer/AV); retry, then fall back to clearing contents.
try {
  rmSync(BUILT, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
} catch (e) {
  console.error(`  ! rm ${BUILT} failed (${e.code}) — clearing contents instead`);
  if (existsSync(BUILT)) for (const f of readdirSync(BUILT))
    rmSync(join(BUILT, f), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
mkdirSync(BUILT, { recursive: true });

// ── 2. tsc full emit of @leadwolf/ui (JS + .d.ts) ──────────────────────────
// Source imports carry .ts/.tsx extensions, so allowImportingTsExtensions + rewriteRelativeImportExtensions
// (TS 5.7+) are required to emit at all. noEmitOnError:false so strict-mode noise still produces output.
const tsconfigPath = join(UI, '.ds-tsconfig.json');
writeFileSync(tsconfigPath, JSON.stringify({
  compilerOptions: {
    jsx: 'react-jsx', target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    lib: ['ES2023', 'DOM', 'DOM.Iterable'],
    declaration: true, emitDeclarationOnly: false, noEmit: false, noEmitOnError: false,
    allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true,
    skipLibCheck: true, strict: false, verbatimModuleSyntax: false, isolatedModules: false,
    esModuleInterop: true, outDir: './dist', rootDir: './src', types: ['react', 'react-dom'],
  },
  include: ['src/**/*.ts', 'src/**/*.tsx'],
  exclude: ['node_modules'],
}, null, 2));
const tscBin = join(UI_NM, 'typescript', 'bin', 'tsc');
if (!existsSync(tscBin)) die(`typescript not found at ${tscBin} — run \`bun install\``);
step('tsc emit → packages/ui/dist');
const tsc = spawnSync(process.execPath, [tscBin, '-p', tsconfigPath], { cwd: UI, encoding: 'utf8' });
if (tsc.stdout?.trim()) console.error(tsc.stdout.trim().split('\n').slice(0, 25).join('\n'));
if (!existsSync(join(BUILT, 'index.js')) || !existsSync(join(BUILT, 'index.d.ts')))
  die('tsc did not emit index.js / index.d.ts — see errors above');
if (tsc.status !== 0) console.error('  (tsc reported type errors but emitted output — continuing)');

// 2b. The .d.ts barrel keeps .ts/.tsx specifiers after emit, which ts-morph's Bundler resolution can't
// follow → zero exports. Rewrite them to .js (a .js specifier resolves to its .d.ts sibling).
function rewriteDts(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { n += rewriteDts(p); continue; }
    if (!e.name.endsWith('.d.ts')) continue;
    const before = readFileSync(p, 'utf8');
    const after = before.replace(/(['"])(\.\.?\/[^'"]*?)\.(tsx?|mts|cts)(['"])/g, '$1$2.js$4');
    if (after !== before) { writeFileSync(p, after); n++; }
  }
  return n;
}
step(`rewrote .ts/.tsx → .js specifiers in ${rewriteDts(BUILT)} .d.ts file(s)`);

// ── 3. scratch package.json ────────────────────────────────────────────────
// Points at ds-entry (step 10) — the combined surface. `exportedNames` walks the `types` .d.ts tree, so
// this is what decides whether the app's components exist at all as far as the converter is concerned.
writeFileSync(join(BUILT, 'package.json'), JSON.stringify({
  name: '@leadwolf/ui', version: '0.0.0', type: 'module',
  module: './ds-entry.js', main: './ds-entry.js', types: './ds-entry.d.ts', sideEffects: false,
}, null, 2) + '\n');

// ── 4. Geist fonts ─────────────────────────────────────────────────────────
const geist = join(ROOT, 'apps', 'auth', 'node_modules', 'geist', 'dist', 'fonts');
const fontPairs = [
  [join(geist, 'geist-sans', 'Geist-Variable.woff2'), 'Geist-Variable.woff2', 'Geist'],
  [join(geist, 'geist-mono', 'GeistMono-Variable.woff2'), 'GeistMono-Variable.woff2', 'Geist Mono'],
];
let fontCss = '';
let copiedFonts = 0;
for (const [srcF, name, fam] of fontPairs) {
  if (!existsSync(srcF)) { console.error(`  ! geist font missing: ${srcF} — skipped`); continue; }
  cpSync(srcF, join(BUILT, name));
  copiedFonts++;
  fontCss += `@font-face{font-family:"${fam}";font-style:normal;font-weight:100 900;font-display:swap;src:url("./${name}") format("woff2");}\n`;
}
// Only @font-face rules survive the cfg.extraFonts parse — the --font-geist-* bindings go to _compiled.css.
writeFileSync(join(BUILT, '_fonts.css'), fontCss);
step(`geist fonts: ${copiedFonts}/${fontPairs.length} families → dist`);

// ── 5. Tailwind v4 compile ─────────────────────────────────────────────────
// The shadcn primitives (src/components/ui/*) use Tailwind utility classes the app generates via
// `@import "tailwindcss"` — without this pass they render unstyled.
const twInput = join(ROOT, '.ds-sync', '_tw-input.css');
// EXPLICIT @source, not Tailwind v4's auto-detection. Auto-detection scans the whole cwd, which means the
// emitted CSS depended on which `ds-bundle-*` output dirs happened to exist — a previous app's compiled
// bundle leaked its class names into the next app's stylesheet (46 KB became 56 KB purely from build
// order). Naming the sources makes each app's CSS a function of its own inputs and nothing else.
// manifest.extraCss — stylesheets the APP supplies that @leadwolf/ui does not. The console page scaffold
// (.tp-page, .tp-stat-grid, .tp-section-title) lives in @leadwolf/app-shell/shell.css and each app layers
// its own chrome in globals.css. Without them a page card renders its KPI tiles stacked in a single column
// instead of a 4-up grid — perfectly styled components inside a completely unstyled page. Imported by real
// path so any relative url() inside them still resolves.
const extraCss = (app.extraCss ?? []).map((c) => posix(relative(join(ROOT, '.ds-sync'), join(ROOT, c))));
const twSources = [
  ...pkgSrcRoots.map((p) => posix(relative(join(ROOT, '.ds-sync'), p))),
  ...srcRoots.map((p) => posix(relative(join(ROOT, '.ds-sync'), p))),
];
writeFileSync(twInput,
  '@import "tailwindcss";\n' +
  twSources.map((s) => `@source ${JSON.stringify(s)};\n`).join('') +
  '@import "../packages/ui/src/tokens.css";\n' +
  '@import "../packages/ui/src/theme.css";\n' +
  '@import "../packages/ui/src/primitives.css";\n' +
  extraCss.map((c) => `@import ${JSON.stringify(c)};\n`).join(''));
const cliPkgDir = join(DS_SYNC_NM, '@tailwindcss', 'cli');
if (!existsSync(cliPkgDir)) die(`@tailwindcss/cli not staged at ${cliPkgDir} — run: (cd .ds-sync && npm i @tailwindcss/cli@4.3.1)`);
const cliPkg = JSON.parse(readFileSync(join(cliPkgDir, 'package.json'), 'utf8'));
const binRel = typeof cliPkg.bin === 'string' ? cliPkg.bin : (cliPkg.bin?.tailwindcss ?? Object.values(cliPkg.bin || {})[0]);
const compiled = join(BUILT, '_compiled.css');
step('tailwind compile → packages/ui/dist/_compiled.css');
const tw = spawnSync(process.execPath, [join(cliPkgDir, binRel), '-i', twInput, '-o', compiled], { cwd: ROOT, encoding: 'utf8' });
if (tw.stderr?.trim()) console.error(tw.stderr.trim().split('\n').slice(0, 8).join('\n'));
if (tw.status !== 0 || !existsSync(compiled)) die('tailwind compile failed — see output above');
// tokens.css leads --font-sans with an UNGUARDED var(--font-geist-sans), which each app sets on <html> via
// next/font. With no app, the whole value is invalid at computed-value time and every card — and every
// design built with this DS — falls back to serif. Bind them to the families shipped in step 4.
appendFileSync(compiled,
  '\n/* design-sync: bind the next/font variables the host apps normally set on <html>. */\n' +
  ':root{--font-geist-sans:"Geist";--font-geist-mono:"Geist Mono";}\n');
console.error(`  _compiled.css: ${(statSync(compiled).size / 1024).toFixed(0)} KB`);

// ── 6. runtime deps into packages/ui/node_modules ──────────────────────────
// React 19 has no UMD, so the converter's vendorReact esbuild-bundles react/react-dom/scheduler from
// --node-modules; @leadwolf/types must resolve for the slice's emitted .d.ts to carry real prop types.
function copyPkg(label, srcDir, destName, { refresh = false } = {}) {
  const dest = join(UI_NM, destName);
  if (!refresh && existsSync(join(dest, 'package.json'))) { console.error(`  ${label}: already present`); return; }
  if (!srcDir || !existsSync(srcDir)) die(`${label} source not found: ${srcDir}`);
  if (refresh) rmSync(dest, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(srcDir, dest, { recursive: true, dereference: true });
  console.error(`  ${label}: → packages/ui/node_modules/${posix(destName)}`);
}
step('place react-dom, scheduler, @leadwolf/types');
copyPkg('react-dom', join(ROOT, 'apps', 'auth', 'node_modules', 'react-dom'), 'react-dom');
const bunStore = join(ROOT, 'node_modules', '.bun');
let schedSrc = null;
if (existsSync(bunStore)) {
  const e = readdirSync(bunStore).find((d) => /^scheduler@/.test(d));
  if (e) schedSrc = join(bunStore, e, 'node_modules', 'scheduler');
}
copyPkg('scheduler', schedSrc, 'scheduler');
// Live source that moves with the repo — refreshed every build, never skip-if-present.
copyPkg('@leadwolf/types', join(APP_NM, '@leadwolf', 'types'), join('@leadwolf', 'types'), { refresh: true });

// ── 7. lucide barrel ───────────────────────────────────────────────────────
// See lib/gen-lucide.mjs: the real 1000-icon barrel hangs the preview compile, and a hand-inlined stub
// breaks the build every time a component imports a new icon. Scans the whole app src (a slice component
// can import through a shared app module) — unused re-exports tree-shake out.
const lucideRoot = existsSync(join(APP_NM, 'lucide-react'))
  ? join(APP_NM, 'lucide-react')
  : join(ROOT, 'apps', 'web', 'node_modules', 'lucide-react');
const lucideBarrel = join(BUILT, '_lucide.mjs');
// Always scan the workspace packages too: an app slice reaches lucide THROUGH them (ForgeShell renders
// @leadwolf/app-shell's TopBar, which imports seven icons of its own), and a name missing from the barrel
// is a hard bundle failure, not a blank glyph. Over-scanning is free — unused re-exports tree-shake out.
const lucide = generateLucideBarrel({ roots: [...srcRoots, ...pkgSrcRoots], lucideRoot, outFile: lucideBarrel });
step(`lucide barrel: ${lucide.resolved.length} icons → packages/ui/dist/_lucide.mjs`);
if (lucide.unresolved.length) console.error(`  (type-only or unknown, no icon module: ${lucide.unresolved.join(', ')})`);

// ── 8. bundle the app slice ────────────────────────────────────────────────
const require_ = createRequire(join(ROOT, '.ds-sync', 'package.json'));
let esbuild;
try { esbuild = require_('esbuild'); } catch { die('esbuild not staged — run: (cd .ds-sync && npm i esbuild)'); }

// entry.tsx is the single source of truth for which components ship — parsed, so no second list drifts.
const entrySrc = readFileSync(entryFile, 'utf8');
const slice = [...entrySrc.matchAll(/export\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*["']([^"']+)["']/g)]
  .map((m) => ({ name: m[1], abs: resolve(dirname(entryFile), m[2]) }));
if (!slice.length) die(`no \`export { X } from "…"\` lines in ${relative(ROOT, entryFile)}`);

// @leadwolf/ui resolves to the copy step 2 emitted, as an EXTERNAL relative specifier: app.js sits in the
// same dist/ dir, so the converter's outer esbuild pass folds both into one module instance. Inlining it
// would ship a second, non-identical copy of every primitive.
const dsExternal = {
  name: 'ds-external',
  setup(b) { b.onResolve({ filter: /^@leadwolf\/ui$/ }, () => ({ path: './index.js', external: true })); },
};

// manifest.aliases maps a module specifier → a stub FILE NAME resolved through stub(); `lucide-react` is
// wired to the generated barrel automatically unless the manifest overrides it.
const alias = { 'lucide-react': lucideBarrel };
for (const [spec, file] of Object.entries(app.aliases ?? {})) alias[spec] = stub(file);

// manifest.aliasPatterns does the same for RELATIVE specifiers, which esbuild's `alias` cannot express —
// it matches exact bare specifiers only. The extension imports its message client as
// `../../shared/client.ts`, and forge's own lib modules import `./publicConfig`, so the seam that has to be
// stubbed is often reached by a relative path from several different depths. Keys are regex sources tested
// against the raw import specifier.
const patternAliases = Object.entries(app.aliasPatterns ?? {}).map(([re, file]) => [new RegExp(re), stub(file)]);
const relStubs = {
  name: 'rel-stubs',
  setup(b) {
    if (!patternAliases.length) return;
    b.onResolve({ filter: /.*/ }, (a) => {
      for (const [re, path] of patternAliases) if (re.test(a.path)) return { path };
      return null;
    });
  },
};

step(`esbuild ${slice.length} ${appArg} components → packages/ui/dist/app.js`);
try {
  const out = await esbuild.build({
    entryPoints: [entryFile],
    outfile: join(BUILT, 'app.js'),
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic',
    legalComments: 'none', logLevel: 'silent',
    // React stays external for the same reason the DS does: vendorReact owns the one copy.
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', ...(app.external ?? [])],
    loader: { '.module.css': 'local-css', '.css': 'css', '.svg': 'dataurl', '.woff2': 'file', '.png': 'dataurl' },
    alias,
    plugins: [relStubs, dsExternal],
    define: { 'process.env.NODE_ENV': '"production"', ...(app.define ?? {}) },
    // A `process` shim, not a convenience: the apps read NEXT_PUBLIC_* off process.env, which Next inlines
    // at build time and nothing defines here. Aliasing `@/lib/publicConfig` only catches the path-alias
    // import — forge's own lib modules import `./publicConfig` RELATIVELY, so the reference survives and
    // `ReferenceError: process is not defined` throws at module scope. That kills the WHOLE bundle, which
    // is why every one of the 44 unrelated primitives rendered as an empty card until this landed.
    // Undefined values are correct: each read is `process.env.X ?? ""`, which is what the stub returns too.
    banner: { js: 'globalThis.process ??= { env: {} };' },
  });
  for (const w of out.warnings.slice(0, 10)) console.error(`  ! ${w.text} (${w.location?.file}:${w.location?.line})`);
} catch (e) {
  for (const err of (e.errors ?? []).slice(0, 25))
    console.error(`  ✗ ${err.text}\n      ${err.location?.file}:${err.location?.line}:${err.location?.column}`);
  die('app bundle failed — see errors above');
}
console.error(`  app.js: ${(statSync(join(BUILT, 'app.js')).size / 1024).toFixed(0)} KB`);

// ── 9. declaration emit for the slice ──────────────────────────────────────
// Types come from the REAL modules (next, lucide-react, @/lib/*) via the app's own resolution — only the
// RUNTIME is stubbed, so every emitted prop contract matches what the app compiles against.
const DTS_DIR = join(BUILT, 'app-dts');
const pTsconfigPath = join(ROOT, '.ds-app-tsconfig.json');
writeFileSync(pTsconfigPath, JSON.stringify({
  compilerOptions: {
    jsx: 'react-jsx', target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    lib: ['ES2023', 'DOM', 'DOM.Iterable'],
    declaration: true, emitDeclarationOnly: true, noEmit: false, noEmitOnError: false,
    allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true,
    // strict:true is REQUIRED (unlike step 2's DS pass): app types come from zod-inferred schemas in
    // @leadwolf/types, and zod's inference collapses discriminated unions to `never` under strict:false —
    // which ships hollow prop contracts rather than failing loudly.
    skipLibCheck: true, strict: true, verbatimModuleSyntax: false, isolatedModules: false,
    esModuleInterop: true, resolveJsonModule: true,
    outDir: posix(relative(ROOT, DTS_DIR)), rootDir: '.', baseUrl: '.',
    paths: {
      '@leadwolf/ui': ['packages/ui/src/index.ts'],
      '@leadwolf/types': ['packages/types/src/index.ts'],
      ...(app.tsPaths ?? { '@/*': [`apps/${appArg}/src/*`] }),
    },
    // `types` is an allow-list, not a hint: anything omitted is NOT auto-included even when it sits in a
    // typeRoot. The extension needs 'chrome' here or every chrome.* reference in its own source is TS2304.
    types: app.tsTypes ?? ['react', 'react-dom'],
    // The repo root has no node_modules/@types (bun isolates per package), so the default lookup finds
    // nothing and every React type silently degrades. Point at packages that do carry them.
    typeRoots: ['packages/ui/node_modules/@types', posix(relative(ROOT, join(APP_NM, '@types')))],
  },
  include: [
    ...(app.dtsInclude ?? [`apps/${appArg}/src/**/*.ts`, `apps/${appArg}/src/**/*.tsx`]),
    '.design-sync/css-shim.d.ts',
  ],
  exclude: ['**/*.test.ts', '**/*.test.tsx', '**/node_modules/**'],
}, null, 2));
step('tsc declaration emit → packages/ui/dist/app-dts');
const ptsc = spawnSync(process.execPath, [tscBin, '-p', pTsconfigPath], { cwd: ROOT, encoding: 'utf8' });
if (ptsc.stdout?.trim()) console.error(ptsc.stdout.trim().split('\n').slice(0, 20).join('\n'));
const emittedFor = (abs) => join(DTS_DIR, `${relative(ROOT, abs).replace(/\.(tsx|ts)$/, '')}.d.ts`);
const missingDts = slice.filter((s) => !existsSync(emittedFor(s.abs)));
if (missingDts.length)
  die(`no .d.ts emitted for: ${missingDts.map((s) => s.name).join(', ')} — see tsc errors above`);
if (ptsc.status !== 0) console.error('  (tsc reported type errors but emitted declarations — continuing)');
rewriteDts(DTS_DIR);

// The barrel the converter reads. `.js` specifiers (not extensionless) because that is what the emitted
// tree uses after rewriteDts, and a .js specifier resolves to its .d.ts sibling.
writeFileSync(join(BUILT, 'app.d.ts'),
  `${slice.map((s) => {
    const rel = posix(relative(ROOT, s.abs)).replace(/\.(tsx|ts)$/, '');
    return `export { ${s.name} } from './app-dts/${rel}.js';`;
  }).join('\n')}\n`);

// ── 10. combined entry ─────────────────────────────────────────────────────
writeFileSync(join(BUILT, 'ds-entry.js'), "export * from './index.js';\nexport * from './app.js';\n");
writeFileSync(join(BUILT, 'ds-entry.d.ts'), "export * from './index.js';\nexport * from './app.js';\n");
step(`ds-entry: ${slice.length} ${appArg} components + the @leadwolf/ui primitives`);

// ── 11. slice CSS into the shipped stylesheet ──────────────────────────────
// cfg.cssEntry (_compiled.css) ships verbatim as _ds_bundle.css, which styles.css @imports — the only path
// by which CSS reaches a design the agent builds. The slice's module CSS has to land here or its cards
// render unstyled.
const appCss = join(BUILT, 'app.css');
if (existsSync(appCss)) {
  const css = readFileSync(appCss, 'utf8');
  appendFileSync(compiled, `\n/* design-sync: apps/${appArg} feature slice CSS modules */\n${css}`);
  console.error(`  app.css: ${(css.length / 1024).toFixed(0)} KB appended to _compiled.css`);
} else {
  console.error('  (no app.css — this slice has no CSS modules)');
}

step(`done — packages/ui/dist ready for the converter (apps/${appArg})`);
