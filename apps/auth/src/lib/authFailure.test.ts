// authFailure.test.ts — the classifier must map ONLY InvalidCredentialsError to "credentials"; every other
// throw (an infra Error, or a non-Error value) is "infra" so an outage never masquerades as a bad password.
import { describe, expect, it } from "bun:test";
import { InvalidCredentialsError } from "@leadwolf/types";
import { authFailureKind } from "./authFailure.ts";

describe("authFailureKind", () => {
  it("maps InvalidCredentialsError to credentials", () => {
    expect(authFailureKind(new InvalidCredentialsError())).toBe("credentials");
  });

  it("maps a generic Error (e.g. db down) to infra", () => {
    expect(authFailureKind(new Error("db down"))).toBe("infra");
  });

  it("maps a non-Error thrown value to infra", () => {
    expect(authFailureKind("anything")).toBe("infra");
  });
});
