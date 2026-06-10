// writeAudit.ts — the one audit writer (08 §5, 14 §2): called INSIDE the same transaction as the mutation
// it records, so an action and its audit row commit or roll back together. The action vocabulary is the
// closed enum in @leadwolf/types; the table is append-only at the DB layer.

import { type AuditEntryInput, type Tx, auditRepository } from "@leadwolf/db";

export type { AuditEntryInput };

export async function writeAudit(tx: Tx, entry: AuditEntryInput): Promise<void> {
  await auditRepository.insert(tx, entry);
}
