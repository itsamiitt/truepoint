// bootstrapAdmin.test.ts — proves the bootstrap-admin seed FAILS CLOSED. requireBootstrapEnv throws (never
// returns a built-in default) when BOOTSTRAP_ADMIN_EMAIL or BOOTSTRAP_ADMIN_PASSWORD is unset; it normalizes
// the email (trim + lowercase) but returns the password VERBATIM (no trim — a password may contain
// intentional whitespace); and the fail-closed error names both vars without echoing any credential value
// and never resurfaces the removed hardcoded 'DemonFlare' default (no-secret-in-logs regression guard).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { requireBootstrapEnv } from "./bootstrapAdmin.ts";

const EMAIL = "BOOTSTRAP_ADMIN_EMAIL";
const PASSWORD = "BOOTSTRAP_ADMIN_PASSWORD";

let savedEmail: string | undefined;
let savedPassword: string | undefined;

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  savedEmail = process.env[EMAIL];
  savedPassword = process.env[PASSWORD];
});

afterEach(() => {
  // Restore the surrounding env so cases don't leak into each other or the test runner.
  restore(EMAIL, savedEmail);
  restore(PASSWORD, savedPassword);
});

test("throws (fail-closed) when the password is unset — no built-in default", () => {
  process.env[EMAIL] = "admin@example.com";
  delete process.env[PASSWORD];
  expect(() => requireBootstrapEnv()).toThrow(/BOOTSTRAP_ADMIN_PASSWORD/);
});

test("throws (fail-closed) when the email is unset", () => {
  delete process.env[EMAIL];
  process.env[PASSWORD] = "a-long-random-secret";
  expect(() => requireBootstrapEnv()).toThrow(/BOOTSTRAP_ADMIN_EMAIL/);
});

test("throws when the email is blank/whitespace (trims to empty)", () => {
  process.env[EMAIL] = "   ";
  process.env[PASSWORD] = "a-long-random-secret";
  expect(() => requireBootstrapEnv()).toThrow();
});

test("normalizes the email: trims surrounding whitespace and lowercases", () => {
  process.env[EMAIL] = "  Admin@Example.COM  ";
  process.env[PASSWORD] = "a-long-random-secret";
  expect(requireBootstrapEnv().email).toBe("admin@example.com");
});

test("returns the password VERBATIM — does NOT trim (it may contain intentional whitespace)", () => {
  process.env[EMAIL] = "admin@example.com";
  process.env[PASSWORD] = "  s3 cret  ";
  expect(requireBootstrapEnv().password).toBe("  s3 cret  ");
});

test("the fail-closed error names both vars and never resurfaces the removed default credential", () => {
  delete process.env[EMAIL];
  delete process.env[PASSWORD];
  let message = "";
  try {
    requireBootstrapEnv();
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("BOOTSTRAP_ADMIN_EMAIL");
  expect(message).toContain("BOOTSTRAP_ADMIN_PASSWORD");
  expect(message).not.toContain("DemonFlare"); // regression guard: the hardcoded default must stay gone
});
