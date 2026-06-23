// botCheck.ts — verify a Cloudflare Turnstile token at the identifier step (ADR-0020). The bot check is
// OPT-IN: when TURNSTILE_SECRET is unset it is disabled (so a preview/staging deploy can log in without a
// Cloudflare key); set the secret to ENFORCE it. With a secret present it fails closed on a bad/absent token.
import { env } from "@leadwolf/config";

// Hard cap on the outbound Turnstile siteverify call so a slow/hung Cloudflare can't stall the sign-in path.
const SITEVERIFY_TIMEOUT_MS = 2500;

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
  // Bound the outbound siteverify call: a hung Cloudflare request must not stall the sign-in path (perf
  // RC#11c). On timeout the AbortController makes fetch (and any in-flight body read) reject, which the catch
  // turns into a failed bot check — same fail-CLOSED behaviour as any other error when a secret is configured.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: controller.signal,
    });
    const data = (await res.json()) as { success?: boolean };
    return Boolean(data.success);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
