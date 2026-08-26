#!/usr/bin/env node
// lint-prod-switches.mjs — nothing goes live in production by accident.
//
// Most of this codebase's unfinished work ships DARK behind a dual gate: an env kill-switch
// (`z.string().optional().transform(v => v === "true")` — only the literal "true" enables) AND a per-tenant
// `feature_flags` row. Both layers off meant a dark train stayed dark even if someone flipped one by mistake.
//
// That belt-and-braces assumption expired. Migration 0119_enable_all_flags (operator-directed, 2026-08-18)
// set `global_enabled = true` on EVERY defined flag, holding back only channels_read,
// account_read_from_child and entitlements_enforced. So for most features the tenant half is already ON for
// any tenant without an explicit override, and the ENV half is now the only thing keeping them dark. A single
// line added to deploy/env.production.template — `CHANNEL_DUAL_WRITE=true`, say — would take a train from
// "built, dark, never exercised in production" to "live for every tenant" with nothing else changing and no
// other diff to notice.
//
// So arming one has to be a deliberate act with a reviewable diff. This check reads every explicit-"true"
// switch out of packages/config/src/env.ts, reads deploy/env.production.template, and fails if anything is
// set to "true" that is not in the allow-list below. Adding to that list is the deliberate act: it costs one
// entry and a sentence saying why.
//
// It deliberately does NOT police `=false` or absence — those are the safe states. Only arming is gated.
//
// Run: `node scripts/lint-prod-switches.mjs` (wired as `bun run lint:prod-switches`). Exit 0 = clean.

import { readFileSync } from "node:fs";

const ENV_SOURCE = "packages/config/src/env.ts";
const TEMPLATE = "deploy/env.production.template";

/**
 * Switches this deployment intends to run ARMED, each with the reason.
 *
 * A dark-by-default feature does not belong here. If you are adding one because it is ready, the flag half
 * is probably already on (0119) — so this entry IS the enablement decision, not a formality.
 */
const INTENTIONALLY_ARMED = new Map([
  [
    "ENRICHMENT_ASYNC_ENABLED",
    "Enrichment runs as a queued job (202 + job id) instead of on the API request thread. The inline default " +
      "held a DB connection open across up to six external provider calls, so ten concurrent clicks could " +
      "exhaust the 10-connection tenant pool and stall every unrelated request. Not a dark feature — the " +
      "safer of the two behaviours, and the template documents it at the line.",
  ],
  [
    "MASTER_CHANNEL_REVEAL_ENABLED",
    "Reveal serves the licensed Layer-0 channel value for a contact whose workspace copy carries none — the " +
      "path reveal-as-save depends on (decisions.md 2026-08-25). Off, POST /contacts/from-database/reveal " +
      "refuses with 409 before any write and the grid hides database-row reveal buttons, so the Search " +
      "surface cannot save a person at all. Armed on purpose: this IS the product's acquisition gesture.",
  ],
]);

const envSource = readFileSync(ENV_SOURCE, "utf8");
// Line endings normalised: the repo carries CRLF on Windows checkouts, and an unnormalised `$` anchor makes
// every lookup below silently miss — which would turn this gate into one that always passes.
const template = readFileSync(TEMPLATE, "utf8").replace(/\r\n/g, "\n");

/** Every `NAME: z…transform(v => v === "true")` kill-switch declared in the env schema. */
const switches = [
  ...envSource.matchAll(
    /([A-Z][A-Z0-9_]+):\s*z[\s\S]{0,220}?transform\(\(v\)\s*=>\s*v\s*===\s*"true"\)/g,
  ),
].map((match) => match[1]);

if (switches.length === 0) {
  process.stdout.write(
    `Found no explicit-"true" switches in ${ENV_SOURCE}. The schema shape probably changed — this check is
now blind and must be updated rather than deleted.
`,
  );
  process.exit(1);
}

const armed = [];
for (const name of switches) {
  const match = new RegExp(`^\\s*${name}=(.*)$`, "m").exec(template);
  if (match && match[1].trim() === "true") armed.push(name);
}

const unexpected = armed.filter((name) => !INTENTIONALLY_ARMED.has(name));
const stale = [...INTENTIONALLY_ARMED.keys()].filter((name) => !armed.includes(name));

if (unexpected.length === 0 && stale.length === 0) {
  process.stdout.write(
    `ok   ${armed.length} of ${switches.length} env switches armed in ${TEMPLATE}, all accounted for\n`,
  );
  process.exit(0);
}

if (unexpected.length > 0) {
  process.stdout.write(
    `${unexpected.length} env switch(es) are set to "true" in ${TEMPLATE} without a recorded reason:

${unexpected.map((n) => `  ${n}`).join("\n")}

Since migration 0119 turned the per-tenant half of most flags globally on, arming the env half is
often the whole enablement. If that is intended, add the switch to INTENTIONALLY_ARMED in
${import.meta.url.split("/").pop()} with a sentence on why. If it is not, remove the line.
`,
  );
}

if (stale.length > 0) {
  process.stdout.write(
    `
${stale.length} allow-list entr(ies) are no longer armed in the template:

${stale.map((n) => `  ${n}`).join("\n")}

Drop them from INTENTIONALLY_ARMED so the list keeps describing reality.
`,
  );
}

process.exit(1);
