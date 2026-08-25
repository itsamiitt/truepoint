#!/usr/bin/env node
// lint-env-template-coverage.mjs — every REQUIRED env var must appear in deploy/env.production.template.
//
// `@leadwolf/config` validates at IMPORT. A required var missing from the production template is therefore not
// a degradation that shows up later under load — it is a boot failure, and CLAUDE.md already documents how it
// presents: a Next build "dies with a bare `Required` list and a 'Failed to collect page data' trace that
// names no cause". Zod names the key it wanted; nothing names the file that was supposed to carry it.
//
// Required here means exactly one thing: a schema entry with no `.optional(` and no `.default(` anywhere in
// its declaration. Everything else has a fallback and can legitimately be absent — which is most of the
// schema, and the reason absence is normally fine. Measured on 2026-08-25: 154 schema declarations, 5 truly
// required (AUTH_COOKIE_DOMAIN, BLIND_INDEX_KEY, DATABASE_URL, JWT_SIGNING_KID, REDIS_URL), all present.
//
// IT MATCHES `NAME: z.` AND NOT `NAME:` ALONE, and that distinction is the whole correctness of this check.
// env.ts declares the schema and then, in loadEnv, RETURNS an object using the same keys — `JWT_PRIVATE_KEY_PEM:
// decodeKeyMaterial(...)`. A scan that accepted any `NAME:` at four-space indent sees each of those a second
// time, in a block containing no `.default(`, and reports it as required. The first version of this check did
// exactly that and announced three missing required keys — JWT_PRIVATE_KEY_PEM among them, which is declared
// `z.string().default("")` twenty lines earlier. Alarming and wrong. The same mistake in the permissive
// direction would have reported all-clear, which is why the rule is written down rather than just fixed.
//
// It does NOT check the reverse (a template var with no schema entry): an extra line in the template is inert,
// and the deploy legitimately appends generated values — deploy.sh writes JWT_PRIVATE_KEY_PEM_B64 and
// JWT_PUBLIC_KEY_PEM_B64 into .env.production after generating the keypair, and those must never be in a
// tracked template.
//
// Run: `node scripts/lint-env-template-coverage.mjs` (wired as `bun run lint:env-template`).

import { readFileSync } from "node:fs";

const ENV_SCHEMA = "packages/config/src/env.ts";
const TEMPLATE = "deploy/env.production.template";

const lines = readFileSync(ENV_SCHEMA, "utf8").split("\n");
const template = readFileSync(TEMPLATE, "utf8").replace(/\r\n/g, "\n");

/** Schema entries only — `NAME: z.…`. See the header for why `NAME:` alone is not enough. */
const declarations = [];
for (let i = 0; i < lines.length; i += 1) {
  const m = /^(\s{4})([A-Z][A-Z0-9_]*):\s*z\./.exec(lines[i]);
  if (m) declarations.push({ name: m[2], start: i });
}

if (declarations.length === 0) {
  process.stdout.write(
    `no schema declarations found in ${ENV_SCHEMA} — the pattern this check relies on has changed, and a\ncheck that matches nothing passes everything. Fix the pattern rather than deleting the gate.\n`,
  );
  process.exit(1);
}

// A declaration's block runs to the next declaration at the same indent: these span several lines, and the
// `.optional(` or `.default(` that makes one non-required is often not on the first.
const required = [];
for (let i = 0; i < declarations.length; i += 1) {
  const from = declarations[i].start;
  const to = i + 1 < declarations.length ? declarations[i + 1].start : lines.length;
  const block = lines.slice(from, to).join("\n");
  if (/\.optional\(|\.default\(/.test(block)) continue;
  required.push(declarations[i].name);
}

const present = new Set([...template.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
const missing = required.filter((name) => !present.has(name)).sort();

if (missing.length === 0) {
  process.stdout.write(
    `ok   ${declarations.length} schema declarations · ${required.length} required, all present in ${TEMPLATE}\n`,
  );
  process.exit(0);
}

process.stdout.write(
  `${missing.length} REQUIRED env var(s) missing from ${TEMPLATE}:\n${missing
    .map((n) => `  ${n}`)
    .join(
      "\n",
    )}\n\n@leadwolf/config validates at import, so each of these is a BOOT failure rather than a missing feature: the\nprocess dies with a bare "Required" list naming the key and nothing naming the file that should have carried\nit. Add the var to the template — with a placeholder value if the real one is a secret — or give the schema\nentry a .default()/.optional() if it is genuinely not required.\n`,
);
process.exit(1);
