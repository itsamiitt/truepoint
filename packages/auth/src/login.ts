// login.ts — credential verification for password login (17 §2). Uniform InvalidCredentialsError — never
// reveals which step failed or whether the account exists. Session creation + code issuance happen later,
// at finalizeLogin (flow.ts), only AFTER every required factor (MFA, workspace) passes.

import { env } from "@leadwolf/config";
import { userRepository } from "@leadwolf/db";
import { InvalidCredentialsError } from "@leadwolf/types";
import { recordAuthMetric } from "./authMetrics.ts";
import { isPasswordBreached } from "./breachCheck.ts";
import { verifyPassword } from "./password.ts";

export interface AuthenticatedUser {
  userId: string;
}

export async function authenticatePassword(input: {
  email: string;
  password: string;
}): Promise<AuthenticatedUser> {
  try {
    // Global identity (ADR-0019): resolve the person; org/workspace are chosen AFTER auth, not baked in here.
    const user = await userRepository.findByEmail(input.email);
    if (!user || !user.passwordHash || user.status !== "active")
      throw new InvalidCredentialsError();
    if (!(await verifyPassword(user.passwordHash, input.password)))
      throw new InvalidCredentialsError();
    // OBSERVE-FIRST breached-password screening (flagged, off by default). The password just verified, so screen
    // it against HaveIBeenPwned and record the SLI — DETACHED (never awaited) + fail-open (isPasswordBreached
    // swallows outages), so it can neither slow nor break this login. Lets on-call size breached-password usage
    // before any forced-reset enforcement. Registration/reset already screen at set-time; this catches passwords
    // breached AFTER they were set.
    if (env.BREACHED_PASSWORD_CHECK_AT_LOGIN === "true") {
      void isPasswordBreached(input.password)
        .then((breached) =>
          recordAuthMetric("auth_password_breach_check_total", {
            result: breached ? "breached" : "clean",
          }),
        )
        .catch(() => {});
    }
    return { userId: user.id };
  } catch (e) {
    // SLI: a password login FAILED (the success-rate denominator paired with the finalizeLogin success counter).
    // Uniform — the metric never encodes which step failed (same non-enumeration posture as the error itself).
    if (e instanceof InvalidCredentialsError) {
      recordAuthMetric("auth_login_total", { result: "failure", method: "password" });
    }
    throw e;
  }
}
