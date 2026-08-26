// revealFromDatabase.ts — reveal IS the save gesture on Search (decisions.md 2026-08-25 [S-06][S-04][A-01]).
//
// A database person (a Layer-0 row the workspace does not hold) used to take two gestures: "Add to workspace"
// (POST /contacts/from-database) and then a reveal on the contact that produced. This is the one-call
// composition of exactly those two verbs, in exactly their existing shapes — nothing here re-implements a
// landing or a charge:
//   1. the kill switch FIRST. A materialized contact carries NO channel value; the reveal is served from the
//      licensed Layer-0 channel, which MASTER_CHANNEL_REVEAL_ENABLED gates. Off ⇒ refuse before any write, so a
//      switched-off deployment never accumulates half-saved, unrevealable contacts.
//   2. materializeContactFromMaster — visibility predicate inside, content-hash idempotent, one provenance row
//      (rule 5), one person per explicit gesture (hard constraint 4).
//   3. revealContact on the contact that landed — suppression re-checked, credit-gated, claim-unique.
// A reveal that fails AFTER the landing (402 credits, 403 suppressed) leaves a saved, unrevealed contact —
// deliberately: the money path stays untouched and the audit rows stay true. The error carries `contactId` so
// the client flips the row honestly instead of pretending nothing happened.
//
// Deps are injectable so the ORDER is unit-tested without a database (never mock.module("@leadwolf/db")).
import { env } from "@leadwolf/config";
import {
  AppError,
  DatabaseRevealDisabledError,
  NotFoundError,
  type RevealResponse,
  type RevealType,
  ValidationError,
} from "@leadwolf/types";
import type { CaptureScope } from "../ingestion/landOverlayPerson.ts";
import {
  type MasterPresence,
  type MaterializeBy,
  type MaterializeResult,
  materializeContactFromMaster,
} from "../ingestion/materializeFromMaster.ts";
import { type RevealInput, revealContact } from "./revealContact.ts";

export interface RevealFromDatabaseInput {
  scope: { tenantId: string; workspaceId: string };
  userId: string;
  /** URL-shaped addressing only (slug or LinkedIn/Sales-Nav URL) — a Layer-0 id never crosses the boundary. */
  by: MaterializeBy;
  revealType: RevealType;
  ipAddress?: string | null;
  userAgent?: string | null;
  verifier?: RevealInput["verifier"];
  phoneVerifier?: RevealInput["phoneVerifier"];
}

export interface RevealFromDatabaseResult {
  contactId: string;
  /** The landing's outcome — `known` when the workspace already held the person (idempotent re-save). */
  outcome: "created" | "updated" | "known";
  reveal: RevealResponse;
  /** Layer-0 channel presence — booleans, never values — so the OTHER channel's reveal stays on offer. */
  presence: MasterPresence;
}

export interface RevealFromDatabaseDeps {
  /** The add verb (default: materializeContactFromMaster). */
  materialize: (scope: CaptureScope, by: MaterializeBy) => Promise<MaterializeResult>;
  /** The money verb (default: revealContact). */
  reveal: (input: RevealInput) => Promise<RevealResponse>;
  /** The kill switch (default: MASTER_CHANNEL_REVEAL_ENABLED, read per call so a test can flip it). */
  gateOn: () => boolean;
}

export async function revealFromDatabase(
  input: RevealFromDatabaseInput,
  deps: Partial<RevealFromDatabaseDeps> = {},
): Promise<RevealFromDatabaseResult> {
  const d: RevealFromDatabaseDeps = {
    materialize: materializeContactFromMaster,
    reveal: revealContact,
    gateOn: () => env.MASTER_CHANNEL_REVEAL_ENABLED,
    ...deps,
  };

  if (!d.gateOn()) throw new DatabaseRevealDisabledError();

  const landed = await d.materialize(
    {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      capturedByUserId: input.userId,
    },
    input.by,
  );
  if (landed.outcome === "skipped" || !landed.contactId) {
    // `not_supported` is a bad address (not a person URL); everything else is "the graph holds no visible
    // person here" — indistinguishable from absent, by design (no enumeration oracle).
    if (landed.reason === "not_supported") {
      throw new ValidationError("Provide a LinkedIn profile slug or URL.");
    }
    throw new NotFoundError("Person not found in the database.");
  }
  const presence: MasterPresence = landed.presence ?? { hasEmail: false, hasPhone: false };

  try {
    const reveal = await d.reveal({
      scope: input.scope,
      userId: input.userId,
      contactId: landed.contactId,
      revealType: input.revealType,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      verifier: input.verifier,
      phoneVerifier: input.phoneVerifier,
    });
    return { contactId: landed.contactId, outcome: landed.outcome, reveal, presence };
  } catch (err) {
    // The landing committed: the person IS saved. Say so on the problem (class and code are kept — a 402 stays
    // an InsufficientCreditsError) so the client flips the row to a saved, unrevealed contact.
    if (err instanceof AppError) {
      Object.assign(err.extensions, { contactId: landed.contactId, outcome: landed.outcome });
    }
    throw err;
  }
}
