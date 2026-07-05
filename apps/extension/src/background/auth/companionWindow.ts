// companionWindow — interactive login via a REAL popup window (doc 12 §6.1, ADR-0045). Opens the web
// login (app.truepoint.in/auth/extension) in `chrome.windows.create({type:'popup'})` so the full normal
// flow (password → MFA → WebAuthn → SSO → workspace) runs first-party and reuses the existing session.
// The handoff page posts the token back via chrome.runtime.sendMessage; we accept it ONLY after verifying
// the sender origin AND the state nonce (chrome.runtime is exposed to every externally_connectable page).
import { ENV, HANDOFF_URL } from "../../shared/env.ts";
import { AuthError } from "./errors.ts";

const LOGIN_TIMEOUT_MS = 300_000;
const APP_ORIGIN = new URL(ENV.appOrigin).origin;

export interface HandoffTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Open the popup and resolve once the handoff message arrives (verified). Rejects on cancel/timeout. */
export async function runCompanionLogin(state: string): Promise<HandoffTokens> {
  const url = `${HANDOFF_URL}?state=${encodeURIComponent(state)}&ext_id=${encodeURIComponent(chrome.runtime.id)}`;
  const win = await chrome.windows.create({
    url,
    type: "popup",
    width: 480,
    height: 720,
    focused: true,
  });
  const windowId = win?.id;

  return new Promise<HandoffTokens>((resolve, reject) => {
    let settled = false;

    const onMessage = (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): void => {
      const tokens = parseHandoff(message, state, sender);
      if (!tokens) {
        return;
      }
      sendResponse({ ok: true });
      finish(() => resolve(tokens));
    };

    const onRemoved = (closedId: number): void => {
      if (closedId === windowId) {
        finish(() => reject(new AuthError(0, "auth_cancelled")));
      }
    };

    const timer = setTimeout(
      () => finish(() => reject(new AuthError(0, "auth_timeout"))),
      LOGIN_TIMEOUT_MS,
    );

    function finish(done: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      chrome.runtime.onMessageExternal.removeListener(onMessage);
      chrome.windows.onRemoved.removeListener(onRemoved);
      if (windowId !== undefined) {
        void chrome.windows.remove(windowId).catch(() => undefined);
      }
      done();
    }

    chrome.runtime.onMessageExternal.addListener(onMessage);
    chrome.windows.onRemoved.addListener(onRemoved);
  });
}

/** Accept a handoff ONLY from the app origin AND with the matching state nonce AND the right shape. */
function parseHandoff(
  message: unknown,
  expectedState: string,
  sender: chrome.runtime.MessageSender,
): HandoffTokens | null {
  if (!sender.origin || sender.origin !== APP_ORIGIN) {
    return null;
  }
  if (!message || typeof message !== "object") {
    return null;
  }
  const m = message as Record<string, unknown>;
  if (m.type !== "AUTH_HANDOFF" || m.state !== expectedState) {
    return null;
  }
  if (
    typeof m.accessToken !== "string" ||
    typeof m.refreshToken !== "string" ||
    typeof m.expiresIn !== "number"
  ) {
    return null;
  }
  return { accessToken: m.accessToken, refreshToken: m.refreshToken, expiresIn: m.expiresIn };
}
