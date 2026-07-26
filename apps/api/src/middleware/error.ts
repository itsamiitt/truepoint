// error.ts — render any thrown AppError as an RFC-9457 Problem Details response (09 §6); anything else is a
// generic 500 that never leaks internals or PII. Wired as Hono's onError handler.
//
// Every server fault is LOGGED here, structured, with the request id. Previously this handler returned the
// generic body and logged nothing at all — no stack, no id, no route — which made production 500s
// undiagnosable (there is no access log or tracing in this process either). Client errors (4xx AppErrors) stay
// quiet: they are the contract working, not a fault, and logging them would drown the real faults.
//
// On PII: the error's own `message`/`stack` are logged. An unexpected driver error can embed a value from the
// failing statement, so this is a deliberate trade — a server-side-only log, never the response — because
// without the message a 500 cannot be diagnosed at all. The request PATH is logged but never the QUERY STRING
// (search terms and identifiers live there).

import { log } from "@leadwolf/auth";
import { env } from "@leadwolf/config";
import { AppError } from "@leadwolf/types";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { currentRequestId } from "./requestId.ts";

/** Path only — the query string is deliberately dropped (it can carry search terms / identifiers). */
function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "unparseable";
  }
}

export function onError(err: Error, c: Context): Response {
  const requestId = currentRequestId(c);

  if (err instanceof AppError) {
    const problem = err.toProblemDetails(env.ERROR_TYPE_BASE_URL);
    // A 5xx AppError is still a server fault and must be visible; 4xx is the contract working as designed.
    if (problem.status >= 500) {
      log.error("api.error.app", {
        requestId,
        method: c.req.method,
        path: safePath(c.req.url),
        status: problem.status,
        code: problem.code,
        message: err.message,
        stack: err.stack,
      });
    }
    c.header("content-type", "application/problem+json");
    return c.json(problem, problem.status as ContentfulStatusCode);
  }

  log.error("api.error.unhandled", {
    requestId,
    method: c.req.method,
    path: safePath(c.req.url),
    name: err.name,
    message: err.message,
    stack: err.stack,
  });

  return c.json(
    {
      type: `${env.ERROR_TYPE_BASE_URL}internal`,
      title: "Something went wrong",
      status: 500,
      code: "internal",
      // Echoed so a user can quote it and support can join it to the log line above. Not sensitive: it is a
      // random id (or a caller-supplied, charset-validated one), never derived from user or tenant data.
      ...(requestId ? { requestId } : {}),
    },
    500,
  );
}
