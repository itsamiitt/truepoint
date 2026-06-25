// scimError.ts — the SCIM 2.0 error model for the /scim/v2 service (RFC 7644 §3.12). SCIM responses are NOT
// RFC-9457 Problem Details (the rest of the API) — an IdP expects the SCIM error envelope
// { schemas:["urn:ietf:params:scim:api:messages:2.0:Error"], status, scimType, detail } with content-type
// application/scim+json. So the SCIM router carries its OWN error type + onError handler instead of the global
// Problem-Details renderer (middleware/error.ts). ScimHttpError is a plain Error (not AppError) precisely so it
// can never be picked up by the global renderer and emitted in the wrong wire format.

import { scimErrorBody } from "@leadwolf/types";
import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";

export const SCIM_CONTENT_TYPE = "application/scim+json";

/** Emit a JSON body with the SCIM content-type (application/scim+json). We build the Response directly rather
 * than via c.json(), because c.json() forces content-type: application/json and would clobber a pre-set header
 * — an IdP expects scim+json on EVERY SCIM response. */
export function scimJson(c: Context, body: unknown, status: StatusCode = 200): Response {
  return c.body(JSON.stringify(body), status, { "content-type": SCIM_CONTENT_TYPE });
}

/** A thrown SCIM error — carries the HTTP status + the optional SCIM `scimType` detail code (RFC 7644 §3.12). */
export class ScimHttpError extends Error {
  readonly status: number;
  readonly scimType?: string;
  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.name = "ScimHttpError";
    this.status = status;
    this.scimType = scimType;
  }
}

// Convenience constructors for the statuses the SCIM service actually returns (kept terse + named).
export const scimUnauthorized = (detail = "Invalid or revoked SCIM token."): ScimHttpError =>
  new ScimHttpError(401, detail);
export const scimNotFound = (detail = "Resource not found."): ScimHttpError =>
  new ScimHttpError(404, detail);
export const scimInvalidValue = (detail: string): ScimHttpError =>
  new ScimHttpError(400, detail, "invalidValue");
export const scimInvalidFilter = (detail = "Unsupported filter."): ScimHttpError =>
  new ScimHttpError(400, detail, "invalidFilter");
export const scimBadSyntax = (detail = "Request is not valid SCIM."): ScimHttpError =>
  new ScimHttpError(400, detail, "invalidSyntax");

/** Render any thrown value as a SCIM error response. Wired as the SCIM router's onError so an IdP always gets
 * a well-formed SCIM error envelope (never an HTML 500 or a Problem-Details body it can't parse). An unexpected
 * error becomes a generic 500 that leaks nothing. */
export function renderScimError(err: Error, c: Context): Response {
  if (err instanceof ScimHttpError) {
    return scimJson(c, scimErrorBody(err.status, err.message, err.scimType), err.status as StatusCode);
  }
  return scimJson(c, scimErrorBody(500, "Internal error."), 500);
}
