// botCheck.ts — verify a Cloudflare Turnstile token at the identifier step (ADR-0020). Fails CLOSED in
// production; in dev without a configured secret it passes, so local login works without a Turnstile key.
import { env } from "@leadwolf/config";

export async function verifyTurnstile(token: string | null, remoteIp?: string): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return env.NODE_ENV !== "production"; // dev: allow; prod: misconfig → fail closed
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
