#!/usr/bin/env node
// lint-committed-secrets.mjs — the last line before a credential or a PII file becomes permanent history.
//
// .gitignore stops the ACCIDENT (`git add -A` sweeping up an export or a payload drop). It does not stop
// `git add -f`, a path that slips past a pattern, or a key pasted into a source file as a "temporary" default.
// Those are the cases worth failing a build over, because the cost is asymmetric: a wrong commit is a revert,
// a committed secret is a rotation plus a history rewrite on a shared repo, and a committed contact record is
// a person's data that no suppression list can reach.
//
// CI already knows the shape of this risk — the workflow generates a throwaway signing key per run rather than
// committing one, noting "a checked-in private key — even a throwaway — is the kind of thing secret scanners
// flag and humans later copy". There was no scanner. This is it.
//
// It scans TRACKED files only (`git ls-files`), because that is exactly the set that would enter history.
// Deliberately HIGH-PRECISION over exhaustive: a noisy scanner gets disabled, and a disabled scanner protects
// nothing. Every pattern below either has a fixed vendor prefix or is a literal key header — no entropy
// heuristics, no "this looks like a password" guesses.
//
// Run: `node scripts/lint-committed-secrets.mjs` (wired as `bun run lint:secrets`). Exit 0 = clean.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** File types that carry this product's PII in bulk. The .gitignore rules keep them out; this proves it. */
const PII_EXTENSIONS = [".csv", ".xlsx", ".xls", ".rdb"];

/**
 * Credential shapes with a fixed prefix or header.
 *
 * The TruePoint key pattern requires 24+ characters after the band on purpose: a real key is 32 random bytes
 * base64url-encoded (43 chars), while the documented placeholders — `tp_live_…` in the docs and
 * `tp_live_sandbox_not_a_real_key0` in the playground fixture — fall under that threshold and do not trip it.
 * That is the difference between a scanner people keep and one they switch off.
 */
const SECRET_PATTERNS = [
  { name: "PEM private key", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "TruePoint live API key", re: /\btp_live_[A-Za-z0-9_-]{24,}/ },
  { name: "GitHub personal access token", re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: "Slack bot token", re: /\bxoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{20,}/ },
  { name: "Stripe live secret key", re: /\bsk_live_[A-Za-z0-9]{20,}/ },
  { name: "Private key in an env assignment", re: /^[A-Z_]*PRIVATE_KEY[A-Z_]*=\s*\S{40,}/m },
];

/** Binary-ish files are skipped: a match inside compressed bytes is noise, not a leak. */
const SKIP_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pdf",
  ".zip",
];

/** This scanner's own pattern list would otherwise match itself. */
const SELF = "scripts/lint-committed-secrets.mjs";

/**
 * The declared exception, on the line immediately above the match:
 *   // lint-secrets-ok: <why this is not a live credential>
 *
 * Same shape as the itest-rejects escape hatch, and for the same reason. A fixture that LOOKS like a key can
 * be legitimate — packages/config/src/keyMaterial.test.ts needs a real-shaped PEM to prove the base64
 * transport survives docker compose interpolation — but the alternative, teaching the pattern to skip
 * "obviously fake" keys, would also teach it to skip a short real one. An explicit marker keeps the detection
 * sharp and puts the judgement in the diff where a reviewer sees it.
 */
const ALLOW = /lint-secrets-ok:/;

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

if (tracked.length === 0) {
  process.stdout.write(
    "git ls-files returned nothing — this check is blind and must be fixed, not skipped.\n",
  );
  process.exit(1);
}

const findings = [];

for (const file of tracked) {
  const lower = file.toLowerCase();

  if (PII_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    findings.push(
      `${file}: tracked ${lower.slice(lower.lastIndexOf("."))} file — this product's PII format`,
    );
    continue;
  }

  if (file === SELF || SKIP_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // unreadable or genuinely binary — nothing to scan
  }

  for (const { name, re } of SECRET_PATTERNS) {
    const match = re.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split("\n").length;
    // A declared exception within the three lines above (see ALLOW). Three rather than one because the match
    // often lands on a CONTINUATION line — `const PEM =` on its own line, the string beneath it — so a strict
    // "line immediately above" rule misses a marker that a human placed exactly where it reads best.
    const lines = text.split(/\r?\n/);
    if (lines.slice(Math.max(0, line - 4), line - 1).some((l) => ALLOW.test(l))) continue;
    // The matched value is NEVER printed: echoing a live credential into CI logs is the same leak by another
    // route. The location is enough to find it.
    findings.push(`${file}:${line}: ${name}`);
  }
}

if (findings.length === 0) {
  process.stdout.write(
    `ok   ${tracked.length} tracked files, no credentials or PII-format files\n`,
  );
  process.exit(0);
}

process.stdout.write(
  `${findings.length} finding(s) in tracked files:\n\n${findings.join("\n")}\n\n` +
    "A tracked secret is not fixed by deleting it in a later commit — it stays in history. Rotate the\n" +
    "credential FIRST, then remove it. A tracked PII file (.csv/.xlsx/.xls) should be deleted and the export\n" +
    "re-run locally; .gitignore already covers those paths, so its presence means it was force-added.\n" +
    "If a match is a genuine placeholder, make it obviously fake rather than loosening the pattern.\n",
);
process.exit(1);
