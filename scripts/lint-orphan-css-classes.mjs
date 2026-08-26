#!/usr/bin/env node
// lint-orphan-css-classes.mjs — a global `tp-*` / `app-*` class an app's stylesheets never define.
//
// THE BUG THIS EXISTS FOR. apps/auth's AuthShell centres every sign-in screen with
// `<main className="tp-center-screen">`. That class is defined in exactly one file,
// @leadwolf/app-shell/src/shell.css — which apps/auth does not import, and does not even list as a
// dependency. So it resolved to NOTHING: <main> was an unstyled block, and every auth card rendered flush
// against the top-left corner of the window at width:100%/max-width:400px. Login, password, forgot, reset,
// signup, magic, mfa, sso — all of them, on every deploy, until someone looked at it.
//
// The failure mode is what makes this worth a gate. An unknown class is not an error anywhere in the stack:
// not to the compiler, not to the bundler, not to the browser, not to any test that renders the component and
// asserts on its text. The three apps that DO import shell.css made the name look correct wherever it was
// copied from, and the commit that introduced it even enumerated the three surviving global classes by name
// without checking that one of them resolved. Nothing but a human eye on a rendered page could catch it.
//
// WHAT COUNTS. Only the project's own GLOBAL class namespaces — `tp-*` and `app-*`. Everything else in this
// codebase is out of scope by construction and stays that way:
//   • Tailwind utilities (`flex`, `mb-4`) are generated at build time and have no source definition to find.
//   • CSS-module classes are reached as `styles.spaced`, never as a literal, so they are invisible here —
//     which is correct, since the module system already fails loudly on a missing key under typed CSS.
//   • Third-party classes (`cf-turnstile`, injected by Cloudflare's script) carry neither prefix.
//
// HOW REACHABILITY IS COMPUTED. Each app's globals.css is parsed for `@import`, following the chain through
// workspace packages (resolved via their package.json `exports`, so a rename of the file behind an export
// specifier is followed correctly) and relative paths. The classes DEFINED by that closure — plus any other
// non-module .css inside the app — are what the app can actually use. This is the same question the browser
// asks, answered at lint time.
//
// Escape hatch, on the line above or within three lines:
//   {/* orphan-css-ok: <where this class comes from> */}
// The real case is a class applied to an element inside a third-party or injected subtree.
//
// Run: `node scripts/lint-orphan-css-classes.mjs` (wired as `bun run lint:orphan-css`). Exit 0 = clean.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const APPS_DIR = "apps";
const PACKAGES_DIR = "packages";
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo"]);
const ALLOW = /orphan-css-ok:/;

/** The project's own global class namespaces. Anything outside these is someone else's to define. */
const OWNED_CLASS = /^(?:tp|app)-[a-z0-9-]+$/;

/** Resolve an `@import` specifier to a file path, or null when it is external (e.g. "tailwindcss"). */
function resolveImport(spec, fromFile) {
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const p = resolve(dirname(fromFile), spec);
    return existsSync(p) ? p : null;
  }
  const workspace = spec.match(/^@leadwolf\/([^/]+)\/(.+)$/);
  if (!workspace) return null; // "tailwindcss" and any other external package
  const [, pkg, subpath] = workspace;
  const manifestPath = join(PACKAGES_DIR, pkg, "package.json");
  if (!existsSync(manifestPath)) return null;
  const exportsMap = JSON.parse(readFileSync(manifestPath, "utf8")).exports ?? {};
  const target = exportsMap[`./${subpath}`];
  if (typeof target !== "string") return null;
  const p = join(PACKAGES_DIR, pkg, target);
  return existsSync(p) ? p : null;
}

/** Every class name a stylesheet defines — `.tp-card`, `.a.b`, `.x:hover`, `.p .q`. */
function definedClasses(cssPath, into) {
  const css = readFileSync(cssPath, "utf8");
  // Strip comments so a class name discussed in prose is not mistaken for a definition.
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    into.add(m[1]);
  }
}

/** Follow an app's globals.css @import chain and collect every class it can actually reach. */
function reachableClasses(entryCss) {
  const seen = new Set();
  const classes = new Set();
  const queue = [resolve(entryCss)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    definedClasses(file, classes);
    const css = readFileSync(file, "utf8");
    for (const m of css.matchAll(/@import\s+["']([^"']+)["']/g)) {
      const next = resolveImport(m[1], file);
      if (next) queue.push(resolve(next));
    }
  }
  return classes;
}

function walk(dir, pattern, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, pattern, out);
    else if (pattern.test(full)) out.push(full);
  }
  return out;
}

function allowedNear(lines, lineIndex) {
  for (let i = Math.max(0, lineIndex - 3); i <= lineIndex; i += 1) {
    if (ALLOW.test(lines[i] ?? "")) return true;
  }
  return false;
}

const failures = [];
for (const appDir of readdirSync(APPS_DIR)) {
  const appRoot = join(APPS_DIR, appDir);
  if (!statSync(appRoot).isDirectory()) continue;
  const globals = join(appRoot, "src", "app", "globals.css");
  const srcDir = join(appRoot, "src");
  if (!existsSync(globals) || !existsSync(srcDir)) continue;

  const classes = reachableClasses(globals);
  // Plus every other plain (non-module) stylesheet the app ships — a page-scoped global sheet still defines
  // real global classes even when globals.css does not import it.
  for (const css of walk(srcDir, /\.css$/)) {
    if (!css.endsWith(".module.css")) definedClasses(css, classes);
  }

  for (const file of walk(srcDir, /\.(tsx|jsx)$/)) {
    const source = readFileSync(file, "utf8");
    const lines = source.split(/\r?\n/);
    // Only LITERAL className values — a plain string or a template literal. An expression (`styles.x`,
    // clsx(...), a variable) carries no literal to check and is left alone.
    for (const m of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const value = m[1] ?? m[2] ?? "";
      // Replace `${...}` with a character that cannot appear in a class name, rather than with a space. A
      // space would SPLIT a computed name into a checkable-looking stem: `tp-ui-btn--${variant}` becomes the
      // token `tp-ui-btn--`, which no stylesheet defines and which is not a class anyone wrote. Substituting
      // U+FFFF keeps the token whole and makes it fail OWNED_CLASS, so a computed name is skipped — which is
      // the right answer, since its real value is only known at runtime.
      for (const token of value.replace(/\$\{[^}]*\}/g, "￿").split(/\s+/)) {
        if (!OWNED_CLASS.test(token) || classes.has(token)) continue;
        const line = source.slice(0, m.index ?? 0).split(/\r?\n/).length - 1;
        if (allowedNear(lines, line)) continue;
        failures.push(
          `${file.replace(/\\/g, "/")}:${line + 1}  .${token} is not defined by any stylesheet ` +
            `apps/${appDir} imports — it renders as no styling at all.`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error(
    `\nlint:orphan-css — ${failures.length} class(es) resolve to nothing at runtime:\n`,
  );
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "\nAn unknown class is silent everywhere — compiler, bundler, browser and DOM tests all accept it.\n" +
      "Either import the stylesheet that defines it into the app's globals.css, define the rule there,\n" +
      "or annotate an injected/third-party subtree with `orphan-css-ok: <where it comes from>`.\n",
  );
  process.exit(1);
}

console.log("lint:orphan-css — clean");
