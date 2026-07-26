#!/usr/bin/env node
// .design-sync/build-ui.mjs — reproducible "build" that lets /design-sync convert @leadwolf/ui.
//
// The package ships raw TS source (exports "./src/index.ts", no dist, no build script). The converter
// needs a built entry + a .d.ts tree + a stylesheet, so this script produces a GITIGNORED scratch
// built-package at packages/ui/dist/ plus a couple of node_modules placements:
//   1. tsc full emit (JS + real .d.ts) — authoritative exports + rich *Props contracts for the design agent.
//      Source imports use .ts/.tsx extensions, so allowImportingTsExtensions + rewriteRelativeImportExtensions
//      (TS 5.7+) are required to emit at all.
//   2. dist/package.json — gives the converter a {name, module, types} entry to resolve.
//   3. Geist variable woff2 (the brand font, normally injected by next/font in the apps) + an @font-face css.
//   4. Tailwind v4 compile of tokens.css + theme.css + primitives.css → one self-styling stylesheet so the
//      shadcn primitives (which use Tailwind utility classes) render styled. Input lives in .ds-sync/ so
//      `@import "tailwindcss"` resolves from the staged CLI's node_modules.
//   5. react-dom + scheduler copied into packages/ui/node_modules (React 19 has no UMD, so the converter's
//      vendorReact esbuild-bundles react+react-dom+react-dom/client+scheduler from --node-modules).
//
// Steps 7–11 add the PROSPECT FEATURE SLICE (apps/web/src/features/prospect) to the same bundle, so the
// design agent builds with the real prospect surface and not just the primitives under it:
//   7.  @leadwolf/types placed into packages/ui/node_modules — the emitted prospect .d.ts files import it,
//       and packages/ui doesn't depend on it, so without this ts-morph resolves every prop to `any`.
//   8.  esbuild bundles .design-sync/prospect/entry.tsx → dist/prospect.js, swapping five modules for the
//       stubs in .design-sync/prospect/stubs (next/navigation, next/link, lucide-react, @/lib/authClient,
//       @/lib/publicConfig). @leadwolf/ui stays EXTERNAL as './index.js' so the DS resolves to the single
//       copy step 2 emitted rather than being inlined a second time. The slice's CSS module compiles out
//       to dist/prospect.css.
//   9.  a second tsc pass declaration-emits the slice → dist/prospect-dts/, and dist/prospect.d.ts
//       re-exports each component from there (types come from the REAL modules, runtime from the stubs).
//   10. dist/ds-entry.{js,d.ts} = the DS + the slice; dist/package.json points at it.
//   11. dist/prospect.css appended to _compiled.css so the slice's styles reach cfg.cssEntry.
//
// Run from the repo root: `node .design-sync/build-ui.mjs`. Requires `.ds-sync` staged + its deps installed
// (esbuild ts-morph @types/react @tailwindcss/cli@4.3.1) — see .design-sync/NOTES.md. Re-run before the
// converter on every re-sync.

import { existsSync, readFileSync, writeFileSync, appendFileSync, rmSync, mkdirSync, cpSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const UI = join(ROOT, 'packages', 'ui');
const SRC = join(UI, 'src');
const BUILT = join(UI, 'dist');
const UI_NM = join(UI, 'node_modules');
const DS_SYNC_NM = join(ROOT, '.ds-sync', 'node_modules');

const die = (m) => { console.error('✗ build-ui: ' + m); process.exit(1); };
const step = (m) => console.error('» ' + m);

if (!existsSync(SRC)) die('packages/ui/src not found — run from the repo root');

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

// ── 2. tsc full emit (JS + .d.ts) ──────────────────────────────────────────
const tsconfig = {
  compilerOptions: {
    jsx: 'react-jsx',
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    lib: ['ES2023', 'DOM', 'DOM.Iterable'],
    declaration: true,
    emitDeclarationOnly: false,
    noEmit: false,
    noEmitOnError: false,
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,
    skipLibCheck: true,
    strict: false,
    verbatimModuleSyntax: false,
    isolatedModules: false,
    esModuleInterop: true,
    outDir: './dist',
    rootDir: './src',
    types: ['react', 'react-dom'],
  },
  include: ['src/**/*.ts', 'src/**/*.tsx'],
  exclude: ['node_modules'],
};
const tsconfigPath = join(UI, '.ds-tsconfig.json');
writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
const tscBin = join(UI_NM, 'typescript', 'bin', 'tsc');
if (!existsSync(tscBin)) die(`typescript not found at ${tscBin} — run \`bun install\``);
step('tsc emit → packages/ui/dist');
const tsc = spawnSync(process.execPath, [tscBin, '-p', tsconfigPath], { cwd: UI, encoding: 'utf8' });
if (tsc.stdout?.trim()) console.error(tsc.stdout.trim().split('\n').slice(0, 25).join('\n'));
// tsc exits non-zero on type errors even when it emits (noEmitOnError:false) — gate on the emitted files.
if (!existsSync(join(BUILT, 'index.js')) || !existsSync(join(BUILT, 'index.d.ts')))
  die('tsc did not emit index.js / index.d.ts — see errors above');
if (tsc.status !== 0) console.error('  (tsc reported type errors but emitted output — continuing)');

// 2b. rewriteRelativeImportExtensions fixes the .js emit but leaves the .d.ts barrel with .ts/.tsx
// specifiers (`export { cn } from "./cn.ts"`), which ts-morph's Bundler resolution can't follow → zero
// exports. Rewrite relative .ts/.tsx specifiers to .js in every emitted .d.ts (a .js specifier resolves
// to its .d.ts sibling).
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
// Points at ds-entry (step 10), not index — that's the combined DS + prospect-slice surface the converter
// discovers components from. `exportedNames` walks the `types` .d.ts tree, so this is what decides whether
// the prospect components exist at all as far as the converter is concerned.
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
let copied = 0;
for (const [srcF, name, fam] of fontPairs) {
  if (!existsSync(srcF)) { console.error(`  ! geist font missing: ${srcF} — skipped`); continue; }
  cpSync(srcF, join(BUILT, name));
  copied++;
  fontCss += `@font-face{font-family:"${fam}";font-style:normal;font-weight:100 900;font-display:swap;src:url("./${name}") format("woff2");}\n`;
}
// NOTE: only the @font-face rules survive into the bundle — the converter parses cfg.extraFonts CSS
// for @font-face and drops everything else, so the --font-geist-* bindings below go into _compiled.css
// (cfg.cssEntry, which ships verbatim as _ds_bundle.css), not here.
writeFileSync(join(BUILT, '_fonts.css'), fontCss);
step(`geist fonts: ${copied === fontPairs.length ? '2 families → dist' : `${copied}/${fontPairs.length} families (geist package incomplete)`} + --font-geist-* bindings`);

// ── 5. Tailwind v4 compile ─────────────────────────────────────────────────
const twInput = join(ROOT, '.ds-sync', '_tw-input.css');
writeFileSync(twInput,
  '@import "tailwindcss";\n' +
  '@import "../packages/ui/src/tokens.css";\n' +
  '@import "../packages/ui/src/theme.css";\n' +
  '@import "../packages/ui/src/primitives.css";\n');
const cliPkgDir = join(DS_SYNC_NM, '@tailwindcss', 'cli');
if (!existsSync(cliPkgDir)) die(`@tailwindcss/cli not staged at ${cliPkgDir} — run: (cd .ds-sync && npm i @tailwindcss/cli@4.3.1)`);
const cliPkg = JSON.parse(readFileSync(join(cliPkgDir, 'package.json'), 'utf8'));
const binRel = typeof cliPkg.bin === 'string' ? cliPkg.bin : (cliPkg.bin?.tailwindcss ?? Object.values(cliPkg.bin || {})[0]);
const cliBin = join(cliPkgDir, binRel);
const compiled = join(BUILT, '_compiled.css');
step('tailwind compile → packages/ui/dist/_compiled.css');
const tw = spawnSync(process.execPath, [cliBin, '-i', twInput, '-o', compiled], { cwd: ROOT, encoding: 'utf8' });
if (tw.stderr?.trim()) console.error(tw.stderr.trim().split('\n').slice(0, 25).join('\n'));
if (tw.status !== 0 || !existsSync(compiled)) die('tailwind compile failed — see output above');
// Each app sets --font-geist-sans/-mono on <html> via next/font. The DS bundle has no app, so nothing
// defines them — and tokens.css's `--font-sans: var(--font-geist-sans), "Geist", …` leads with an
// UNGUARDED var(): undefined makes the whole value guaranteed-invalid, so `font-family: var(--font-sans)`
// is invalid at computed-value time and every card AND every design built with the DS falls back to the
// browser default (serif). Bind them to the @font-face families shipped in step 4. Unconditional — even
// with no woff2 this keeps the rest of the stack (-apple-system, Segoe UI) valid instead of dropping to
// Times. Appended here (not to _fonts.css) because only @font-face rules survive the extraFonts parse.
appendFileSync(compiled,
  '\n/* design-sync: bind the next/font variables the host apps normally set on <html>. */\n' +
  ':root{--font-geist-sans:"Geist";--font-geist-mono:"Geist Mono";}\n');
console.error(`  _compiled.css: ${(statSync(compiled).size / 1024).toFixed(0)} KB (+ --font-geist-* bindings)`);

// ── 6. react-dom + scheduler into packages/ui/node_modules ──────────────────
function copyPkg(label, srcDir, destName) {
  const dest = join(UI_NM, destName);
  if (existsSync(join(dest, 'package.json'))) { console.error(`  ${label}: already present`); return; }
  if (!srcDir || !existsSync(srcDir)) die(`${label} source not found: ${srcDir}`);
  cpSync(srcDir, dest, { recursive: true, dereference: true });
  console.error(`  ${label}: copied → packages/ui/node_modules/${destName}`);
}
copyPkg('react-dom', join(ROOT, 'apps', 'auth', 'node_modules', 'react-dom'), 'react-dom');
const bunStore = join(ROOT, 'node_modules', '.bun');
let schedSrc = null;
if (existsSync(bunStore)) {
  const e = readdirSync(bunStore).find((d) => /^scheduler@/.test(d));
  if (e) schedSrc = join(bunStore, e, 'node_modules', 'scheduler');
}
copyPkg('scheduler', schedSrc, 'scheduler');

// ── 7. @leadwolf/types into packages/ui/node_modules ───────────────────────
// The emitted prospect .d.ts files import @leadwolf/types, but packages/ui doesn't depend on it. Without a
// resolvable copy, ts-morph types every prospect prop as `any` and the design agent gets a useless contract.
// Refreshed (not skip-if-present) every build: packages/types is live source that moves with the repo.
function refreshPkg(label, srcDir, destName) {
  const dest = join(UI_NM, destName);
  if (!srcDir || !existsSync(srcDir)) die(`${label} source not found: ${srcDir}`);
  rmSync(dest, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  cpSync(srcDir, dest, { recursive: true, dereference: true });
  console.error(`  ${label}: refreshed → packages/ui/node_modules/${destName}`);
}
step('place @leadwolf/types for the prospect .d.ts tree');
refreshPkg('@leadwolf/types', join(ROOT, 'apps', 'web', 'node_modules', '@leadwolf', 'types'), join('@leadwolf', 'types'));

// ── 8. bundle the prospect feature slice ───────────────────────────────────
const require_ = createRequire(join(ROOT, '.ds-sync', 'package.json'));
let esbuild;
try {
  esbuild = require_('esbuild');
} catch {
  die('esbuild not staged — run: (cd .ds-sync && npm i esbuild)');
}

const PROSPECT = join(ROOT, '.design-sync', 'prospect');
const STUBS = join(PROSPECT, 'stubs');
const entryFile = join(PROSPECT, 'entry.tsx');
if (!existsSync(entryFile)) die(`missing ${entryFile}`);

// entry.tsx is the single source of truth for which components ship — parse it rather than keeping a second
// list here that would silently drift from it.
const entrySrc = readFileSync(entryFile, 'utf8');
const slice = [...entrySrc.matchAll(/export\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*["']([^"']+)["']/g)]
  .map((m) => ({ name: m[1], abs: resolve(PROSPECT, m[2]) }));
if (!slice.length) die('no `export { X } from "…"` lines in .design-sync/prospect/entry.tsx');

// @leadwolf/ui resolves to the copy step 2 emitted, as an EXTERNAL relative specifier: prospect.js sits in
// the same dist/ dir, so the converter's outer esbuild pass folds both into one module instance. Inlining it
// instead would ship a second, non-identical copy of all 43 primitives.
const dsExternal = {
  name: 'ds-external',
  setup(b) {
    b.onResolve({ filter: /^@leadwolf\/ui$/ }, () => ({ path: './index.js', external: true }));
  },
};

step(`esbuild ${slice.length} prospect components → packages/ui/dist/prospect.js`);
try {
  const out = await esbuild.build({
    entryPoints: [entryFile],
    outfile: join(BUILT, 'prospect.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    legalComments: 'none',
    logLevel: 'silent',
    // React stays external for the same reason the DS does: the converter's vendorReact owns the one copy.
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    loader: { '.module.css': 'local-css', '.css': 'css', '.svg': 'dataurl', '.woff2': 'file' },
    alias: {
      'next/navigation': join(STUBS, 'next-navigation.tsx'),
      'next/link': join(STUBS, 'next-link.tsx'),
      'lucide-react': join(STUBS, 'lucide-react.tsx'),
      '@/lib/authClient': join(STUBS, 'authClient.ts'),
      '@/lib/publicConfig': join(STUBS, 'publicConfig.ts'),
      // The narrowed runtime surface, not the barrel — see the header of types-values.ts.
      '@leadwolf/types': join(STUBS, 'types-values.ts'),
    },
    plugins: [dsExternal],
  });
  for (const w of out.warnings.slice(0, 10)) console.error(`  ! ${w.text} (${w.location?.file}:${w.location?.line})`);
} catch (e) {
  for (const err of (e.errors ?? []).slice(0, 20))
    console.error(`  ✗ ${err.text}\n      ${err.location?.file}:${err.location?.line}:${err.location?.column}`);
  die('prospect bundle failed — see errors above');
}
console.error(`  prospect.js: ${(statSync(join(BUILT, 'prospect.js')).size / 1024).toFixed(0)} KB`);

// ── 9. declaration emit for the slice ──────────────────────────────────────
// Types come from the REAL modules (next, lucide-react, @/lib/*) via apps/web's own resolution — only the
// RUNTIME is stubbed. That keeps every emitted prop contract identical to what the app compiles against.
const DTS_DIR = join(BUILT, 'prospect-dts');
const pTsconfigPath = join(ROOT, '.ds-prospect-tsconfig.json');
writeFileSync(pTsconfigPath, JSON.stringify({
  compilerOptions: {
    jsx: 'react-jsx', target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    lib: ['ES2023', 'DOM', 'DOM.Iterable'],
    declaration: true, emitDeclarationOnly: true, noEmit: false, noEmitOnError: false,
    allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true,
    // strict:true is REQUIRED here (unlike step 2's DS pass): the slice's types come from zod-inferred
    // schemas in @leadwolf/types, and zod's inference collapses discriminated unions to `never` under
    // strict:false — which showed up as "Property 'gte' does not exist on type 'never'" and would have
    // shipped hollow prop contracts.
    skipLibCheck: true, strict: true, verbatimModuleSyntax: false, isolatedModules: false,
    esModuleInterop: true, resolveJsonModule: true,
    outDir: relative(ROOT, DTS_DIR).split('\\').join('/'),
    rootDir: '.',
    baseUrl: '.',
    paths: {
      '@/*': ['apps/web/src/*'],
      '@leadwolf/ui': ['packages/ui/src/index.ts'],
      '@leadwolf/types': ['packages/types/src/index.ts'],
    },
    types: ['react', 'react-dom'],
    // The repo root has no node_modules/@types (bun isolates per package), so the default lookup finds
    // nothing and every React type silently degrades. Point at the two packages that do carry them.
    typeRoots: ['packages/ui/node_modules/@types', 'apps/web/node_modules/@types'],
  },
  include: [
    'apps/web/src/features/prospect/**/*.ts',
    'apps/web/src/features/prospect/**/*.tsx',
    '.design-sync/prospect/css-shim.d.ts',
  ],
  exclude: ['**/*.test.ts', '**/*.test.tsx'],
}, null, 2));
step('tsc declaration emit → packages/ui/dist/prospect-dts');
const ptsc = spawnSync(process.execPath, [tscBin, '-p', pTsconfigPath], { cwd: ROOT, encoding: 'utf8' });
if (ptsc.stdout?.trim()) console.error(ptsc.stdout.trim().split('\n').slice(0, 20).join('\n'));
// Same gate as step 2: tsc exits non-zero on type errors it still emitted through (noEmitOnError:false).
const emittedFor = (abs) => join(DTS_DIR, `${relative(ROOT, abs).replace(/\.(tsx|ts)$/, '')}.d.ts`);
const missingDts = slice.filter((s) => !existsSync(emittedFor(s.abs)));
if (missingDts.length)
  die(`no .d.ts emitted for: ${missingDts.map((s) => s.name).join(', ')} — see tsc errors above`);
if (ptsc.status !== 0) console.error('  (tsc reported type errors but emitted declarations — continuing)');
rewriteDts(DTS_DIR);

// The barrel the converter reads. `.js` specifiers (not extensionless) because that is what the rest of the
// emitted tree uses after rewriteDts, and a .js specifier resolves to its .d.ts sibling.
writeFileSync(join(BUILT, 'prospect.d.ts'),
  `${slice.map((s) => {
    const rel = relative(ROOT, s.abs).split('\\').join('/').replace(/\.(tsx|ts)$/, '');
    return `export { ${s.name} } from './prospect-dts/${rel}.js';`;
  }).join('\n')}\n`);

// ── 10. combined entry ─────────────────────────────────────────────────────
writeFileSync(join(BUILT, 'ds-entry.js'), "export * from './index.js';\nexport * from './prospect.js';\n");
writeFileSync(join(BUILT, 'ds-entry.d.ts'), "export * from './index.js';\nexport * from './prospect.js';\n");
step(`ds-entry: ${slice.length} prospect components + the @leadwolf/ui primitives`);

// ── 11. slice CSS into the shipped stylesheet ──────────────────────────────
// cfg.cssEntry (_compiled.css) ships verbatim as _ds_bundle.css, which styles.css @imports — the only path
// by which CSS reaches a design the agent builds. The slice's module CSS has to land here or every prospect
// card renders unstyled.
const prospectCss = join(BUILT, 'prospect.css');
if (existsSync(prospectCss)) {
  const css = readFileSync(prospectCss, 'utf8');
  appendFileSync(compiled, `\n/* design-sync: prospect feature slice (prospect.module.css) */\n${css}`);
  console.error(`  prospect.css: ${(css.length / 1024).toFixed(0)} KB appended to _compiled.css`);
} else {
  console.error('  ! prospect.css not emitted — the slice\'s CSS module produced no output');
}

step('done — packages/ui/dist ready for the converter');
