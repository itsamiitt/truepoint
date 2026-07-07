// types.ts — view models for the Settings ▸ User scope (12 §2). Profile + notification prefs are served by
// the app API (`/settings/user/*`, 09 §); the security surfaces live on the auth origin (auth.truepoint.in,
// 12 §2 / 17 §10) and are rendered here as read-only status + deep links, never faked mutations. We re-export
// the shared auth enums from @leadwolf/types so factor labels stay in lockstep with the contracts.

export type { MfaMethodType } from "@leadwolf/types";

// ── Profile ─────────────────────────────────────────────────────────────────────────────────────────
/** The editable profile, served by GET /api/v1/settings/user/profile (12 §2). */
export interface UserProfile {
  /** Stable user id; read-only here. */
  id: string;
  name: string;
  /** Verified login email — read-only in this scope (changed via the auth origin). */
  email: string;
  /** IANA timezone name, e.g. "America/New_York". */
  timezone: string;
  /** BCP-47 locale tag, e.g. "en-US". */
  locale: string;
  /** Optional avatar URL; absent → grey-initials Avatar fallback. */
  avatarUrl?: string | null;
}

/** The PATCH body for a profile save — only the user-editable fields. */
export interface UserProfilePatch {
  name: string;
  timezone: string;
  locale: string;
}

// ── Notifications ─────────────────────────────────────────────────────────────────────────────────────
/** The four per-event notification kinds (12 §2 · notification_prefs). */
export type NotificationEvent = "reply" | "task" | "low_credit" | "digest";

/** The two delivery channels each event can fan out to. */
export type NotificationChannel = "in_app" | "email";

/** One event's per-channel on/off state. */
export type NotificationPref = Record<NotificationChannel, boolean>;

/** GET/PUT /api/v1/settings/user/notifications — the full prefs map (12 §2). */
export type NotificationPrefs = Record<NotificationEvent, NotificationPref>;
