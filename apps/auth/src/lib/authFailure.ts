// authFailure.ts — pure classifier for a thrown auth failure. The password step must distinguish a
// (uniform) credential rejection from a genuine infra outage (DB/Redis layer): the former is the user's
// fault and shows "check your credentials", the latter is a server fault and shows "temporarily
// unavailable". InvalidCredentialsError stays uniform (bad/unknown/locked/expired all map to "credentials");
// anything else thrown by the auth/data layer is treated as "infra". (17 §2.)
import { InvalidCredentialsError } from "@leadwolf/types";

/** A thrown auth failure is either a (uniform) credential rejection or an infra outage. */
export type AuthFailureKind = "credentials" | "infra";

export function authFailureKind(err: unknown): AuthFailureKind {
  return err instanceof InvalidCredentialsError ? "credentials" : "infra";
}
