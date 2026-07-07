// @forge/core SchemaVer (08 §Schema evolution). Snowplow SchemaVer MODEL-REVISION-ADDITION, whose number
// ENCODES compatibility ([S43]): ADDITION = compatible with all history (auto-publishable), REVISION = may
// break some history (differential test required), MODEL = breaking (downstream-first + coordination).
export interface SchemaVer {
  model: number;
  revision: number;
  addition: number;
}

const SCHEMAVER = /^(\d+)-(\d+)-(\d+)$/;

export function parseSchemaVer(s: string): SchemaVer {
  const m = SCHEMAVER.exec(s);
  if (!m) throw new Error(`invalid SchemaVer: ${s}`);
  return { model: Number(m[1]), revision: Number(m[2]), addition: Number(m[3]) };
}

export function formatSchemaVer(v: SchemaVer): string {
  return `${v.model}-${v.revision}-${v.addition}`;
}

/** -1 | 0 | 1 ordering by (model, revision, addition). */
export function compareSchemaVer(a: SchemaVer, b: SchemaVer): number {
  return a.model - b.model || a.revision - b.revision || a.addition - b.addition;
}

export type BumpClass = "ADDITION" | "REVISION" | "MODEL" | "NONE";

/** Classify prev→next by the highest-order component that increased (08 §Schema evolution matrix). */
export function classifyBump(prev: SchemaVer, next: SchemaVer): BumpClass {
  if (next.model > prev.model) return "MODEL";
  if (next.model < prev.model) return "MODEL"; // any model change is breaking
  if (next.revision !== prev.revision) return "REVISION";
  if (next.addition !== prev.addition) return "ADDITION";
  return "NONE";
}

export type Compatibility = "BACKWARD" | "FORWARD" | "FULL" | "NONE";

/** The compatibility mode a bump implies (08 §Schema evolution): ADDITION→FULL, REVISION→BACKWARD, MODEL→NONE. */
export function requiredCompatibility(bump: BumpClass): Compatibility {
  switch (bump) {
    case "ADDITION":
      return "FULL";
    case "REVISION":
      return "BACKWARD";
    case "MODEL":
      return "NONE";
    default:
      return "FULL";
  }
}

/** Only an ADDITION may auto-publish; a REVISION needs a differential test, a MODEL needs coordination (08). */
export function canAutoPublish(bump: BumpClass): boolean {
  return bump === "ADDITION" || bump === "NONE";
}

/** A REVISION or MODEL requires a differential test vs the prior active version before publish (08). */
export function requiresDifferentialTest(bump: BumpClass): boolean {
  return bump === "REVISION" || bump === "MODEL";
}
