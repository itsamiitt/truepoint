// types.ts — the home slice's view models. The backend has no /home/summary endpoint yet, so the cockpit
// composes its summary client-side from the credits balance + usage endpoints (see api.ts). View-only shapes.
import type { RevealType } from "@leadwolf/types";

/** One recent reveal row from GET /api/v1/credits/usage. */
export interface UsageReveal {
  id: string;
  contactId: string;
  revealType: RevealType;
  creditsConsumed: number;
  revealedAt: string;
}

/** The composed cockpit summary the Home page renders. */
export interface HomeSummary {
  creditBalance: number;
  reveals: UsageReveal[];
}
