// store.ts — the service worker's cache of the tenant's credit balance + per-reveal costs, so the popup/panel
// show a live pill without every surface fetching. Filled on sign-in, refreshed lazily on open (staleness-
// bounded, single-flight), and updated IN PLACE from each reveal's server-authoritative `balanceAfter` — no
// polling, no SSE (the extension is a thin producer). Cleared on sign-out. Reveal costs are tenant-agnostic
// pricing, so they're cached across sign-out.

import type { RevealCosts } from "../../shared/types.ts";
import type { ApiClient } from "../api/client.ts";

const STALE_MS = 30_000;

export class CreditsStore {
  private balanceValue: number | null = null;
  private costsValue: RevealCosts | null = null;
  private fetchedAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly api: ApiClient) {}

  get balance(): number | null {
    return this.balanceValue;
  }

  get costs(): RevealCosts | null {
    return this.costsValue;
  }

  /** Fetch the balance (+ costs once). Single-flight; a no-op within the staleness window unless `force`. */
  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.fetchedAt <= STALE_MS) {
      return;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = (async () => {
      const [balance, costs] = await Promise.all([
        this.api.credits(),
        this.costsValue ? Promise.resolve(this.costsValue) : this.api.revealCosts(),
      ]);
      this.balanceValue = balance;
      this.costsValue = costs;
      this.fetchedAt = Date.now();
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Update from a reveal's server-authoritative post-charge balance (no round-trip). */
  applyReveal(balanceAfter: number | undefined): void {
    if (typeof balanceAfter === "number") {
      this.balanceValue = balanceAfter;
      this.fetchedAt = Date.now();
    }
  }

  /** Sign-out: forget the balance (tenant-specific); keep the tenant-agnostic reveal costs. */
  clear(): void {
    this.balanceValue = null;
    this.fetchedAt = 0;
  }
}
