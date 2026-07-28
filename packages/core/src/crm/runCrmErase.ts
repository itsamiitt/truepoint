// runCrmErase.ts — the OUTBOUND erasure step of a DSAR (crm-sync 00 §3.3 erasure / §7.6).
//
// The existing deleteFanout erases a subject INWARD: it tombstones every TruePoint copy, purges dependents
// and writes a global suppression row. This is the outward half — telling the customer's CRM to erase the
// same subject, because a DSAR that stops at our own database has not actually erased the person.
//
// THE ORDERING IS THE COMPLIANCE PROPERTY, and it is the opposite of what the code wants to do:
//
//   The link row is deleted ONLY AFTER the provider confirms the erase.
//
// crm_record_links carries the crm_record_id — the only thing that tells the CRM WHAT to delete. Deleting
// the row first (or on a failure) strands the subject in the customer's CRM permanently AND removes the
// evidence that they are still there, while the DSAR's residual scan goes quiet and the request reports
// `completed`. That is a false erasure claim on a regulated request. So: confirm, then delete. On any
// failure the link SURVIVES, the residual scan keeps counting it, and the DSAR cannot complete — which is
// the correct, loud outcome.
//
// THIS RUNNER IGNORES sync_mode. Shadow is a dark-launch gate for ordinary sync traffic; an erasure is a
// legal obligation, not a sync. A connection sitting in `shadow` still has the subject's data in the CRM,
// and refusing to erase it because the operator has not finished piloting the integration would be
// indefensible. The env kill switch is honoured only because with it off the engine may have no working
// credentials at all — and in that case the link survives and the DSAR stays open, which is again correct.

import type { CrmObjectType, CrmProvider } from "@leadwolf/types";
import type { CrmConnector, CrmEraseMode, CrmTokenBundle } from "./port.ts";

export interface CrmEraseDeps {
  loadTokenBundle(): Promise<CrmTokenBundle>;
  /** Delete the link — called ONLY after the provider confirms. */
  deleteLink(linkId: string): Promise<void>;
  /** Write the crm.erase audit row (ids + provider only, never the subject's data). */
  writeEraseAudit(args: { crmRecordId: string; mode: CrmEraseMode }): Promise<void>;
}

export interface RunCrmEraseInput {
  provider: CrmProvider;
  objectType: CrmObjectType;
  /** The link row being erased — its id, and the CRM record it points at. */
  linkId: string;
  crmRecordId: string;
  /**
   * How to erase. `gdpr_delete` where the provider offers a true right-to-be-forgotten endpoint (HubSpot);
   * `anonymize` where a hard delete is impossible or would break the customer's own records (a converted
   * Salesforce Lead with activity history). Chosen by the caller per provider, never guessed here.
   */
  mode: CrmEraseMode;
  /** L1 only. sync_mode is deliberately NOT consulted — see the header. */
  envEnabled: boolean;
  connector: CrmConnector;
  deps: CrmEraseDeps;
}

export type CrmEraseOutcome =
  | "erased" // the CRM confirmed; the link is gone and the DSAR can proceed
  | "already_absent" // the CRM no longer has the record; treated as success
  | "gated" // the engine is off — the link SURVIVES and the DSAR stays open
  | "rate_limited"
  | "failed";

export interface RunCrmEraseResult {
  outcome: CrmEraseOutcome;
  reason?: string;
  retryAfterMs?: number;
  /** True only when the link row was actually removed — i.e. the residual is genuinely cleared. */
  linkCleared: boolean;
}

export async function runCrmErase(input: RunCrmEraseInput): Promise<RunCrmEraseResult> {
  if (!input.envEnabled) {
    // The link survives on purpose: the residual scan keeps counting it and the DSAR cannot report
    // `completed` while the subject is still in the CRM.
    return { outcome: "gated", reason: "env_disabled", linkCleared: false };
  }

  const bundle = await input.deps.loadTokenBundle();
  const result = await input.connector.eraseOrSuppress({
    bundle,
    object: input.objectType,
    externalId: input.crmRecordId,
    mode: input.mode,
  });

  if (result.kind === "not_found") {
    // The record is already gone from the CRM. The obligation is satisfied, so the link may be cleared —
    // leaving it would block the DSAR forever on a record that no longer exists.
    await input.deps.deleteLink(input.linkId);
    await input.deps.writeEraseAudit({ crmRecordId: input.crmRecordId, mode: input.mode });
    return { outcome: "already_absent", linkCleared: true };
  }

  if (result.kind === "rate_limited") {
    return {
      outcome: "rate_limited",
      retryAfterMs: result.retryAfterMs,
      reason: result.daily ? "daily_cap" : "rate_limited",
      linkCleared: false,
    };
  }

  if (result.kind !== "ok") {
    // Every other failure — auth, validation, 5xx — leaves the link in place. A DSAR blocked by a real
    // failure is the correct outcome; a DSAR that completes because an erase quietly failed is not.
    return { outcome: "failed", reason: result.kind, linkCleared: false };
  }

  // Confirmed. Only now is the pointer safe to destroy.
  await input.deps.deleteLink(input.linkId);
  await input.deps.writeEraseAudit({ crmRecordId: input.crmRecordId, mode: input.mode });
  return { outcome: "erased", linkCleared: true };
}

/**
 * The erase mode for a provider + object.
 *
 * HubSpot exposes a real GDPR delete. Salesforce has no equivalent for a Contact with history, so the
 * defensible action is anonymise-and-suppress: the personal data is destroyed while the customer's own
 * activity records stay referentially intact. A Lead, which carries no downstream history, can be hard
 * deleted. Encoded as a function rather than a constant so the reasoning has somewhere to live.
 */
export function eraseModeFor(provider: CrmProvider, objectType: CrmObjectType): CrmEraseMode {
  if (provider === "hubspot") return "gdpr_delete";
  if (objectType === "lead") return "delete";
  return "anonymize";
}
