// auditLog.ts — platform-admin audit-log viewer + export (ADR-0032 / 13 §9, 13a F4 / Area 11). Mounted under
// /api/v1/admin, so the parent router already applied authn + platformAdmin (the `pa` gate). The platform
// audit log is the record of every privileged cross-tenant action; reading it is itself a sensitive compliance
// action, so this surface additionally requires the super_admin OR compliance_officer staff role. Reads run
// through the audited withPlatformTx and are bounded/keyset-paginated (no offset, no unbounded scan). The
// response is the structured envelope only (no `metadata` jsonb). The CSV export is itself audited (audit.export).

import { type PlatformAuditRow, platformAuditReadRepository, withPlatformTx } from "@leadwolf/db";
import { ValidationError, platformAuditQuerySchema } from "@leadwolf/types";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireStaffRole } from "../../middleware/requireStaffRole.ts";

export const auditLogRoutes = new Hono<{ Variables: ApiVariables }>();

// Reading the platform audit log is restricted to the roles accountable for it — super_admin (all caps) and
// the compliance officer (whose job is reviewing this trail). Above the coarse `pa` gate.
auditLogRoutes.use("*", requireStaffRole("super_admin", "compliance_officer"));

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

/** Read the optional filter/paging params off the query string (validated by platformAuditQuerySchema). */
function queryFrom(c: Context<{ Variables: ApiVariables }>) {
  return {
    action: c.req.query("action"),
    tenantId: c.req.query("tenantId"),
    actorUserId: c.req.query("actorUserId"),
    since: c.req.query("since"),
    until: c.req.query("until"),
    cursor: c.req.query("cursor"),
    limit: c.req.query("limit"),
  };
}

/** A keyset page of platform audit entries (newest first), AND-filtered. Reading the log is itself audited. */
auditLogRoutes.get("/", async (c) => {
  const parsed = platformAuditQuerySchema.safeParse(queryFrom(c));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const { rows, nextCursor } = await withPlatformTx(actorOf(c), "admin.read_audit_log", (tx) =>
    platformAuditReadRepository.listPage(tx, parsed.data),
  );
  return c.json({
    entries: rows.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() })),
    nextCursor,
  });
});

/** Export the filtered entries as CSV (bounded by AUDIT_EXPORT_CAP). The export itself writes an audited
 *  "audit.export" platform_audit_log row — exporting the trail is a recorded action (ADR-0032). */
auditLogRoutes.get("/export", async (c) => {
  const parsed = platformAuditQuerySchema.safeParse(queryFrom(c));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const { cursor: _cursor, limit: _limit, ...filters } = parsed.data;
  const rows = await withPlatformTx(
    actorOf(c),
    "audit.export",
    (tx) => platformAuditReadRepository.exportRows(tx, filters),
    { metadata: filters },
  );
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", 'attachment; filename="platform-audit-log.csv"');
  return c.body(toCsv(rows));
});

// ── CSV building ────────────────────────────────────────────────────────────────────────────────────────
const CSV_HEADER = [
  "occurredAt",
  "action",
  "actorUserId",
  "targetType",
  "targetId",
  "tenantId",
  "workspaceId",
  "ip",
] as const;

/** Escape a CSV field: quote when it contains a delimiter/quote/newline, and neutralize a leading formula
 *  character (=,+,-,@) so a spreadsheet can't execute exported audit data (mirrors the import-side guard). */
function csvField(value: string | null): string {
  let s = value ?? "";
  if (s && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: PlatformAuditRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.occurredAt.toISOString(),
        r.action,
        r.actorUserId,
        r.targetType,
        r.targetId,
        r.tenantId,
        r.workspaceId,
        r.ip,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n");
}
