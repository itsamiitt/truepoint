// LOCAL feature flags (03 §1.9, 09 §5). Flags gate *features* (UX only); the server is authoritative.
// Extraction behavior is NEVER remotely tunable — that is the anti-tamper divergence from Apollo's
// `apiSelectors`.
//
// THIS IS NOT REMOTE CONFIG, and it no longer pretends to be. The file exposed a `killSwitch` flag and
// described itself as "signed remote flags", but nothing ever fetched or verified anything: `load()` reads
// chrome.storage.local, and nothing remote writes it. The documented kill switch could not be operated by
// anyone — it existed only as a field name.
//
// A flag surface that LOOKS like control but is not is worse than none, because an incident is exactly when
// somebody reaches for it. `killSwitch` is therefore removed rather than left as scaffolding.
//
// The authoritative kill already exists server-side and needs no extension release to operate:
//   - `CHROME_EXTENSION_ENABLED` (packages/config) gates the extension's token/API surface outright;
//   - the capture ingress returns 403 `capture_disabled` when the global flag or the per-tenant flag is off
//     (apps/forge-api/src/features/captures/routes.ts).
// Both are enforced where the data actually lands, so a stale or tampered client cannot bypass them — a
// property a client-held kill switch could never have had.
//
// If signed remote config is genuinely wanted it needs a real design: a first-party signed endpoint, Ed25519
// verification in the service worker, and fail-closed-to-last-known-good semantics. That is a feature, not a
// comment in this file.
import { getLocal, setLocal } from "../../shared/storage.ts";

/** Local, UX-only feature gates. Nothing here is a security or incident control. */
export interface FeatureFlags {
  captureEnabled: boolean;
  realtimeSse: boolean;
}

const DEFAULTS: FeatureFlags = {
  captureEnabled: true,
  realtimeSse: false,
};

const FLAGS_KEY = "flags";

export class RemoteConfig {
  private flags: FeatureFlags = { ...DEFAULTS };

  async load(): Promise<void> {
    const cached = await getLocal<Partial<FeatureFlags>>(FLAGS_KEY);
    // Explicit per-key merge rather than a spread: a storage entry written by an older build still carries
    // removed keys (`killSwitch`, `bulkReveal` — the latter torn out for the same reason: nothing ever read
    // it, and a flag that looks operable but is not is worse than none), and a spread would put a removed
    // key back into the live flag object.
    this.flags = {
      captureEnabled: cached?.captureEnabled ?? DEFAULTS.captureEnabled,
      realtimeSse: cached?.realtimeSse ?? DEFAULTS.realtimeSse,
    };
  }

  async save(next: Partial<FeatureFlags>): Promise<void> {
    this.flags = { ...this.flags, ...next };
    await setLocal(FLAGS_KEY, this.flags);
  }

  snapshot(): FeatureFlags {
    return { ...this.flags };
  }

  /** A LOCAL UX gate. Never the last word on whether an action is allowed — the server decides that, and says
   *  so with 403 `capture_disabled` or by disabling the extension surface entirely. */
  isEnabled(flag: keyof FeatureFlags): boolean {
    return Boolean(this.flags[flag]);
  }
}
