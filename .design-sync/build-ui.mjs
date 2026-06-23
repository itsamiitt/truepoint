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
// Run from the repo root: `node .design-sync/build-ui.mjs`. Requires `.ds-sync` staged + its deps installed
// (esbuild ts-morph @types/react @tailwindcss/cli@4.3.1) — see .design-sync/NOTES.md. Re-run before the
// converter on every re-sync.

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

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
writeFileSync(join(BUILT, 'package.json'), JSON.stringify({
  name: '@leadwolf/ui', version: '0.0.0', type: 'module',
  module: './index.js', main: './index.js', types: './index.d.ts', sideEffects: false,
}, null, 2) + '\n');

// ── 4. Geist fonts ─────────────────────────────────────────────────────────
const geist = join(ROOT, 'apps', 'auth', 'node_modules', 'geist', 'dist', 'fonts');
const fontPairs = [
  [join(geist, 'geist-sans', 'Geist-Variable.woff2'), 'Geist-Variable.woff2', 'Geist'],
  [join(geist, 'geist-mono', 'GeistMono-Variable.woff2'), 'GeistMono-Variable.woff2', 'Geist Mono'],
];
let fontCss = '';
for (const [srcF, name, fam] of fontPairs) {
  if (!existsSync(srcF)) { console.error(`  ! geist font missing: ${srcF} — skipped`); continue; }
  cpSync(srcF, join(BUILT, name));
  fontCss += `@font-face{font-family:"${fam}";font-style:normal;font-weight:100 900;font-display:swap;src:url("./${name}") format("woff2");}\n`;
}
writeFileSync(join(BUILT, '_fonts.css'), fontCss);
step(`geist fonts: ${fontCss ? '2 families → dist' : 'NONE (geist package not found)'}`);

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
console.error(`  _compiled.css: ${(statSync(compiled).size / 1024).toFixed(0)} KB`);

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

step('done — packages/ui/dist ready for the converter');
