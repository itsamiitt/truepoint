// endpointStatus.ts — the one sentence that says how much of the contract you can actually call.
//
// This exists because the landing page got it wrong in the most expensive direction. It said "It is not
// callable yet" about the whole endpoint list, written when none of it was built, and left unchanged after
// the two company endpoints shipped (ADR-0049). Every other surface said the opposite — the endpoint pages
// carried beta badges, the playground simulated real calls, the OpenAPI document listed both operations —
// so the first page a developer reads was the only one telling them there was nothing to try.
//
// It was invisible to the content tests because it was PROSE IN JSX rather than a content module, which is
// exactly the gap verify.mjs's own comment warns about. So the sentence moves here, is DERIVED from the
// availability each endpoint declares, and is asserted in content.test.ts. It cannot be wrong again without
// the endpoint list itself being wrong.

import { ACCESS_NOTE_SHORT } from "./access.ts";
import { ENDPOINTS } from "./endpoints/index.ts";

const WORDS = ["none", "one", "two", "three", "four", "five", "six"] as const;

/** Small counts read better as words in prose; anything larger falls back to the numeral. */
function count(n: number): string {
  return WORDS[n] ?? String(n);
}

export interface EndpointStatus {
  readonly callable: number;
  readonly planned: number;
  readonly total: number;
  /** The sentence the landing page renders. */
  readonly line: string;
}

export function endpointStatus(): EndpointStatus {
  const callable = ENDPOINTS.filter((endpoint) => endpoint.availability !== "planned").length;
  const planned = ENDPOINTS.length - callable;

  const line =
    callable === 0
      ? "None of it is callable yet — the contract is published ahead of the build, and every endpoint page carries its status."
      : planned === 0
        ? `All ${count(ENDPOINTS.length)} are callable today. Every endpoint page carries its status, and the changelog records the day one changes.`
        : `${count(callable).replace(/^./, (c) => c.toUpperCase())} of the ${count(ENDPOINTS.length)} are built and callable (${ACCESS_NOTE_SHORT.toLowerCase()}); the ${count(planned) === "one" ? "other is" : `other ${count(planned)} are`} published contract, not a running service. Every endpoint page carries its status, and the changelog records the day one changes.`;

  return { callable, planned, total: ENDPOINTS.length, line };
}
