// verificationCode.ts — the signup / resend email-verification code email (17 §2). Renders the branded HTML
// (the code in a large monospaced block) plus a plaintext fallback. Subject unchanged from the inline version.
import { type RenderedEmail, codeBlock, renderHtml, renderText } from "./layout.ts";

export interface VerificationCodeInput {
  code: string;
  expiresMinutes?: number;
}

export function verificationCodeEmail({
  code,
  expiresMinutes = 15,
}: VerificationCodeInput): RenderedEmail {
  const bodyHtml = `<p style="margin:0 0 16px;">Enter this code to verify your email and finish setting up your TruePoint account. It expires in ${expiresMinutes} minutes.</p>${codeBlock(code)}<p style="margin:16px 0 0;color:#6b7280;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>`;
  const text = `Your TruePoint verification code is ${code}. It expires in ${expiresMinutes} minutes.\n\nIf you didn't request this, you can safely ignore this email.`;
  return {
    subject: "Your TruePoint verification code",
    html: renderHtml({
      previewText: `Your verification code (expires in ${expiresMinutes} minutes)`,
      heading: "Confirm your email",
      bodyHtml,
    }),
    text: renderText(text),
  };
}
