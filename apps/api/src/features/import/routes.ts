// routes.ts — HTTP wiring for the import feature (05 §3). POST accepts a multipart upload (the CSV file +
// a JSON column mapping + the source), parses it on the request thread, then ENQUEUES the parsed rows onto
// the `imports` queue and returns 202 + a job ref — the heavy per-row dedup/encrypt/DB work runs in the
// apps/workers consumer (processImport → the SAME packages/core runImport). This file does only transport
// (parse the request, enqueue, shape the response) and no business logic. The workspace is taken from the
// VERIFIED token via the tenancy middleware, never the request body (16 §7).

import { parseImportFile } from "@leadwolf/core";
import {
  ForbiddenError,
  type ImportJobRef,
  ImportValidationError,
  columnMappingSchema,
  sourceName,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";
import { enqueueImport } from "./queue.ts";

export const importRoutes = new Hono<{ Variables: TenancyVariables }>();

importRoutes.use("*", authn);
importRoutes.use("*", tenancy);

importRoutes.post("/", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before importing.");
  const tenantId = c.get("tenantId");
  const claims = c.get("claims");

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File))
    throw new ImportValidationError("A CSV file is required (field 'file').");

  const parsedSource = sourceName.safeParse(form.get("sourceName"));
  if (!parsedSource.success) throw new ImportValidationError("Unknown or missing 'sourceName'.");

  let mapping: unknown;
  try {
    mapping = JSON.parse(String(form.get("mapping") ?? ""));
  } catch {
    throw new ImportValidationError(
      "'mapping' must be a JSON object of canonicalField → column header.",
    );
  }
  const parsedMapping = columnMappingSchema.safeParse(mapping);
  if (!parsedMapping.success) throw new ImportValidationError("Invalid column mapping.");

  const parsed = parseImportFile(await file.text(), file.name);
  const jobId = await enqueueImport({
    scope: { tenantId, workspaceId },
    importedByUserId: claims.sub,
    sourceName: parsedSource.data,
    sourceFile: file.name,
    mapping: parsedMapping.data,
    rows: parsed.rows,
  });
  const body: ImportJobRef = { jobId, status: "queued" };
  return c.json(body, 202);
});
