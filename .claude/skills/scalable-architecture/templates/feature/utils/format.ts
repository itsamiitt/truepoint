// Pure, dependency-free helpers for the Example feature.
// Keep these stateless and easy to unit-test.

import type { Example } from "../types";

/** Human-readable label for an Example. */
export function formatExampleLabel(example: Example): string {
  return `${example.name} (#${example.id})`;
}

/** Sort Examples newest-first by createdAt. */
export function sortByNewest(items: Example[]): Example[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
