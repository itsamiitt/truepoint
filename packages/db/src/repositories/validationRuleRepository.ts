// validationRuleRepository.ts — read the GLOBAL data-quality validation rules for the IMPORT pipeline
// (database-management-research 06). The table is platform-managed and app-readable (rls/validationRules.sql:
// SELECT-only for leadwolf_app, no write policy), so this read runs on ANY path — here, inside the import's
// withTenantTx. Writes are platform-only (the admin rule-builder via withPlatformTx); this is purely the
// enforcement read. checkType/config stay loose (text / jsonb) — the @leadwolf/core engine validates them
// defensively, so a row authored against a newer check type never throws here.
import { eq } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { validationRules } from "../schema/validationRules.ts";

/** One enabled custom rule, in the minimal shape the @leadwolf/core validation engine needs. */
export interface ImportValidationRule {
  id: string;
  name: string;
  field: string;
  checkType: string;
  config: unknown;
}

export const validationRuleRepository = {
  /** Every ENABLED custom validation rule (the import enforces these reject-on-fail). Read-only; any tx. */
  async listEnabledForImport(tx: Tx): Promise<ImportValidationRule[]> {
    return tx
      .select({
        id: validationRules.id,
        name: validationRules.name,
        field: validationRules.field,
        checkType: validationRules.checkType,
        config: validationRules.config,
      })
      .from(validationRules)
      .where(eq(validationRules.enabled, true));
  },
};
