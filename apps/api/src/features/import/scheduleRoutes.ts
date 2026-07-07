// scheduleRoutes.ts — the P5 SCHEDULED-IMPORT CRUD surface (import-and-data-model-redesign 08 §9 · 14 Phase 5).
// A NEW router (kept OUT of routes.ts — the sibling verb surface — so the two slices never collide), mounted at
// /api/v1/imports from the feature index + app wiring, BEFORE importRoutes so `/imports/schedules` is never
// captured as importRoutes' `/:jobId` (the mapping-templates / bulk / artifacts precedent). Five verbs:
//
//   POST   /imports/schedules       create a schedule (multipart: the template FILE + the definition fields)
//   GET    /imports/schedules       list the workspace's schedules (member+ — schedules are workspace config)
//   PATCH  /imports/schedules/:id   update (creator ∪ elevated) — enable clears the failure state
//   DELETE /imports/schedules/:id   delete (creator ∪ elevated) + best-effort remove the stored object
//
// GATE-ON-404 (the S-I8 posture): every verb 404s while the scheduled-imports dual gate is off for the tenant
// (SCHEDULED_IMPORTS_ENABLED env AND the per-tenant `scheduled_imports_enabled` flag — scheduledImportsEnabled-
// ForScope, fail-closed) — the endpoint is invisible until the tenant is enabled, no existence oracle.
//
// SOURCE MODEL (08 §9 v1 = the "re-uploaded template file" branch): create uploads a CSV/XLSX through the SAME
// admission + scan + parse + fast-pair routing pipeline as the one-shot import, stores it as an object, and
// records its key — every fire re-reads that stored object (the leader-locked sweep). An over-fast-pair template
// is REFUSED at create (v1 fires the fast lane only; copy-mode scheduled fires are deferred — doc 16).
//
// VISIBILITY (10 §2 house matrix, applied to workspace CONFIG rather than a PII job): a schedule is workspace
// automation config, so LIST is member+ (everyone who can run imports can see what's scheduled), while MUTATE is
// creator ∪ elevated (only the owner or an admin/owner can change/delete another member's schedule). A member
// who can SEE a schedule in the list but is not its creator gets 403 on mutate (not 404 — it is not hidden from
// them); a foreign/absent id is 404 (RLS + the workspace check). Recorded as the list-visibility drift in doc 16.
//
// AUDIT: the shipped audit-action CHECK (0054/0057) carries NO scheduled-import action, and this slice adds no
// migration — so schedule mutations are LOG-ONLY here (a structured console line), with the audit-CHECK gap
// recorded as a doc-16 drift row (the M1 "extend the CHECK once per phase" precedent — the action lands with the
// P5 audit migration, not fabricated against a CHECK that would reject it at write time).

import { randomUUID } from "node:crypto";
import { env } from "@leadwolf/config";
import {
  assertListInWorkspace,
  computeNextRunAt,
  copySourceExt,
  decideImportRouting,
  parseImportFile,
  scheduledImportsEnabledForScope,
} from "@leadwolf/core";
import {
  type ScheduledImportRow,
  scheduledImportRepository,
  withTenantTx,
} from "@leadwolf/db";
import {
  ForbiddenError,
  type ImportMergeMode,
  ImportValidationError,
  MAX_SCHEDULES_PER_WORKSPACE,
  NotFoundError,
  type ScheduleCadence,
  type ScheduledImport,
  createScheduledImportSchema,
  importMergeMode,
  scheduleCadence,
  sourceName,
  updateScheduledImportSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { rateLimit } from "../../middleware/rateLimit.ts";
import { type RoleVariables, getWorkspaceRole, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";
import { bulkFileStore } from "./bulkStore.ts";
import { requireImportCreateGrant } from "./createGrant.ts";
import { scanImportUpload } from "./malwareScan.ts";
import { admittedImportFormData, readAdmittedImportContent } from "./uploadAdmission.ts";

export const importScheduleRoutes = new Hono<{ Variables: RoleVariables }>();

importScheduleRoutes.use("*", authn);
importScheduleRoutes.use("*", tenancy);
importScheduleRoutes.use("*", rateLimit);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Map the durable row (Dates + jsonb) to the non-PII wire DTO (ISO strings). Never leaks a row value — only
 *  names/keys/counts/timestamps (the scheduledImportSchema shape). */
function toScheduledImportDTO(row: ScheduledImportRow): ScheduledImport {
  return {
    id: row.id,
    name: row.name,
    sourceName: row.sourceName as ScheduledImport["sourceName"],
    sourceObjectKey: row.sourceObjectKey,
    sourceFilename: row.sourceFilename,
    mapping: (row.mapping ?? {}) as ScheduledImport["mapping"],
    mergeMode: (row.mergeMode ?? null) as ScheduledImport["mergeMode"],
    preservePopulated: row.preservePopulated,
    targetListId: row.targetListId,
    cadence: row.cadence as ScheduleCadence,
    enabled: row.enabled,
    disabledReason: (row.disabledReason ?? null) as ScheduledImport["disabledReason"],
    consecutiveFailures: row.consecutiveFailures,
    nextRunAt: row.nextRunAt.toISOString(),
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    lastJobId: row.lastJobId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** True when the caller is the schedule's creator OR an elevated role (owner/admin) — the mutate predicate. */
function canMutate(row: ScheduledImportRow, userId: string, role: string): boolean {
  return row.createdByUserId === userId || role === "owner" || role === "admin";
}

/** Parse an optional boolean form field ("true"/"false"); throws on any other non-null value. */
function optionalBool(form: FormData, key: string): boolean | undefined {
  const v = form.get(key);
  if (v == null) return undefined;
  if (v !== "true" && v !== "false") throw new ImportValidationError(`'${key}' must be 'true' or 'false'.`);
  return v === "true";
}

// ── POST /imports/schedules — create ────────────────────────────────────────────────────────────────────────
// requireImportCreateGrant governs authorization (the SAME G02 grant a one-shot import rides); the schedule's
// creator is the verified token's sub (never the body). Multipart: the template FILE + name/cadence/mapping/…
// The file is admitted + scanned + parsed + fast-pair-routed (v1 fires fast only) BEFORE storage; then the
// per-workspace cap is enforced and the row created with next_run_at one cadence interval out (computeNextRunAt).
importScheduleRoutes.post("/schedules", requireImportCreateGrant(), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before scheduling an import.");
  const tenantId = c.get("tenantId");
  const scope = { tenantId, workspaceId };
  // Gate-on-404: invisible while the tenant is not enabled (no existence oracle).
  if (!(await scheduledImportsEnabledForScope(scope))) throw new NotFoundError("Not found.");
  const userId = c.get("claims").sub;

  // S-S1 admission envelope: byte-count-capped multipart parse + hardening caps.
  const form = await admittedImportFormData(c.req.raw);

  const file = form.get("file");
  if (!(file instanceof File))
    throw new ImportValidationError("A CSV or XLSX template file is required (field 'file').");
  const parsedSource = sourceName.safeParse(form.get("sourceName"));
  if (!parsedSource.success) throw new ImportValidationError("Unknown or missing 'sourceName'.");
  const cadenceParsed = scheduleCadence.safeParse(form.get("cadence"));
  if (!cadenceParsed.success)
    throw new ImportValidationError("'cadence' must be one of: hourly, daily, weekly.");

  let mapping: unknown;
  try {
    mapping = JSON.parse(String(form.get("mapping") ?? ""));
  } catch {
    throw new ImportValidationError("'mapping' must be a JSON object of canonicalField → column header.");
  }

  // Optional strategy pair + list target + parse options (each independently optional; null = inherit policy).
  let mergeMode: ImportMergeMode | undefined;
  const mm = form.get("mergeMode") ?? form.get("merge_mode");
  if (mm != null) {
    const p = importMergeMode.safeParse(mm);
    if (!p.success)
      throw new ImportValidationError(
        "'mergeMode' must be one of: create_and_update, create_only, update_only.",
      );
    mergeMode = p.data;
  }
  const preservePopulated = optionalBool(form, "preservePopulated") ?? optionalBool(form, "preserve_populated");
  const enabled = optionalBool(form, "enabled");
  const rawTarget = form.get("targetListId") ?? form.get("listId");
  const targetListId = rawTarget != null && rawTarget !== "" ? String(rawTarget) : undefined;
  let options: Record<string, unknown> | undefined;
  const rawOptions = form.get("options");
  if (rawOptions != null && rawOptions !== "") {
    try {
      options = JSON.parse(String(rawOptions)) as Record<string, unknown>;
    } catch {
      throw new ImportValidationError("'options' must be a JSON object.");
    }
  }

  // Mint the stored-object key BEFORE validation (ext sanitized via core's ONE copySourceExt — the untrusted
  // filename is never a path). The object is stored only AFTER the row is created (below).
  const sourceObjectKey = `imports/${randomUUID()}/source.${copySourceExt(file.name)}`;

  // Validate the WHOLE definition through the shipped DTO (name length, uuid targetListId, cadence, …) — the
  // minted key + the file's display name ride in so the schema validates exactly what will be stored.
  const parsedBody = createScheduledImportSchema.safeParse({
    name: form.get("name"),
    sourceName: parsedSource.data,
    sourceObjectKey,
    sourceFilename: file.name,
    mapping,
    mergeMode,
    preservePopulated,
    targetListId,
    options,
    cadence: cadenceParsed.data,
    enabled,
  });
  if (!parsedBody.success)
    throw new ImportValidationError(
      parsedBody.error.issues[0]?.message ?? "Invalid scheduled-import definition.",
    );
  const body = parsedBody.data;

  // Optional list target validated against the VERIFIED workspace (never trusted from the client).
  if (body.targetListId) await assertListInWorkspace({ scope, listId: body.targetListId });

  // S-S2 scan BEFORE parse and BEFORE storage (the shipped bulkRoutes order): infected ⇒ refused, nothing stored.
  const avScan = await scanImportUpload(file);
  if (avScan === "infected")
    throw new ImportValidationError("The uploaded file did not pass the malware scan.");

  // Parse verdict + fast-pair routing refusal: readAdmittedImportContent applies the per-format admission caps;
  // decideImportRouting(copyEngaged:false) THROWS the honest over-threshold refusal — a scheduled template must
  // be fast-lane fireable in v1 (copy-mode scheduled fires are deferred).
  const parsed = parseImportFile(await readAdmittedImportContent(file), file.name);
  decideImportRouting({
    fileName: file.name,
    byteSize: file.size,
    rowCount: parsed.rows.length,
    rowCeiling: env.BULK_IMPORT_THRESHOLD_ROWS,
    copyEngaged: false,
  });

  const now = new Date();
  const nextRunAt = computeNextRunAt(now, body.cadence, now); // first run one cadence interval out

  const created = await withTenantTx(scope, async (tx) => {
    // Per-workspace cap (13 §7 abuse posture): bound automation fan-out. Soft (±1 under a concurrent create).
    const count = await scheduledImportRepository.countInWorkspace(tx, workspaceId);
    if (count >= MAX_SCHEDULES_PER_WORKSPACE)
      throw new ImportValidationError(
        `This workspace has reached its limit of ${MAX_SCHEDULES_PER_WORKSPACE} scheduled imports.`,
      );
    try {
      return await scheduledImportRepository.create(tx, {
        tenantId,
        workspaceId,
        createdByUserId: userId,
        name: body.name,
        sourceName: body.sourceName,
        sourceObjectKey,
        sourceFilename: body.sourceFilename ?? file.name,
        mapping: body.mapping,
        mergeMode: body.mergeMode ?? null,
        preservePopulated: body.preservePopulated ?? null,
        targetListId: body.targetListId ?? null,
        options: body.options,
        cadence: body.cadence,
        enabled: body.enabled ?? true,
        nextRunAt,
      });
    } catch (err) {
      // The (workspace_id, lower(name)) unique surfaces a duplicate name as a DB error ⇒ 422 (create is not
      // an upsert — a re-create under a taken name must fail, not clobber the existing schedule).
      if (err instanceof Error && /unique|duplicate/i.test(err.message))
        throw new ImportValidationError("A scheduled import with that name already exists.");
      throw err;
    }
  });

  // Store the template object AFTER the row exists (constant memory). next_run_at is one interval out, so the
  // sweep cannot fire before this completes. On storage failure, delete the row best-effort and surface it.
  try {
    await bulkFileStore().putObject(sourceObjectKey, file.stream());
  } catch (err) {
    await withTenantTx(scope, (tx) => scheduledImportRepository.delete(tx, created.id)).catch(
      () => undefined,
    );
    throw err;
  }

  console.info("scheduled-import created", {
    scheduleId: created.id,
    workspaceId,
    actorUserId: userId,
    cadence: created.cadence,
  }); // log-only audit — no scheduled-import action in the audit CHECK yet (doc-16 drift)
  return c.json(toScheduledImportDTO(created), 201);
});

// ── GET /imports/schedules — list (member+) ───────────────────────────────────────────────────────────────
importScheduleRoutes.get("/schedules", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to continue.");
  const tenantId = c.get("tenantId");
  const scope = { tenantId, workspaceId };
  if (!(await scheduledImportsEnabledForScope(scope))) throw new NotFoundError("Not found.");

  const rows = await withTenantTx(scope, (tx) =>
    scheduledImportRepository.listInWorkspace(tx, workspaceId),
  );
  return c.json({ schedules: rows.map(toScheduledImportDTO) }, 200);
});

// ── PATCH /imports/schedules/:id — update (creator ∪ elevated) ────────────────────────────────────────────
// Enabling a disabled schedule clears its failure state (disabled_reason:null + consecutiveFailures:0 — a fresh
// start, 08 §9). A cadence change recomputes next_run_at from now (the new interval anchors on this edit).
importScheduleRoutes.patch("/schedules/:id", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to continue.");
  const tenantId = c.get("tenantId");
  const scope = { tenantId, workspaceId };
  const id = c.req.param("id");
  if (!UUID_RE.test(id) || !(await scheduledImportsEnabledForScope(scope)))
    throw new NotFoundError("Scheduled import not found.");
  const userId = c.get("claims").sub;
  const role = getWorkspaceRole(c);

  const parsed = updateScheduledImportSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    throw new ImportValidationError(parsed.error.issues[0]?.message ?? "Invalid update.");
  const patch = parsed.data;

  const updated = await withTenantTx(scope, async (tx) => {
    const row = await scheduledImportRepository.getByIdForUpdate(tx, id);
    if (!row || row.workspaceId !== workspaceId) return { kind: "not_found" as const };
    if (!canMutate(row, userId, role)) return { kind: "forbidden" as const };

    // Enabling clears the failure state; a cadence change re-anchors next_run_at on the new interval from now.
    const enableClears =
      patch.enabled === true
        ? { enabled: true, disabledReason: null as string | null, consecutiveFailures: 0 }
        : {};
    const cadenceReanchor =
      patch.cadence !== undefined
        ? { nextRunAt: computeNextRunAt(new Date(), patch.cadence, new Date()) }
        : {};
    const next = await scheduledImportRepository.update(tx, id, {
      name: patch.name,
      mapping: patch.mapping,
      mergeMode: patch.mergeMode,
      preservePopulated: patch.preservePopulated,
      targetListId: patch.targetListId,
      options: patch.options,
      cadence: patch.cadence,
      enabled: patch.enabled,
      ...enableClears,
      ...cadenceReanchor,
    });
    return next ? { kind: "ok" as const, row: next } : { kind: "not_found" as const };
  });

  if (updated.kind === "not_found") throw new NotFoundError("Scheduled import not found.");
  if (updated.kind === "forbidden")
    throw new ForbiddenError(
      "insufficient_role",
      "Only the schedule's creator or an admin can change it.",
    );
  console.info("scheduled-import updated", { scheduleId: id, workspaceId, actorUserId: userId });
  return c.json(toScheduledImportDTO(updated.row), 200);
});

// ── DELETE /imports/schedules/:id — delete (creator ∪ elevated) + best-effort object cleanup ──────────────
importScheduleRoutes.delete("/schedules/:id", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to continue.");
  const tenantId = c.get("tenantId");
  const scope = { tenantId, workspaceId };
  const id = c.req.param("id");
  if (!UUID_RE.test(id) || !(await scheduledImportsEnabledForScope(scope)))
    throw new NotFoundError("Scheduled import not found.");
  const userId = c.get("claims").sub;
  const role = getWorkspaceRole(c);

  const result = await withTenantTx(scope, async (tx) => {
    const row = await scheduledImportRepository.getByIdForUpdate(tx, id);
    if (!row || row.workspaceId !== workspaceId) return { kind: "not_found" as const };
    if (!canMutate(row, userId, role)) return { kind: "forbidden" as const };
    await scheduledImportRepository.delete(tx, id);
    return { kind: "ok" as const, objectKey: row.sourceObjectKey };
  });

  if (result.kind === "not_found") throw new NotFoundError("Scheduled import not found.");
  if (result.kind === "forbidden")
    throw new ForbiddenError(
      "insufficient_role",
      "Only the schedule's creator or an admin can delete it.",
    );

  // Delete the stored object AFTER the row delete (best-effort; idempotent — a failure leaves a bounded orphan
  // the object-store lifecycle bounds, never a live schedule's data since the row is already gone).
  await bulkFileStore()
    .deleteObject(result.objectKey)
    .catch(() => undefined);
  console.info("scheduled-import deleted", { scheduleId: id, workspaceId, actorUserId: userId });
  return c.body(null, 204);
});
