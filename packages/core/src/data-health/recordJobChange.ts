// recordJobChange.ts — the PRODUCER that turns a job-change verdict into a recorded signal and an alert
// (06-roadmap Phase 4; outcomes S-09, S-13 "minimize the time between a saved contact changing jobs and the
// seller learning about it").
//
// detectJobChange decides; this persists. Kept apart because the decision is the part that must be right and
// is worth testing in isolation — a producer wired to a bad rule just generates confident noise at scale.
//
// TWO OUTPUTS, different audiences:
//   intent_signals — the durable, per-contact record. Feeds scoring and the Data Health surfaces, and exists
//                    whether or not anyone happens to be watching this contact.
//   notifications  — the human nudge, ONLY to users who saved the contact (S-13 "alerts on saved lists").
// The signal is written even when nobody is watching: the fact is true regardless of the audience, and a
// contact nobody has saved today may be saved tomorrow by someone who then wants the history.

import {
  type TenantScope,
  type Tx,
  intentSignalRepository,
  listRepository,
  notificationRepository,
} from "@leadwolf/db";
import { type JobChangeVerdict, shouldAlert } from "./jobChange.ts";

export interface RecordJobChangeInput {
  scope: TenantScope & { workspaceId: string };
  contactId: string;
  /** Display name for the alert copy. NEVER an email or phone — a notification is not a reveal. */
  contactLabel: string;
  /** Where they went, when known. Absent for a departure with no destination. */
  newCompanyName?: string | null;
  verdict: JobChangeVerdict;
}

export interface RecordJobChangeResult {
  signalRecorded: boolean;
  notified: number;
}

/**
 * Signal weight from confidence, on the 1–10 scale intent_signals enforces.
 *
 * A job change we are 55% sure of and one we are 99% sure of should not push a score identically — the weight
 * IS how downstream scoring learns to discount a shaky detection rather than treating every signal as fact.
 */
export function signalWeight(confidence: number): number {
  return Math.max(1, Math.min(10, Math.round(confidence * 10)));
}

/** Alert copy. Deliberately plain, and PII-free beyond the name the user already has. */
export function alertTitle(verdict: JobChangeVerdict, label: string, company?: string | null): string {
  if (verdict.kind === "departed") return `${label} has left their company`;
  return company ? `${label} moved to ${company}` : `${label} changed companies`;
}

/**
 * Persist a verdict. Runs INSIDE the caller's transaction so the signal and its alerts commit together — a
 * notification for a signal that rolled back would point at a change no record supports.
 *
 * Does nothing when the verdict is not a change: `detectJobChange` already applied the confidence margin, and
 * re-deciding here would fork the rule into two places that can disagree.
 */
export async function recordJobChange(
  tx: Tx,
  input: RecordJobChangeInput,
): Promise<RecordJobChangeResult> {
  const { verdict } = input;
  if (!verdict.changed || !verdict.kind) return { signalRecorded: false, notified: 0 };

  await intentSignalRepository.insert(tx, {
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
    contactId: input.contactId,
    signalType: "job_change",
    signalSource: "graph",
    detail: verdict.kind,
    weight: signalWeight(verdict.confidence),
  });

  // A title change is recorded but never alerted — see jobChange.shouldAlert for why.
  if (!shouldAlert(verdict)) return { signalRecorded: true, notified: 0 };

  const watchers = await listRepository.savedContactWatchers(tx, input.contactId);
  const title = alertTitle(verdict, input.contactLabel, input.newCompanyName);
  let notified = 0;
  for (const userId of watchers) {
    // Dedup per (user, contact): a contact re-detected on the next sweep must not notify twice. Keyed on the
    // ENTITY rather than the type alone, so an alert about a different contact still gets through — the
    // opposite mistake would silently suppress every job change after the first.
    const already = await notificationRepository.existsForEntity(
      tx,
      input.scope.workspaceId,
      userId,
      "job_change",
      "contact",
      input.contactId,
    );
    if (already) continue;
    await notificationRepository.create(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      userId,
      type: "job_change",
      title,
      body: verdict.kind === "departed" ? "Verify before your next outreach." : null,
      entityType: "contact",
      entityId: input.contactId,
    });
    notified += 1;
  }
  return { signalRecorded: true, notified };
}
