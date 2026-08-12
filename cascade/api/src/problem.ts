// RFC 9457 problem+json — the ONE error shape (08 §7).
// Deviation from Crustdata, whose error body drifts per API family.

import type { Context } from "hono";

const TYPE_BASE = process.env.ERROR_TYPE_BASE_URL ?? "https://api.cascade.example/problems";

export interface ProblemInit {
  status: number;
  code: string;
  title: string;
  detail?: string;
}

export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail?: string;

  constructor(init: ProblemInit) {
    super(init.title);
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
  }

  toJSON() {
    return {
      type: `${TYPE_BASE}/${this.code.replaceAll("_", "-")}`,
      title: this.title,
      status: this.status,
      code: this.code,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

export const badRequest = (code: string, title: string, detail?: string) =>
  new ApiProblem({ status: 400, code, title, detail });

export const notFound = (code: string, title: string) =>
  new ApiProblem({ status: 404, code, title });

export const unauthorized = () =>
  new ApiProblem({
    status: 401,
    code: "unauthenticated",
    title: "A valid Bearer token is required.",
  });

export function problemResponse(c: Context, problem: ApiProblem) {
  c.header("content-type", "application/problem+json");
  return c.body(JSON.stringify(problem.toJSON()), problem.status as 400);
}
