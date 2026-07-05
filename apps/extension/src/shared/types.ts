// Domain types shared across the SW, content scripts, and UI. Capture shapes are Zod so every
// cross-context message can be validated at the boundary (truepoint-security: untrusted input).
import { z } from "zod";

/** The site an adapter recognises. */
export const adapterId = z.enum(["linkedin", "generic"]);
export type AdapterId = z.infer<typeof adapterId>;

/** The kind of page the adapter matched. */
export const pageType = z.enum(["profile", "company", "search", "unsupported"]);
export type PageType = z.infer<typeof pageType>;

/** The visible, user-facing fields an adapter extracts from the rendered DOM. No private-API reads. */
export const capturedFields = z.object({
  fullName: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  jobTitle: z.string().optional(),
  company: z.string().optional(),
  location: z.string().optional(),
  profileUrl: z.string().url().optional(),
  /** LinkedIn public identifier — the stable dedup/subject key. */
  publicId: z.string().optional(),
  companyUrl: z.string().url().optional(),
});
export type CapturedFields = z.infer<typeof capturedFields>;

/** One captured observation, produced by an adapter on an explicit user gesture. */
export const capturedRecord = z.object({
  subjectKey: z.string().min(1),
  adapter: adapterId,
  pageType,
  fields: capturedFields,
  sourceUrl: z.string().url(),
  capturedAt: z.string().datetime({ offset: true }),
});
export type CapturedRecord = z.infer<typeof capturedRecord>;

/** The non-PII availability + ownership the server returns for a subject. */
export const subjectStatus = z.object({
  contactId: z.string().nullable(),
  known: z.boolean(),
  owned: z.boolean(),
  outcome: z.enum(["saved", "duplicate", "suppressed", "rejected", "unknown"]),
  emailAvailable: z.boolean().optional(),
  phoneAvailable: z.boolean().optional(),
  score: z.number().int().min(0).max(100).nullable().optional(),
});
export type SubjectStatus = z.infer<typeof subjectStatus>;

export const revealType = z.enum(["email", "phone", "full_profile"]);
export type RevealType = z.infer<typeof revealType>;

/** The classes the error framework maps every failure onto (02 §11 / 03 §1.10). */
export type ErrorClass =
  | "auth"
  | "validation"
  | "rate_limit"
  | "transient"
  | "suppression"
  | "extraction"
  | "permission"
  | "unexpected";
