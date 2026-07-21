// legacyStatus.ts — the 08 §2.4 LEGACY STATUS MAPPING (compatibility window only): old clients polling the
// legacy `GET /imports/:jobId` shape get the v2 12-state vocabulary folded onto the shipped public enum —
// for FAST and COPY jobs alike (S-I9 verified: `staged` is copy-only and maps to `active`, exactly the
// §2.4 table). Extracted from routes.ts so the table is unit-testable (the S-I9 legacy-mapping unit) and
// stays ONE mapping for every legacy-shaped read (poll, cancel/mapping echoes). New clients read the real
// vocabulary via `statusV2`. The window closes with the 08 §1.2 retirement targets.

import type { ImportJobStatus } from "@leadwolf/types";

/** 08 §2.4: v2 durable states → the shipped public enum. `queued/deferred → queued`;
 *  `validating/staged/running/paused → active`; `completed/partial → completed`; `failed → failed`;
 *  `cancelled → failed` with `failedReason: "cancelled"` set by the CALLER (the legacy enum predates the
 *  verb); `draft/uploading` never surface to legacy pollers (the legacy flow skips them) but fold to
 *  `queued` defensively rather than `unknown`. */
export function toLegacyStatusV2(status: string): ImportJobStatus {
  switch (status) {
    case "queued":
    case "deferred":
    case "draft":
    case "uploading":
      return "queued";
    case "validating":
    case "staged":
    case "running":
    case "paused":
      return "active";
    case "completed":
    case "partial":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "unknown";
  }
}
