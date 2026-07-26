// requestId.ts — attach a correlation id to every request, echo it on the response, and make it available to
// the error handler. Without this, a production 500 is untraceable: the client sees a generic body, the server
// logs nothing joinable, and there is no id for a user to quote in a support ticket. This is the floor the
// observability mandate asks for (truepoint-platform SKILL.md — "a feature you cannot see is a feature you
// cannot operate"); traces/metrics build on top of the same id.
//
// An INBOUND x-request-id is honoured so a chain of calls shares one id, but it is untrusted input: it gets
// logged and echoed in a response header, so it is length- and charset-checked first (a raw value could carry
// newlines for log injection or CR/LF for header splitting). Anything unexpected is replaced, never rejected —
// a malformed header must not fail the request.

import type { Context, Next } from "hono";

const REQUEST_ID_HEADER = "x-request-id";
const MAX_INBOUND_LENGTH = 128;
/** Conservative allow-list: UUIDs, ULIDs, and the common trace-id shapes all fit. No CR/LF, no spaces. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]+$/;

function resolveRequestId(inbound: string | undefined): string {
  if (inbound && inbound.length <= MAX_INBOUND_LENGTH && SAFE_REQUEST_ID.test(inbound))
    return inbound;
  return crypto.randomUUID();
}

export async function requestId(c: Context, next: Next): Promise<void> {
  const id = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
  c.set("requestId", id);
  // Set BEFORE next() so the id is present on error responses too, not just successful ones.
  c.header(REQUEST_ID_HEADER, id);
  await next();
}

/** Read the id set above. Returns undefined if the middleware did not run (e.g. a route mounted before it). */
export function currentRequestId(c: Context): string | undefined {
  return c.get("requestId") as string | undefined;
}
