// captureLink.ts — assisted (HITL) capture of one Sales Navigator link (05 §5, M7, ADR-0009). A human pastes
// the URL; we NEVER fetch or automate against LinkedIn. This orchestrates the one write: parse a dedup id +
// best-guess type from the URL, optionally validate a contact pin, then dedup-insert in a single withTenantTx.
// Dedup is on (workspace_id, url) and, when parseable, (workspace_id, sales_nav_lead_id) — re-pastes collapse.

import {
  type TenantScope,
  revealRepository,
  salesNavLinkRepository,
  withTenantTx,
} from "@leadwolf/db";
import { NotFoundError, type SalesNavLinkType } from "@leadwolf/types";
import { parseSalesNavLink } from "./parseLink.ts";

export interface CaptureLinkInput {
  scope: TenantScope & { workspaceId: string };
  linkType: SalesNavLinkType;
  url: string;
  /** A sales_nav_lead_id the human already knows; the URL is parsed for one when this is omitted. */
  externalId?: string;
  note?: string;
  labels?: string[];
  /** Optional contact to pin the link to — validated to exist in the scoped workspace before insert. */
  contactId?: string;
  capturedByUserId?: string;
}

export interface CaptureLinkResult {
  id: string;
  /** True when an identical (workspace_id, url) / (workspace_id, sales_nav_lead_id) link already existed. */
  deduped: boolean;
}

/**
 * Capture (or re-capture) a Sales Nav link. Returns the surviving link id and whether it was a dedup hit.
 * Workspace-scoped via RLS; the contact-pin check, parse, and insert all run in the SAME transaction.
 */
export async function captureSalesNavLink(input: CaptureLinkInput): Promise<CaptureLinkResult> {
  const parsed = parseSalesNavLink(input.url);
  // The human-supplied external id is preserved VERBATIM in external_id (a display/reference value, not a
  // dedup key). Defense-in-depth: a blank/whitespace value is treated as absent even though the api also
  // strips it, so an empty string never reaches the columns.
  const externalId = input.externalId?.trim() || null;
  // The dedup facet (workspace_id, sales_nav_lead_id): prefer an explicit human-supplied id (when present),
  // else the one parsed from the URL. NEVER an empty string — that would falsely collapse unrelated links.
  const salesNavLeadId = externalId ?? parsed.salesNavLeadId;

  return withTenantTx(input.scope, async (tx) => {
    if (input.contactId) {
      // RLS scopes the lookup; a tombstoned (DSAR-deleted) contact reads as absent, so we never pin to one.
      const contact = await revealRepository.getContactForReveal(tx, input.contactId);
      if (!contact) throw new NotFoundError("Contact not found in this workspace.");
    }
    return salesNavLinkRepository.insertDedup(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      linkType: input.linkType,
      url: input.url,
      externalId,
      salesNavLeadId,
      note: input.note ?? null,
      labels: input.labels ?? null,
      contactId: input.contactId ?? null,
      createdByUserId: input.capturedByUserId ?? null,
    });
  });
}
