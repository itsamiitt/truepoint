// Signed remote flags + kill switch (03 §1.9, 09 §5). Flags gate *features* (UX only); the server is
// authoritative. Extraction behavior is NEVER remotely tunable — that is the anti-tamper divergence
// from Apollo's `apiSelectors`. This scaffold caches flags locally; the signed fetch + signature check
// is the follow-up (fail-closed to last-known-good / safe defaults).
import { getLocal, setLocal } from "../../shared/storage.ts";

export interface FeatureFlags {
  captureEnabled: boolean;
  bulkReveal: boolean;
  realtimeSse: boolean;
  killSwitch: boolean;
}

const DEFAULTS: FeatureFlags = {
  captureEnabled: true,
  bulkReveal: false,
  realtimeSse: false,
  killSwitch: false,
};

const FLAGS_KEY = "flags";

export class RemoteConfig {
  private flags: FeatureFlags = { ...DEFAULTS };

  async load(): Promise<void> {
    const cached = await getLocal<Partial<FeatureFlags>>(FLAGS_KEY);
    this.flags = { ...DEFAULTS, ...cached };
  }

  async save(next: Partial<FeatureFlags>): Promise<void> {
    this.flags = { ...this.flags, ...next };
    await setLocal(FLAGS_KEY, this.flags);
  }

  snapshot(): FeatureFlags {
    return { ...this.flags };
  }

  /** A feature is on only when the kill switch is off and its flag is set. */
  isEnabled(flag: keyof FeatureFlags): boolean {
    if (this.flags.killSwitch) {
      return false;
    }
    return Boolean(this.flags[flag]);
  }
}
