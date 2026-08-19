// bodyLimits.ts — the per-route request-body policy (launch-scale follow-up to Phase 1 finding: the old
// server-global Bun cap of 2 MB silently killed every import upload between 2 MB and the 250 MiB admission
// envelope BEFORE the route's own admission logic could run — server.ts's comment claimed per-route caps
// that could not exist under a transport-global ceiling).
//
// The layering now matches the claim: Bun's maxRequestBodySize (server.ts) is raised to the IMPORT
// envelope as a pure transport backstop, and THIS middleware enforces the real policy where per-route
// difference is possible: 2 MB for every /api route (comfortably above every JSON write this API accepts;
// hono/body-limit rejects on Content-Length first, then meters the stream — an over-limit body 413s
// without being buffered), except the three import-upload verbs, which carry the admission envelope here
// as defence-in-depth ON TOP of their own byte-capped admission parsing (admittedImportFormData /
// readJsonBodyCapped). /api/v1/imports/bulk is NOT exempted: it is gated dark and its upload transport is
// verified when that gate work lands — widen the exemption deliberately, not by default.

import { IMPORT_UPLOAD_REQUEST_MAX_BYTES } from "@leadwolf/core";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

/** Every JSON write this API accepts fits far under this (the old server-global value, kept). */
export const DEFAULT_API_BODY_LIMIT_BYTES = 2_000_000;

/** The import-upload verbs that legitimately carry multi-megabyte bodies (each does its own capped
 *  admission; the exemption only stops the DEFAULT limit from killing them first). POST-only. */
const IMPORT_UPLOAD_PATHS = new Set([
  "/api/v1/imports",
  "/api/v1/imports/preview",
  "/api/v1/imports/rows",
]);

/** RFC-9457 problem+json, matching the error middleware's envelope (a bodyLimit onError returns its own
 *  response, so the shape is spelled here rather than thrown through onError). */
const tooLarge = (limitBytes: number) =>
  Response.json(
    {
      type: "https://api.truepoint.in/problems/payload-too-large",
      title: "Request body too large.",
      status: 413,
      code: "payload_too_large",
      detail: `The request body may not exceed ${limitBytes} bytes on this route.`,
    },
    { status: 413, headers: { "content-type": "application/problem+json" } },
  );

const defaultLimit = bodyLimit({
  maxSize: DEFAULT_API_BODY_LIMIT_BYTES,
  onError: () => tooLarge(DEFAULT_API_BODY_LIMIT_BYTES),
});

/** The import router's own ceiling — the admission envelope (CSV cap + multipart overhead). */
export const importUploadBodyLimit = bodyLimit({
  maxSize: IMPORT_UPLOAD_REQUEST_MAX_BYTES,
  onError: () => tooLarge(IMPORT_UPLOAD_REQUEST_MAX_BYTES),
});

/** The /api-wide policy, registered pre-authn so an oversized body is refused before any verification
 *  work: the three import-upload verbs get the admission envelope, everything else the 2 MB default. One
 *  chokepoint on purpose — sibling routers sharing the /api/v1/imports mount run their own authn before
 *  the import router dispatches, so a router-level limiter there could never reject pre-auth. */
export const apiBodyLimit: MiddlewareHandler = (c, next) =>
  (c.req.method === "POST" && IMPORT_UPLOAD_PATHS.has(c.req.path)
    ? importUploadBodyLimit
    : defaultLimit)(c, next);
