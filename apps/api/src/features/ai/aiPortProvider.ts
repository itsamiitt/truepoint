// aiPortProvider.ts — the COMPOSITION layer that wires the Anthropic adapter (integrations) into core's
// AiPort and provides the per-tenant budget store (23, ADR-0023). This is the ONLY place the app couples the
// concrete provider to the port — core declares the port and never imports integrations (16 §5); the app
// injects the implementation here, so the boundary check (lint:boundaries) stays green.
//
// The budget store is a single process-local in-memory instance at this milestone (the inline API runs the
// NL-search call in-process — like the waterfall's per-process breaker). A Redis/DB-backed store swaps in
// behind the same AiBudgetStore interface for multi-instance scale with no route change.

import { type AiBudgetStore, type AiPort, createInMemoryBudgetStore } from "@leadwolf/core";
import { anthropicNlSearchAdapter } from "@leadwolf/integrations";

// One shared budget store for the process lifetime (per-tenant/day counters live inside it).
const budgetStore: AiBudgetStore = createInMemoryBudgetStore();

/** The injected NL→search adapter (Anthropic). Reads its API key + model from config; fails closed if unset. */
export function getAiPort(): AiPort {
  return anthropicNlSearchAdapter();
}

/** The process-local per-tenant budget store. */
export function getAiBudgetStore(): AiBudgetStore {
  return budgetStore;
}
