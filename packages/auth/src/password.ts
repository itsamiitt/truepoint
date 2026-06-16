// password.ts — Argon2id hashing/verification (ADR-0010). The digest is opaque; never log or return it.
import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane).
const OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string): Promise<string> => hash(plain, OPTS);

// A genuinely wrong password makes argon2 `verify` resolve to `false` → the caller rejects it (correct).
// But ANY THROWN error here — a stored digest the installed argon2 build cannot parse (a foreign/legacy
// variant, or a pre-migration hash), or the native binding failing to load — was previously swallowed as
// `false` too, indistinguishable from "wrong password", which silently hid a real fault (bug 3). We STILL
// fail closed (return false → InvalidCredentialsError; access is never granted on error), but we surface
// WHY — without ever logging the digest or the plaintext, only the non-secret shape needed to diagnose a
// format problem (argon2id-prefixed? + length).
export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `verifyPassword: argon2 verify threw — failing closed (NOT a wrong-password signal): looksArgon2id=${digest.startsWith("$argon2id$")} digestLen=${digest.length} reason=${reason}`,
    );
    return false;
  }
}
