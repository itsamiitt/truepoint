// Business logic for the Example feature.
// This layer holds the rules and external calls. UI never calls APIs/DB directly (principle #6).
// It may import from shared/, lib/, config/, and its own feature files — NEVER another feature.

import { apiClient } from "../../../lib/apiClient"; // shared HTTP/DB client lives in lib/
import { sortByNewest } from "../utils/format";
import type { CreateExampleInput, Example, ExampleListResult } from "../types";

/** Fetch all Examples, newest-first. */
export async function listExamples(): Promise<ExampleListResult> {
  const items = await apiClient.get<Example[]>("/examples");
  const sorted = sortByNewest(items);
  return { items: sorted, total: sorted.length };
}

/** Create a new Example after validating input. */
export async function createExample(input: CreateExampleInput): Promise<Example> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new Error("Example name is required");
  }
  return apiClient.post<Example>("/examples", { name });
}
