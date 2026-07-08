// loginCode.ts — the two-step sign-in (email-OTP) code email (AUTH-025). A branded 6-digit code for the MFA
// challenge, with LOGIN wording distinct from the signup verification email — plus a security nudge, since an
// unrequested sign-in code can be the first sign of a compromised password.
import { type RenderedEmail, codeBlock, renderHtml, renderText } from "./layout.ts";

export interface LoginCodeInput {
  code: string;
  expiresMinutes?: number;
}

export function loginCodeEmail({ code, expiresMinutes = 15 }: LoginCodeInput): RenderedEmail {
  const bodyHtml = `<p style="margin:0 0 16px;">Enter this code to finish signing in to TruePoint. It expires in ${expiresMinutes} minutes.</p>${codeBlock(code)}<p style="margin:16px 0 0;color:#6b7280;font-size:13px;">If you didn't try to sign in, someone may have your password — change it and contact your administrator.</p>`;
  const text = `Your TruePoint sign-in code is ${code}. It expires in ${expiresMinutes} minutes.\n\nIf you didn't try to sign in, someone may have your password — change it and contact your administrator.`;
  return {
    subject: "Your TruePoint sign-in code",
    html: renderHtml({
      previewText: `Your sign-in code (expires in ${expiresMinutes} minutes)`,
      heading: "Finish signing in",
      bodyHtml,
    }),
    text: renderText(text),
  };
}
