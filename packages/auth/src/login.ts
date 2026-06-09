// login.ts — credential verification for password login (17 §2). Uniform InvalidCredentialsError — never
// reveals which step failed or whether the account exists. Session creation + code issuance happen later,
// at finalizeLogin (flow.ts), only AFTER every required factor (MFA, workspace) passes.

import { userRepository } from "@leadwolf/db";
import { InvalidCredentialsError } from "@leadwolf/types";
import { verifyPassword } from "./password.ts";

export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
}

export async function authenticatePassword(input: {
  email: string;
  password: string;
}): Promise<AuthenticatedUser> {
  const user = await userRepository.findByEmail(input.email);
  if (!user || !user.passwordHash || user.status !== "active") throw new InvalidCredentialsError();
  if (!(await verifyPassword(user.passwordHash, input.password))) throw new InvalidCredentialsError();
  return { userId: user.id, tenantId: user.tenantId };
}
