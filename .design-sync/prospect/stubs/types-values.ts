// stubs/types-values.ts — the runtime half of @leadwolf/types, narrowed.
//
// The slice imports 62 things from @leadwolf/types and 60 of them are `import type` — erased at build time.
// Only these two are real values. Aliasing the package to its barrel pulled every zod schema in the package
// into the bundle (schemas are constructed at module scope, so tree-shaking can't drop them): 503 KB of
// which almost none was reachable. Pointing the alias here instead imports only the two modules that matter.
//
// TYPES still come from the real package — the declaration-emit pass in build-ui.mjs maps @leadwolf/types to
// packages/types/src/index.ts, so the emitted .d.ts contracts are unaffected by this narrowing.
//
// Adding a runtime import from @leadwolf/types to the slice means adding it here, or the bundle fails with
// "No matching export" — which is the intended loud failure, not a silent undefined.
export { contactQuery } from "../../../packages/types/src/search";
export { REVEAL_JOB_TERMINAL } from "../../../packages/types/src/bulkReveal";
// The facet enums filterGroups.ts reads .options off to build the rail's checkbox groups.
export {
  emailStatus,
  outreachStatus,
  seniorityLevel,
  sourceName,
} from "../../../packages/types/src/contacts";
// Provenance copy (RecordDetail) and field-age math (RevealDialog). Both modules are pure — sourceLabel.ts
// is a string map and dataHealth.ts is documented PURE scoring math — so neither drags zod in.
export { sourceLabel } from "../../../packages/types/src/sourceLabel";
export { ageDaysSince } from "../../../packages/types/src/dataHealth";

// Runtime values the wider app slice reads. Each is imported from its OWN module rather than the barrel,
// for the reason in the header: the barrel constructs every zod schema at module scope, so aliasing it
// pulls ~500 KB of unreachable schemas into the bundle.
export { mergePreviewSchema, mergeResultSchema } from "../../../packages/types/src/contactMerge";
export { reportsSummarySchema } from "../../../packages/types/src/reports";
export { KNOWN_ENRICH_PROVIDERS } from "../../../packages/types/src/intel";
