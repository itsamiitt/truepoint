// adminUpload.ts — the `admin_upload` ingestion connector (prospect-database-platform Phase 03 / I2). Adapts an
// admin/bulk upload envelope onto the unified ingestion contract: a server-side source (workspace-scoped, no
// consent context), whose records are already the raw observations the shared pipeline maps. ADDITIVE — it does
// NOT change the shipped /import path or runImport; it is the first connector on the new /ingest entry.
import { ValidationError } from "@leadwolf/types";
import type { IngestionEnvelope, RawObservation } from "@leadwolf/types";
import type { Connector } from "../registry.ts";

export const adminUploadConnector: Connector = {
  id: "admin_upload",
  validateEnvelope(envelope: IngestionEnvelope): void {
    // admin_upload is a server-side, workspace-scoped source — a workspace scope is required; a consent context is
    // not expected (the customer's own upload of their own data; residency/basis handled at the workspace level).
    if (!envelope.scope.workspaceId) {
      throw new ValidationError("admin_upload requires a workspace scope.");
    }
  },
  toRawObservations(envelope: IngestionEnvelope): RawObservation[] {
    // Verbatim: the upload's records already ARE the raw observations; canonical-field mapping is the shared
    // pipeline's job (Phase 04), so a bad mapping never lives in a connector.
    return envelope.records;
  },
};
