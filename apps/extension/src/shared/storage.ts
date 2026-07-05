// Typed wrappers over chrome.storage. Durable prefs in `local`; the session-only PKCE verifier +
// login marker in `session` (cleared on browser close, never on disk). Access tokens NEVER touch
// storage — they live in memory in the AuthModule only (03 §1.4).

export interface Settings {
  activeWorkspaceId: string | null;
  telemetryEnabled: boolean;
  locale: string;
}

const SETTINGS_KEY = "settings";

const DEFAULT_SETTINGS: Settings = {
  activeWorkspaceId: null,
  telemetryEnabled: true,
  locale: "en",
};

export async function getLocal<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

export async function setLocal<T>(key: string, value: T): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function getSession<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.session.get(key);
  return result[key] as T | undefined;
}

export async function setSession<T>(key: string, value: T): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

export async function clearSession(key: string): Promise<void> {
  await chrome.storage.session.remove(key);
}

export async function getSettings(): Promise<Settings> {
  const stored = await getLocal<Partial<Settings>>(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await setLocal(SETTINGS_KEY, next);
  return next;
}
