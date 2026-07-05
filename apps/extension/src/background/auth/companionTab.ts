// companionTab — interactive login via a REAL new TAB (ADR-0045, doc 12). Opens the web login
// (app.truepoint.in/auth/extension) in a background (inactive) tab so an already-signed-in user is
// verified SILENTLY in the background; the tab is only brought to the foreground if interactive login
// (password/MFA/SSO) is actually needed. The handoff page posts the token back via
// chrome.runtime.sendMessage; the SW accepts it ONLY after verifying sender origin AND the state nonce.
// (chrome.tabs create/update/remove need no `tabs` permission — that only gates reading Tab.url/title.)
import { ENV, HANDOFF_URL } from "../../shared/env.ts";

const APP_ORIGIN = new URL(ENV.appOrigin).origin;

export interface HandoffTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

export type ExternalMessage = { kind: "handoff"; tokens: HandoffTokens } | { kind: "interactive" };

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Open the handoff page in a BACKGROUND (inactive) tab; returns the tab id (for foreground/close later). */
export async function openCompanionTab(state: string): Promise<number | undefined> {
  const url = `${HANDOFF_URL}?state=${encodeURIComponent(state)}&ext_id=${encodeURIComponent(chrome.runtime.id)}`;
  const tab = await chrome.tabs.create({ url, active: false });
  return tab.id;
}

/** Bring the pending tab to the foreground (login UI is needed) and focus its window. */
export async function activateTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // tab may have been closed
  }
}

export function closeTab(tabId: number): void {
  void chrome.tabs.remove(tabId).catch(() => undefined);
}

/** Accept a message ONLY from the app origin AND with the matching state nonce; classify handoff vs. the
 *  "login UI is needed" signal. */
export function classifyExternalMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  expectedState: string,
): ExternalMessage | null {
  if (!sender.origin || sender.origin !== APP_ORIGIN) {
    return null;
  }
  if (!message || typeof message !== "object") {
    return null;
  }
  const m = message as Record<string, unknown>;
  if (m.state !== expectedState) {
    return null;
  }
  if (m.type === "AUTH_STATUS" && m.phase === "interactive") {
    return { kind: "interactive" };
  }
  if (
    m.type === "AUTH_HANDOFF" &&
    typeof m.accessToken === "string" &&
    typeof m.refreshToken === "string" &&
    typeof m.expiresIn === "number"
  ) {
    return {
      kind: "handoff",
      tokens: { accessToken: m.accessToken, refreshToken: m.refreshToken, expiresIn: m.expiresIn },
    };
  }
  return null;
}
