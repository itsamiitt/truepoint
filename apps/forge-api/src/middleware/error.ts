// error middleware — RFC 9457 problem+json for the forge-api edge, mirroring the platform contract
// (apps/api middleware/error.ts) without its env dependency: the `type` namespace stays the relative
// `/errors/{code}` fallback @leadwolf/types AppError uses, so this module is importable from tests with
// no @leadwolf/config validation. Unknown routes and unhandled throws previously fell through to Hono's
// plain-text defaults — a prod 404 here was indistinguishable from the Next console's HTML 404.
import { AppError } from "@leadwolf/types";
import type { Context } from "hono";

const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** A minimal RFC 9457 problem response (Web-standard Response, matching the routes' style). */
export function problem(
  status: number,
  code: string,
  title: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { type: `/errors/${code}`, title, status, code, ...extra },
    { status, headers: { "content-type": PROBLEM_CONTENT_TYPE } },
  );
}

export function notFound(_c: Context): Response {
  return problem(404, "not_found", "Not Found");
}

export function onError(err: Error, _c: Context): Response {
  if (err instanceof AppError) {
    const details = err.toProblemDetails();
    return Response.json(details, {
      status: details.status,
      headers: { "content-type": PROBLEM_CONTENT_TYPE },
    });
  }
  // Message/stack go to server logs only — never to the client.
  console.error(`[forge-api] unhandled error: ${err.message}`);
  return problem(500, "internal", "Something went wrong");
}
