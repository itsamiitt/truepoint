// conditionalJson.ts — ETag + If-None-Match + Cache-Control for hot polling reads.
//
// Written for GET /imports/:id, which a browser polls while an import runs. The nightly soak's TP-4 probe
// already proves the SEMANTICS this depends on: between chunk completions two polls return an identical
// payload, and a chunk completing changes it. That probe has been passing with an explicit `test.todo`
// beside it reading "ETag/304 + Cache-Control: private, max-age=2 on GET /imports/:id — route header not
// shipped yet". This is the header.
//
// THE ETAG IS OVER THE EXACT BYTES WE WOULD SEND, not over a chosen subset of fields. That distinction is
// the whole correctness argument: a 304 tells the client "the body you already have is still current", so
// anything that can change the body must be able to change the ETag. A fingerprint over
// (status, counters, completed_chunks) — the shape the soak probe uses — would be wrong here the moment a
// sibling field starts moving independently, and the failure would be a client pinned to a stale body with
// no error anywhere. Hashing the serialized body cannot drift from the body by construction.
//
// A STRONG ETag, therefore, not `W/`. Strong means byte-identical, and byte-identical is exactly what is
// being asserted.
//
// max-age=2 is deliberately tiny. It is not a caching strategy; it collapses the double-poll that happens
// when a component remounts or two panels watch the same job, while keeping a running import's progress
// visibly live. A longer window would make the UI look stuck.

import { createHash } from "node:crypto";
import type { Context } from "hono";

/** Same policy for every conditional read here: private (per-user), and stale almost immediately. */
export const POLL_CACHE_CONTROL = "private, max-age=2";

/** Strong ETag over the response bytes. Quoted per RFC 9110 — an unquoted entity-tag is malformed. */
export function etagFor(body: string): string {
  return `"${createHash("sha1").update(body).digest("base64url")}"`;
}

/**
 * Does the request's `If-None-Match` match this entity?
 *
 * Handles the list form (`If-None-Match: "a", "b"`) and `*`, both of which are in the spec and both of which
 * a naive equality check gets wrong. Comparison is per RFC 9110 §8.8.3.2 weak comparison: a `W/` prefix on
 * either side is ignored for the match, because a client that received a strong tag may legitimately send it
 * back weakened by an intermediary.
 */
export function ifNoneMatchSatisfied(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  const normalise = (tag: string) => tag.trim().replace(/^W\//, "");
  const target = normalise(etag);
  return trimmed.split(",").some((candidate) => normalise(candidate) === target);
}

/**
 * Send `payload` as JSON with an ETag, answering 304 when the client already has it.
 *
 * A 304 carries NO body and must carry the same ETag and Cache-Control the 200 would have, so the client can
 * refresh its freshness without losing the validator (RFC 9110 §15.4.5). Returning a bare 304 is a common
 * bug: the cached entry then has no validator for the NEXT request and the client falls back to
 * unconditional GETs, quietly undoing the saving.
 */
export function conditionalJson(c: Context, payload: unknown, status = 200): Response {
  const body = JSON.stringify(payload);
  const etag = etagFor(body);

  c.header("ETag", etag);
  c.header("Cache-Control", POLL_CACHE_CONTROL);

  if (status === 200 && ifNoneMatchSatisfied(c.req.header("if-none-match"), etag)) {
    return c.body(null, 304);
  }

  c.header("Content-Type", "application/json");
  return c.body(body, status as 200);
}
