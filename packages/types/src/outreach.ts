// outreach.ts — shared vocabulary for the M9 outreach engine (03 §7, 05 §13, ADR-0009): the closed
// sequence/step/log enums (mirrored as SQL CHECKs in packages/db/src/schema/outreach.ts — this file is the
// source of truth), the request schemas the API validates with, and the list DTOs the web client renders.

import { z } from "zod";

// ── Enums (mirror the 03 §7 CHECK constraints) ─────────────────────────────────────────────────────────
export const sequenceStatus = z.enum(["active", "paused", "archived"]);
export type SequenceStatus = z.infer<typeof sequenceStatus>;

export const outreachStepChannel = z.enum(["email", "linkedin"]);
export type OutreachStepChannel = z.infer<typeof outreachStepChannel>;

/** Per-contact enrollment lifecycle (distinct from contacts.outreach_status, the contact-level rollup). */
export const outreachLogStatus = z.enum([
  "enrolled",
  "active",
  "replied",
  "completed",
  "unsubscribed",
  "bounced",
]);
export type OutreachLogStatus = z.infer<typeof outreachLogStatus>;

// ── Request schemas (09 §3 body naming: snake_case) ────────────────────────────────────────────────────
/** The CAN-SPAM identity fields are optional at CREATE time but enforced at the send tx (08 §6). */
export const createSequenceSchema = z.object({
  name: z.string().min(1).max(255),
  from_address: z.string().email().max(255).optional(),
  physical_address: z.string().min(1).max(500).optional(), // CAN-SPAM postal address (08 §6)
});
export type CreateSequenceRequest = z.infer<typeof createSequenceSchema>;

export const addStepSchema = z.object({
  channel: outreachStepChannel.default("email"),
  delay_hours: z.number().int().min(0).default(0),
  subject: z.string().max(255).optional(),
  body: z.string().min(1).max(5000),
});
export type AddStepRequest = z.infer<typeof addStepSchema>;

export const enrollSchema = z.object({ contact_id: z.string().uuid() });
export type EnrollRequest = z.infer<typeof enrollSchema>;

// ── List DTOs (the sequences surface + the per-sequence enrollment log) ────────────────────────────────
export const sequenceSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: sequenceStatus,
  stepCount: z.number().int().nonnegative(),
  enrolledCount: z.number().int().nonnegative(),
});
export type SequenceSummary = z.infer<typeof sequenceSummarySchema>;

export const outreachLogEntrySchema = z.object({
  id: z.string().uuid(),
  contactId: z.string().uuid(),
  status: outreachLogStatus,
  currentStep: z.number().int().nonnegative(),
  lastEventAt: z.coerce.date(), // Date server-side; the client parses the serialized ISO string
});
export type OutreachLogEntry = z.infer<typeof outreachLogEntrySchema>;
