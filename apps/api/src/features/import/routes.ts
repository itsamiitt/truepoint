// routes.ts — HTTP wiring for the import feature (05 §3). POST accepts a multipart upload (the CSV file +
// a JSON column mapping + the source), then hands off to packages/core's runImport — this file does the
// transport (parse the request, shape the response) and no business logic. The workspace is taken from the
// VERIFIED token via the tenancy middleware, never the request body (16 §7). M1 runs the import inline and
// returns the new-vs-matched summary; large files can later be diverted to the imports worker (same core fn).

import { parseImportFile, runImport } from "@leadwolf/core";
import {
  ForbiddenError,
  ImportValidationError,
  columnMappingSchema,
  sourceName,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

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
  const summary = await runImport({
    scope: { tenantId, workspaceId },
    importedByUserId: claims.sub,
    sourceName: parsedSource.data,
    sourceFile: file.name,
    mapping: parsedMapping.data,
    rows: parsed.rows,
  });
  return c.json(summary, 200);
});
