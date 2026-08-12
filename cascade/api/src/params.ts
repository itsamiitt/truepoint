// Boundary validation (08 §7): every param parsed and range-checked before any
// logic runs. Hand-rolled rather than a schema lib — the surface is small and
// the error messages stay ours (named-operator hints, id-prefix hints).

import { badRequest } from "./problem";

const ID_PATTERN = /^[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{20,26}$/;

export function requireId(value: string | undefined, prefix: string, code: string): string {
  if (!value || !value.startsWith(`${prefix}_`) || !ID_PATTERN.test(value)) {
    throw badRequest(code, `Expected a ${prefix}_ prefixed id.`, `Received: ${value ?? "(none)"}`);
  }
  return value;
}

export function requireEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  code: string,
  name: string,
): T {
  if (!value || !allowed.includes(value as T)) {
    throw badRequest(
      code,
      `'${name}' must be one of: ${allowed.join(", ")}.`,
      value ? `Received: ${value}` : "Parameter is required.",
    );
  }
  return value as T;
}

export function optionalEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  code: string,
  name: string,
): T | undefined {
  if (value === undefined) return undefined;
  return requireEnum(value, allowed, code, name);
}

export function parseLimit(value: string | undefined, fallback = 25, max = 100): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw badRequest("limit_invalid", "'limit' must be a positive integer.", `Received: ${value}`);
  }
  return Math.min(n, max);
}

export function parseConfidence(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (Number.isNaN(n) || n < 0 || n > 1) {
    throw badRequest(
      "min_confidence_invalid",
      "'min_confidence' must be between 0 and 1.",
      `Received: ${value}`,
    );
  }
  return n;
}

export function parseDate(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw badRequest(
      `${name}_invalid`,
      `'${name}' must be an ISO date (YYYY-MM-DD).`,
      `Received: ${value}`,
    );
  }
  return value;
}

export function parseBool(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw badRequest(`${name}_invalid`, `'${name}' must be true or false.`, `Received: ${value}`);
}

/** Comma-separated field groups (08 §6). */
export function parseFields(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean),
  );
}
