// AdapterRegistry — resolves the adapter for the current URL (09 §3).
import type { SiteAdapter } from "./types.ts";

export class AdapterRegistry {
  private readonly adapters: SiteAdapter[] = [];

  register(adapter: SiteAdapter): void {
    this.adapters.push(adapter);
  }

  match(url: URL): SiteAdapter | null {
    return this.adapters.find((adapter) => adapter.matches(url)) ?? null;
  }
}
