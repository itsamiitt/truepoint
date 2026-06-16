// bootstrapAdmin.ts — standalone deploy-time entrypoint that provisions the platform Bootstrap Admin
// (ADR-0032). Requires BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD in env and FAILS CLOSED if either
// is unset — NO built-in default (a committed default credential is a super-admin-takeover risk). Hashes
// the password with the auth layer (Argon2id) and provisions via @leadwolf/db. Never logs the password.
import { hashPassword } from "@leadwolf/auth";
import { closeDb, provisionBootstrapAdmin } from "@leadwolf/db";

// Standalone seed entrypoint (not request code), so it reads its two bootstrap envs directly.
const env = process.env;

// Fail closed: BOTH creds must be set explicitly — never fall back to a built-in default.
// Exported so the regression test can assert the fail-closed contract without booting main().
export function requireBootstrapEnv(): { email: string; password: string } {
  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "bootstrapAdmin: BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must both be set (no default).",
    );
  }
  return { email, password };
}

async function main(): Promise<void> {
  const { email, password } = requireBootstrapEnv();
  const passwordHash = await hashPassword(password);
  const res = await provisionBootstrapAdmin({ email, passwordHash, fullName: "Bootstrap Admin" });
  console.log(
    `bootstrapAdmin: ready — ${email} (user=${res.userId} tenant=${res.tenantId} workspace=${res.workspaceId})`,
  );
  await closeDb();
  process.exit(0);
}

// Only auto-run when executed directly as the deploy seed entrypoint. Guarding this lets the unit test
// import requireBootstrapEnv without running main() (which would connect to the DB and process.exit).
if (import.meta.main) {
  main().catch((err) => {
    console.error("bootstrapAdmin: failed", err);
    process.exit(1);
  });
}
