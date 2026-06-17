// api.ts — the settings-user slice's data access (12 §2 · 09 §). Two app-API resources are wired here:
// the editable profile and the per-channel notification prefs (`/settings/user/*`). The security surfaces
// live on the auth origin (auth.truepoint.in, 17 §10) so there is no app-API seam for them — the Security
// panel renders read-only status + deep links instead (no faked mutations). The slice's only backend seam.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { NotificationPrefs, UserProfile, UserProfilePatch } from "./types";

const BASE = `${API_BASE}/api/v1/settings/user`;

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

// ── Profile ─────────────────────────────────────────────────────────────────────────────────────────
/** GET the editable profile (name / timezone / locale + read-only email + avatar). */
export async function fetchProfile(): Promise<UserProfile> {
  const res = await fetchWithAuth(`${BASE}/profile`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your profile"));
  return (await res.json()) as UserProfile;
}

/** PATCH the editable profile fields; returns the persisted record. */
export async function saveProfile(patch: UserProfilePatch): Promise<UserProfile> {
  const res = await fetchWithAuth(`${BASE}/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save your profile"));
  return (await res.json()) as UserProfile;
}

// ── Notifications ─────────────────────────────────────────────────────────────────────────────────────
/** GET the per-event × per-channel notification prefs. */
export async function fetchNotificationPrefs(): Promise<NotificationPrefs> {
  const res = await fetchWithAuth(`${BASE}/notifications`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your notification settings"));
  return (await res.json()) as NotificationPrefs;
}

/** PUT the full prefs map; returns the persisted prefs. */
export async function saveNotificationPrefs(prefs: NotificationPrefs): Promise<NotificationPrefs> {
  const res = await fetchWithAuth(`${BASE}/notifications`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(prefs),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save your notification settings"));
  return (await res.json()) as NotificationPrefs;
}
