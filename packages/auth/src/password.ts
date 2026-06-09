// password.ts — Argon2id hashing/verification (ADR-0010). The digest is opaque; never log or return it.
import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane).
const OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string): Promise<string> => hash(plain, OPTS);

export const verifyPassword = (digest: string, plain: string): Promise<boolean> =>
  verify(digest, plain).catch(() => false);
