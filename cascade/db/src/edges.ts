// Edge lifecycle (06 §6): upsert-not-duplicate, attest every sighting,
// recompute fused confidence, close-don't-delete, re-open after closure.

import type { DbClient } from "./client";
import { fuseConfidence } from "./fusion";
import { edgeTableFor, newId } from "./ulid";

export interface AttestationInput {
  sourceId: string;
  sourceClass: "licensed_provider" | "web_public" | "registry" | "self_declared";
  confidence: number;
  rawAssertion?: string;
  seenAt: Date;
  licenseClass: string;
}

const EDGE_PK: Record<string, string> = {
  person_positions: "position_id",
  person_educations: "education_id",
  org_technology_relations: "rel_id",
  technology_vendors: "link_id",
  company_edges: "edge_id",
};

export async function attest(db: DbClient, edgeId: string, att: AttestationInput): Promise<number> {
  const table = edgeTableFor(edgeId);
  if (!table) throw new Error(`unroutable edge id: ${edgeId}`);
  await db.query(
    `INSERT INTO relationship_attestations
       (attestation_id, edge_table, edge_id, source_id, source_class, confidence, raw_assertion, seen_at, license_class)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      newId("att"),
      table,
      edgeId,
      att.sourceId,
      att.sourceClass,
      att.confidence,
      att.rawAssertion ?? null,
      att.seenAt,
      att.licenseClass,
    ],
  );
  return recomputeConfidence(db, table, edgeId);
}

export async function recomputeConfidence(
  db: DbClient,
  table: string,
  edgeId: string,
): Promise<number> {
  const sightings = await db.query<{ source_id: string; confidence: string }>(
    "SELECT source_id, confidence FROM relationship_attestations WHERE edge_table = $1 AND edge_id = $2",
    [table, edgeId],
  );
  const fused = fuseConfidence(
    sightings.map((s) => ({ sourceId: s.source_id, confidence: Number(s.confidence) })),
  );
  const pk = EDGE_PK[table];
  if (!pk) throw new Error(`unknown edge table: ${table}`);
  await db.query(`UPDATE ${table} SET confidence = $1 WHERE ${pk} = $2`, [fused, edgeId]);
  return fused;
}

export interface EvidenceRow {
  source_id: string;
  source_class: string;
  confidence: string;
  raw_assertion: string | null;
  seen_at: string;
}

export async function evidenceFor(
  db: DbClient,
  edgeId: string,
): Promise<{ edgeTable: string; attestations: EvidenceRow[]; fused: number | null }> {
  const table = edgeTableFor(edgeId);
  if (!table) throw new Error(`unroutable edge id: ${edgeId}`);
  const attestations = await db.query<EvidenceRow>(
    `SELECT source_id, source_class, confidence, raw_assertion, seen_at
     FROM relationship_attestations WHERE edge_table = $1 AND edge_id = $2 ORDER BY seen_at DESC`,
    [table, edgeId],
  );
  const pk = EDGE_PK[table];
  const rows = await db.query<{ confidence: string }>(
    `SELECT confidence FROM ${table} WHERE ${pk} = $1`,
    [edgeId],
  );
  const first = rows[0];
  return { edgeTable: table, attestations, fused: first ? Number(first.confidence) : null };
}

/** Close an open edge (fact ended). Never deletes. */
export async function closeEdge(db: DbClient, edgeId: string, validTo: Date): Promise<void> {
  const table = edgeTableFor(edgeId);
  if (!table) throw new Error(`unroutable edge id: ${edgeId}`);
  const pk = EDGE_PK[table];
  const extra = table === "person_positions" ? ", is_current = false" : "";
  await db.query(
    `UPDATE ${table} SET valid_to = $1${extra} WHERE ${pk} = $2 AND valid_to IS NULL`,
    [validTo, edgeId],
  );
}
