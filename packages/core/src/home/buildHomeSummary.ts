// buildHomeSummary.ts — compose the Home dashboard DTO (07 §2) from the workspace-scoped repository reads,
// in ONE fan-out (Promise.all). Pure domain logic: no HTTP. PII never enters this shape — hotLeads carry
// facets only and the activity feed carries minimized audit columns only (the repos already enforce that).
// `sent` is derived here from the activity email_sent bucket, since it lives in the activity domain.

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
} from "@leadwolf/db";
import type { HomeSummary, RevealType } from "@leadwolf/types";

export interface BuildHomeSummaryInput {
  scope: { tenantId: string; workspaceId: string };
}

export async function buildHomeSummary({ scope }: BuildHomeSummaryInput): Promise<HomeSummary> {
  const tenantScope: TenantScope = scope;
  const [
    creditBalance,
    burn,
    recentReveals,
    hotLeads,
    recentImports,
    enrichmentActivity,
    performance,
    activityCounts,
    activityFeed,
  ] = await Promise.all([
    creditRepository.getBalance(tenantScope),
    creditRepository.burnByDay(tenantScope),
    revealRepository.listByWorkspace(tenantScope, 10),
    contactRepository.topByPriority(tenantScope, 5),
    sourceImportRepository.recentBatches(tenantScope, 5),
    providerCallRepository.recentActivity(tenantScope, 5),
    sequenceRepository.performanceSnapshot(tenantScope),
    activityRepository.countByTypeForWorkspace(tenantScope, 30),
    auditRepository.listByWorkspace(tenantScope, 15),
  ]);

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
