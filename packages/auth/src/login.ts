// login.ts — credential verification for password login (17 §2). Uniform InvalidCredentialsError — never
// reveals which step failed or whether the account exists. Session creation + code issuance happen later,
// at finalizeLogin (flow.ts), only AFTER every required factor (MFA, workspace) passes.

import { userRepository } from "@leadwolf/db";
import { InvalidCredentialsError } from "@leadwolf/types";
import { recordAuthMetric } from "./authMetrics.ts";
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
