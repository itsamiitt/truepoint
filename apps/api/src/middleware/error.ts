// error.ts — render any thrown AppError as an RFC-9457 Problem Details response (09 §6); anything else is a
// generic 500 that never leaks internals or PII. Wired as Hono's onError handler.

import { AppError } from "@leadwolf/types";
import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";

export function onError(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    const problem = err.toProblemDetails();
    c.header("content-type", "application/problem+json");
    return c.json(problem, problem.status as StatusCode);
  }
  return c.json(
    {
      type: "https://leadwolf.dev/errors/internal",
      title: "Something went wrong",
      status: 500,
      code: "internal",
    },
    500,
  );
}
