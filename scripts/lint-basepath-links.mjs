#!/usr/bin/env node
// lint-basepath-links.mjs — a root-relative <a href> inside a basePath app leaves the app.
//
// THE BUG THIS EXISTS FOR. apps/auth runs at `basePath: "/auth"`. Next applies that prefix to next/link, the
// router and redirect() — but NOT to a raw `<a href="/forgot">`, which is plain HTML the BROWSER resolves
// against the ORIGIN. So a page served at auth.truepoint.in/auth/password linked to
// auth.truepoint.in/forgot, which is outside the app and 404s. Nine anchors shipped that way, and one of them
// was the ONLY route to the password-reset flow — "Forgot password?" — so reset was unreachable while the
// page and its server action both worked perfectly. That is why it read as "forgot password is broken"
// rather than as a broken link.
//
// It is a nasty class of defect for three compounding reasons: the flow's own redirects DO get the prefix, so
// everything except the anchors works and the app looks fine; the failure is a 404 rather than an exception,
// so nothing logs; and the SAME MISTAKE had already been found and fixed once for the mailed links (AUTH-062
// → authUrl.ts) without anyone checking the in-page half. A rule that has already been re-learned once is
// exactly the kind this directory exists to stop re-learning.
//
// WHAT COUNTS. Only apps that actually SET basePath in next.config.mjs are scanned, and the prefix is read
// from that file rather than hardcoded — so this starts working for any future app the moment it adopts one,
// and stays silent for the four apps that have none.
//
// Flagged: a raw `<a>` whose href is root-relative and does not already start with the app's basePath.
//   href="/forgot"              → flagged
//   href={`/login?${carry}`}    → flagged
//   href={authPath("/forgot")}  → clean (the helper adds the prefix)
//   href="/auth/forgot"         → clean (already prefixed, though the helper is preferred)
//   href="https://…" · "//cdn…" · "#anchor" · "mailto:" · "?tab=x" · relative "../x" → not root-relative
//   <Link href="/forgot">       → clean; next/link prefixes it itself
//
// The check is on the ANCHOR ELEMENT, not on every string that looks like a path: a route constant, a
// redirect() target and a fetch() URL are all correct unprefixed (redirect() and the router add it), and
// flagging them would make this noise. That narrowness is the whole design — a link lint that cries wolf gets
// deleted faster than the bug it prevents.
//
// Escape hatch, on the line above or within three lines:
//   {/* basepath-link-ok: <why this must escape the basePath> */}
// The legitimate case is a deliberate link OUT of the app (to the marketing site, to the docs origin) written
// as a root-relative path on a single-domain deploy.
//
// Run: `node scripts/lint-basepath-links.mjs` (wired as `bun run lint:basepath-links`). Exit 0 = clean.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const APPS_DIR = "apps";
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo"]);
const ALLOW = /basepath-link-ok:/;

/** The app's configured basePath, or null when it has none (the common case — only apps/auth sets one). */
function basePathOf(appDir) {
  const config = join(APPS_DIR, appDir, "next.config.mjs");
  if (!existsSync(config)) return null;
  // Deliberately a regex and not an import: reading the value must not execute the config, which pulls in
  // @leadwolf/config and would make a lint depend on a valid environment.
  const match = readFileSync(config, "utf8").match(/^\s*basePath:\s*["'`]([^"'`]+)["'`]/m);
  return match?.[1] ?? null;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|jsx)$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * Every `<a … href=…>` in `source`, as { index, href }. Matches across newlines because these anchors are
 * routinely formatted with the className on one line and the href on the next.
 */
function anchorHrefs(source) {
  const found = [];
  const re = /<a\b[^>]*?\bhref=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/gs;
  for (const m of source.matchAll(re)) {
    found.push({ index: m.index ?? 0, href: m[1] ?? m[2] ?? m[3] ?? "" });
  }
  return found;
}

/**
 * Is this href a root-relative path that will escape `basePath`?
 *
 * The expression form (`{...}`) is checked for a leading `/` inside its first string or template literal —
 * `{`/login?${carry}`}` is the shape that shipped. An expression that starts with an identifier (a helper
 * call like authPath(...), or a variable) is treated as clean: the helper is the fix, and a variable's value
 * cannot be known here. That is a deliberate under-report — this gate exists to catch the LITERAL that a
 * developer types, which is every instance of the bug it was written for.
 */
function escapesBasePath(href, basePath) {
  const raw = href.trim();
  if (raw === "") return false;

  // Expression form: only a leading literal is judged.
  const literal =
    raw.startsWith("`") || raw.startsWith('"') || raw.startsWith("'")
      ? raw.slice(1)
      : /^[/]/.test(raw)
        ? raw
        : null;
  if (literal === null) return false; // helper call, variable, ternary — not judgeable, not flagged

  if (!literal.startsWith("/")) return false; // #anchor, ?query, mailto:, https:, ../relative
  if (literal.startsWith("//")) return false; // protocol-relative — an absolute URL, not an in-app path
  return !(
    literal === basePath ||
    literal.startsWith(`${basePath}/`) ||
    literal.startsWith(`${basePath}?`)
  );
}

function allowedNear(lines, lineIndex) {
  for (let i = Math.max(0, lineIndex - 3); i <= lineIndex; i += 1) {
    if (ALLOW.test(lines[i] ?? "")) return true;
  }
  return false;
}

const failures = [];
for (const appDir of readdirSync(APPS_DIR)) {
  if (!statSync(join(APPS_DIR, appDir)).isDirectory()) continue;
  const basePath = basePathOf(appDir);
  if (!basePath) continue;

  const srcDir = join(APPS_DIR, appDir, "src");
  if (!existsSync(srcDir)) continue;

  for (const file of walk(srcDir)) {
    const source = readFileSync(file, "utf8");
    const lines = source.split(/\r?\n/);
    for (const { index, href } of anchorHrefs(source)) {
      if (!escapesBasePath(href, basePath)) continue;
      const line = source.slice(0, index).split(/\r?\n/).length - 1;
      if (allowedNear(lines, line)) continue;
      failures.push(
        `${file.replace(/\\/g, "/")}:${line + 1}  <a href={${href.trim()}}> is root-relative — the browser ` +
          `resolves it against the ORIGIN, escaping basePath "${basePath}". Wrap it: authPath(...).`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(
    `\nlint:basepath-links — ${failures.length} anchor(s) will 404 by leaving their app's basePath:\n`,
  );
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "\nbasePath is applied to next/link, the router and redirect() — never to a raw <a href>.\n" +
      "Use the app's path helper (apps/auth: authPath from @/lib/authUrl), or annotate a deliberate\n" +
      "link out of the app with `basepath-link-ok: <why>` on the line above.\n",
  );
  process.exit(1);
}

console.log("lint:basepath-links — clean");
