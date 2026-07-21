// forge.ts — the TruePoint Forge data-plane config (ADR-0046/0047; re-homed from @forge/config). Read from
// process.env directly so the big appEnvSchema stays untouched. Capture + sync egress are DARK by default
// (kill-switches off) until legal sign-off (OQ-2). BLIND_INDEX_KEY is a dev default; production sources a
// KMS-wrapped key.

/** Below this size a payload stays inline (column-encrypted); above it offloads to the object store (OQ-4). */
export const OBJECT_STORE_THRESHOLD_BYTES = 8 * 1024;
/** Per-record hard byte cap → 413 (07 §status-code contract). */
export const RECORD_MAX_BYTES = 5 * 1024 * 1024;
/** Per-envelope hard byte cap → 413. */
export const ENVELOPE_MAX_BYTES = 20 * 1024 * 1024;
/** Record-volume throttle (mirrors checkCaptureRate). */
export const RECORD_LIMIT_PER_MIN = 2000;
/** Payload-byte throttle. */
export const PAYLOAD_BYTE_LIMIT_PER_MIN = 64 * 1024 * 1024;

/** In-repo endpoint allowlist — a payload outside it is rejected (anti-tamper, ADR-0046 #5). */
export const ENDPOINT_ALLOWLIST = [
  "voyager/identity/profiles",
  "voyager/identity/dash/profiles",
] as const;

/** Capture + sync egress kill-switches (dark by default, ADR-0046/0047). */
export const forgeFlags = {
  captureEnabled: process.env.FORGE_CAPTURE_ENABLED === "true",
  syncEgressEnabled: process.env.FORGE_SYNC_EGRESS_ENABLED === "true",
} as const;

const enabledTenants = new Set(
  (process.env.FORGE_CAPTURE_TENANTS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean),
);
/** Per-tenant interception enablement (07 §per-tenant flag). No tenant runs capture until explicitly listed. */
export function isTenantCaptureEnabled(tenantId: string): boolean {
  return enabledTenants.has(tenantId);
}

/** The silver-layer blind-index HMAC key (08). Dev default is deterministic so golden-fixture tests are stable. */
export const BLIND_INDEX_KEY = process.env.FORGE_BLIND_INDEX_KEY ?? "forge-dev-blind-index-key";

/** S3/MinIO object store for large raw payloads (Phase 4). */
export const forgeS3Config = {
  endpoint: process.env.S3_ENDPOINT,
  bucket: process.env.S3_BUCKET ?? "forge-raw-captures",
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  region: process.env.S3_REGION ?? "us-east-1",
};

/** Anthropic extraction model config (Phase 4; ENABLED — costs real tokens at the extract stage). */
export const forgeExtractConfig = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
  version: process.env.ANTHROPIC_VERSION ?? "2023-06-01",
  model: process.env.FORGE_EXTRACT_MODEL ?? "claude-haiku-4-5-20251001",
};
