// magicCarry.ts — (de)serialises the magic-link carry (app_origin/code_challenge/state) into the single
// opaque string the hardened MAGIC_TXN_COOKIE holds. There is no server-side magic transaction store (unlike
// SSO), so the cookie itself carries the app's PKCE/return context across the email round-trip; clientIp is
// re-derived from request headers at /magic/confirm. Encoded as base64url JSON — opaque, never user-facing.
export interface MagicCarry {
  appOrigin: string;
  codeChallenge: string;
  state: string;
}

export function encodeMagicCarry(carry: MagicCarry): string {
  return Buffer.from(JSON.stringify(carry), "utf8").toString("base64url");
}

export function decodeMagicCarry(value: string | undefined): MagicCarry | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<MagicCarry>;
    return {
      appOrigin: String(parsed.appOrigin ?? ""),
      codeChallenge: String(parsed.codeChallenge ?? ""),
      state: String(parsed.state ?? ""),
    };
  } catch {
    return null;
  }
}
