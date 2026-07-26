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
