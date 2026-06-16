// bootstrapAdmin.ts — standalone deploy-time entrypoint that provisions the platform Bootstrap Admin
// (ADR-0032). Reads the creds from env (a built-in default lets it work on first run — SET + ROTATE
// BOOTSTRAP_ADMIN_* in .env.production), hashes the password with the auth layer (Argon2id), and
// provisions the identity via @leadwolf/db. The password is never logged. Run: bun run this file.
import { hashPassword } from "@leadwolf/auth";
import { closeDb, provisionBootstrapAdmin } from "@leadwolf/db";

// Standalone seed entrypoint (not request code), so it reads its two bootstrap envs directly.
const env = process.env;
const DEFAULT_EMAIL = "amit@truepoint.in";
const DEFAULT_PASSWORD = "DemonFlare@254039A";

async function main(): Promise<void> {
  const email = (env.BOOTSTRAP_ADMIN_EMAIL ?? DEFAULT_EMAIL).trim().toLowerCase();
  const password = env.BOOTSTRAP_ADMIN_PASSWORD ?? DEFAULT_PASSWORD;
  if (!env.BOOTSTRAP_ADMIN_PASSWORD) {
    console.warn(
      "bootstrapAdmin: using the built-in default password — set BOOTSTRAP_ADMIN_PASSWORD in .env.production and rotate it.",
    );
  }
  const passwordHash = await hashPassword(password);
  const res = await provisionBootstrapAdmin({ email, passwordHash, fullName: "Bootstrap Admin" });
  console.log(
    `bootstrapAdmin: ready — ${email} (user=${res.userId} tenant=${res.tenantId} workspace=${res.workspaceId})`,
  );
  await closeDb();
  process.exit(0);
}

main().catch((err) => {
  console.error("bootstrapAdmin: failed", err);
  process.exit(1);
});
