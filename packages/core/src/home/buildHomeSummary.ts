// buildHomeSummary.ts — compose the Home dashboard DTO (07 §2) from the workspace-scoped repository reads,
// in ONE shared withTenantTx. Pure domain logic: no HTTP. PII never enters this shape — hotLeads carry
// facets only and the activity feed carries minimized audit columns only (the repos already enforce that).
// `sent` is derived here from the activity email_sent bucket, since it lives in the activity domain.
//
// Performance (audit root cause #3/#7): every read here is a TENANT-scoped repository read, and each one used
// to open its OWN withTenantTx (BEGIN → SET LOCAL ROLE leadwolf_app → 1-2 set_config GUCs → query → COMMIT).
// Nine of them in parallel pinned up to 9-10 pool connections on the FIRST authenticated page and paid the
// role+GUC setup ~9×. We now open ONE withTenantTx and pass that single scoped `tx` into all nine reads, so the
// whole summary runs in one transaction with one role+GUC setup on one connection. Isolation is unchanged: the
// reads still run as the non-BYPASSRLS leadwolf_app role with app.current_tenant_id / app.current_workspace_id
// set LOCAL from the SESSION-derived scope — RLS enforces tenant+workspace isolation exactly as before. The
// reads run sequentially because postgres.js serializes queries on a single reserved-transaction connection;
// they share one connection now, so this is the same total work without the per-read GUC overhead.

import {
  type TenantScope,
  activityRepository,
  auditRepository,
  contactRepository,
  creditRepository,
  providerCallRepository,
  revealRepository,
  sequenceRepository,
  sourceImportRepository,
  withTenantTx,
} from "@leadwolf/db";
import type { HomeSummary, JobViewer, RevealType } from "@leadwolf/types";

export interface BuildHomeSummaryInput {
  scope: { tenantId: string; workspaceId: string };
  /** WHO is looking (import-redesign 10 §5 row 9): REQUIRED — recentBatches narrows the Recent Imports card
   *  to the viewer's own batches for members when the dual gate is on (elevated roles keep the workspace
   *  view; gate off ⇒ workspace-wide, byte-identical). Built by the route from middleware outputs only. */
  viewer: JobViewer;
}

export async function buildHomeSummary({ scope, viewer }: BuildHomeSummaryInput): Promise<HomeSummary> {
  const tenantScope: TenantScope = scope;
  const {
    creditBalance,
    burn,
    recentReveals,
    hotLeads,
    recentImports,
    enrichmentActivity,
    performance,
    activityCounts,
    activityFeed,
  } = await withTenantTx(tenantScope, async (tx) => ({
    creditBalance: await creditRepository.getBalance(tenantScope, tx),
    burn: await creditRepository.burnByDay(tenantScope, 30, tx),
    recentReveals: await revealRepository.listByWorkspace(tenantScope, 10, tx),
    hotLeads: await contactRepository.topByPriority(tenantScope, 5, tx),
    recentImports: await sourceImportRepository.recentBatches(tenantScope, viewer, 5, tx),
    enrichmentActivity: await providerCallRepository.recentActivity(tenantScope, 5, tx),
    performance: await sequenceRepository.performanceSnapshot(tenantScope, tx),
    activityCounts: await activityRepository.countByTypeForWorkspace(tenantScope, 30, tx),
    activityFeed: await auditRepository.listByWorkspace(tenantScope, 15, tx),
  }));

  return {
    creditBalance,
    burn: burn.map((b) => ({ day: b.day, credits: b.credits })),
    recentReveals: recentReveals.map((r) => ({
      id: r.id,
      contactId: r.contactId,
      revealType: r.revealType as RevealType,
      creditsConsumed: r.creditsConsumed,
      revealedAt: r.revealedAt.toISOString(),
    })),
    hotLeads: hotLeads.map((h) => ({
      id: h.id,
      firstName: h.firstName,
      lastName: h.lastName,
      jobTitle: h.jobTitle,
      emailDomain: h.emailDomain,
      priorityScore: h.priorityScore,
      outreachStatus: h.outreachStatus,
      isRevealed: h.isRevealed,
    })),
    recentImports: recentImports.map((i) => ({
      sourceName: i.sourceName,
      sourceFile: i.sourceFile,
      contactCount: i.contactCount,
      importedAt: i.importedAt.toISOString(),
    })),
    enrichmentActivity: enrichmentActivity.map((e) => ({
      providerName: e.providerName,
      status: e.status,
      cacheHit: e.cacheHit,
      calledAt: e.calledAt.toISOString(),
    })),
    sequenceSnapshot: {
      activeSequences: performance.activeSequences,
      enrolled: performance.enrolled,
      sent: activityCounts.email_sent ?? 0,
      replied: performance.replied,
    },
    activityFeed: activityFeed.map((a) => ({
      id: a.id,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      actorUserId: a.actorUserId,
      occurredAt: a.occurredAt.toISOString(),
    })),
    // Empty-state-first (T3): the DTO + cards ship now; population lands with the tasks/replies sources.
    // Returned [] so the Home cards render calm empty states without a backing source yet.
    todaysTasks: [],
    recentReplies: [],
  };
}
