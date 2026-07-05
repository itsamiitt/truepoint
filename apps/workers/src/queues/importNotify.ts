// importNotify.ts — the S-Q4 `import.notify` outbox CONSUMER (import-and-data-model-redesign 09 §6.3, G06). On a
// terminal import intent (written in the terminal tx by runFastImport — S-Q3/S-Q4 producer), it inserts the
// importer's in-app notification IDEMPOTENTLY (dedup by (import_job, jobId): a redelivered intent finds the
// existing row and no-ops ⇒ at-least-once delivery, exactly-once EFFECT), hands off to the email seam, and
// records delivery lag. The publisher is registered on the SHIPPED leaderless outbox relay in register.ts; the
// effect lives here so the composition root stays thin. Posture (09 §6.3): at-least-once delivery, exactly-once
// effect, eventual by up to relay lag (observed via outboxOldestPendingSeconds + the lag metric below).

import { importJobRepository, notificationRepository, withTenantTx } from "@leadwolf/db";
import type { ImportNotifyPayload } from "@leadwolf/types";
import { log } from "../logger.ts";

/**
 * The email seam (09 §6.3): a terminal import MAY email the importer when they opt in. Interface ONLY here — the
 * per-user preference surface is doc 11 and the provider wiring is doc 14. The shipped adapter is a no-op.
 */
export interface ImportEmailNotifier {
  notifyTerminal(input: {
    scope: { tenantId: string; workspaceId: string };
    userId: string;
    jobId: string;
    terminalStatus: string;
    sourceName: string;
  }): Promise<void>;
}

/**
 * The shipped no-op email adapter. WIRE: route to the outreach/email send seam (registerEmailProviders) gated on
 * the per-user notification preference, once doc 11 (preferences) + doc 14 (provider) land. Today in-app is the
 * only delivered channel; the intent's in-app insert already happened before this is called.
 */
export const nullImportEmailNotifier: ImportEmailNotifier = {
  async notifyTerminal() {
    /* no-op until email preferences + provider wiring (doc 11 / doc 14) */
  },
};

// ── Delivery-lag metric (09 §8; zero-dep, mirrors metrics.ts) — terminal-commit → in-app-insert latency. Kept
// here so this consumer owns its own signal; the S-Q7 /metrics renderer (sibling) surfaces the snapshot. Counters
// are per-process (Prometheus counter semantics — collectors rate() over restarts). PII rule: no payload values.
let notifyDeliveredTotal = 0;
let notifyDedupedTotal = 0;
let notifyLagSecondsMax = 0;
let notifyLagSecondsLast = 0;

/** Snapshot for the S-Q7 /metrics renderer + tests: delivered/deduped counts + last/max terminal→insert lag. */
export function importNotifyMetricsSnapshot(): {
  delivered: number;
  deduped: number;
  lagSecondsMax: number;
  lagSecondsLast: number;
} {
  return {
    delivered: notifyDeliveredTotal,
    deduped: notifyDedupedTotal,
    lagSecondsMax: notifyLagSecondsMax,
    lagSecondsLast: notifyLagSecondsLast,
  };
}

/** Test seam — counters are module-global, so tests reset between cases. */
export function resetImportNotifyMetrics(): void {
  notifyDeliveredTotal = 0;
  notifyDedupedTotal = 0;
  notifyLagSecondsMax = 0;
  notifyLagSecondsLast = 0;
}

/** Per-terminal in-app copy (doc 11 owns the final wording; this is the durable contract). Non-PII. */
const TERMINAL_COPY: Record<string, { title: string; body: (src: string) => string }> = {
  completed: {
    title: "Import finished",
    body: (s) => `Your ${s} import is ready — contacts are in your workspace.`,
  },
  partial: {
    title: "Import finished — some rows need attention",
    body: (s) => `Your ${s} import finished; download the error report to fix the rejected rows.`,
  },
  failed: {
    title: "Import failed",
    body: (s) => `Your ${s} import could not be completed. Open the import for details.`,
  },
  cancelled: {
    title: "Import cancelled",
    body: (s) => `Your ${s} import was cancelled — rows already imported were kept.`,
  },
};

/**
 * Deliver one terminal import notification. Idempotent by (import_job, jobId) — a redelivered intent (outbox
 * at-least-once) finds the existing row and NO-OPs (exactly-once effect; a job has exactly one terminal state, so
 * jobId is the jobId+status key). Runs under withTenantTx so the workspace GUC is set for the notifications RLS
 * WITH CHECK. A system/automation job (no creator) is skipped. A throw leaves the outbox row pending for a later
 * re-claim (the relay contract); the dedup guarantees the insert never double-fires across re-claims.
 */
export async function deliverImportNotification(
  payload: ImportNotifyPayload,
  email: ImportEmailNotifier = nullImportEmailNotifier,
): Promise<void> {
  const inserted = await withTenantTx(payload.scope, async (tx) => {
    const job = await importJobRepository.getJobSystem(tx, payload.jobId);
    if (!job || !job.createdByUserId) return null; // system/automation job, or gone — nobody to notify
    const already = await notificationRepository.existsForEntity(
      tx,
      job.workspaceId,
      job.createdByUserId,
      "import_complete",
      "import_job",
      payload.jobId,
    );
    if (already) return null; // redelivery — exactly-once effect
    const copy = TERMINAL_COPY[payload.terminalStatus] ?? TERMINAL_COPY.completed!;
    await notificationRepository.create(tx, {
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
      userId: job.createdByUserId,
      type: "import_complete",
      title: copy.title,
      body: copy.body(String(job.sourceName)),
      entityType: "import_job",
      entityId: payload.jobId,
    });
    return {
      userId: job.createdByUserId,
      sourceName: String(job.sourceName),
      completedAt: job.completedAt,
    };
  });
  if (!inserted) {
    notifyDedupedTotal += 1;
    return;
  }
  // Delivery-lag metric (09 §8): terminal-commit → in-app-insert latency (the notify SLO signal).
  const lagSeconds = inserted.completedAt
    ? Math.max(0, (Date.now() - inserted.completedAt.getTime()) / 1000)
    : 0;
  notifyDeliveredTotal += 1;
  notifyLagSecondsLast = lagSeconds;
  if (lagSeconds > notifyLagSecondsMax) notifyLagSecondsMax = lagSeconds;
  log.info("import notify delivered", {
    jobId: payload.jobId,
    terminalStatus: payload.terminalStatus,
    lagSeconds: Math.round(lagSeconds),
  });
  // Email seam (opt-in; no-op adapter until doc 11/14). Best-effort relative to the in-app insert (already
  // committed): a throw here re-claims the intent, whose insert then dedupes — so email is at-least-once too.
  await email.notifyTerminal({
    scope: payload.scope,
    userId: inserted.userId,
    jobId: payload.jobId,
    terminalStatus: payload.terminalStatus,
    sourceName: inserted.sourceName,
  });
}
