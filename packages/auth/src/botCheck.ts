// botCheck.ts — verify a Cloudflare Turnstile token at the identifier step (ADR-0020). The bot check is
// OPT-IN: when TURNSTILE_SECRET is unset it is disabled (so a preview/staging deploy can log in without a
// Cloudflare key); set the secret to ENFORCE it. With a secret present it fails closed on a bad/absent token.
import { env } from "@leadwolf/config";

let warnedNoTurnstile = false;

export async function verifyTurnstile(token: string | null, remoteIp?: string): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) {
    if (!warnedNoTurnstile) {
      warnedNoTurnstile = true;
      process.stderr.write(
        "botCheck: TURNSTILE_SECRET not set — bot check DISABLED. Set it (+ NEXT_PUBLIC_TURNSTILE_SITE_KEY) to enforce Turnstile.\n",
      );
    }
    return true; // unconfigured → skip (preview-friendly); enforced once a secret is present
  }
  if (!token) return false;

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const data = (await res.json()) as { success?: boolean };
    return Boolean(data.success);
  } catch {
    return false;
  }
}
