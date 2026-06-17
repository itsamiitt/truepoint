// options.ts — static select options + label maps for the User settings forms. Kept out of the components so
// the timezone/locale lists and the notification-event copy live in one place. No logic.
import type { NotificationChannel, NotificationEvent } from "../types";

/** A compact, representative timezone list (IANA names). Not exhaustive — the backend is the source of truth. */
export const TIMEZONE_OPTIONS: { value: string; label: string }[] = [
  { value: "UTC", label: "UTC" },
  { value: "America/Los_Angeles", label: "Pacific — Los Angeles" },
  { value: "America/Denver", label: "Mountain — Denver" },
  { value: "America/Chicago", label: "Central — Chicago" },
  { value: "America/New_York", label: "Eastern — New York" },
  { value: "America/Sao_Paulo", label: "São Paulo" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "Europe/Berlin", label: "Berlin" },
  { value: "Asia/Kolkata", label: "India — Kolkata" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Australia/Sydney", label: "Sydney" },
];

/** Supported UI locales (BCP-47). */
export const LOCALE_OPTIONS: { value: string; label: string }[] = [
  { value: "en-US", label: "English (United States)" },
  { value: "en-GB", label: "English (United Kingdom)" },
  { value: "es-ES", label: "Español (España)" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "fr-FR", label: "Français (France)" },
  { value: "de-DE", label: "Deutsch (Deutschland)" },
];

/** The four notification events in display order, with a one-line description (12 §2). */
export const NOTIFICATION_EVENTS: { event: NotificationEvent; title: string; description: string }[] =
  [
    {
      event: "reply",
      title: "Replies",
      description: "Someone replies to one of your sequences.",
    },
    {
      event: "task",
      title: "Tasks due",
      description: "A task or reminder assigned to you is due.",
    },
    {
      event: "low_credit",
      title: "Low credits",
      description: "Your workspace credit balance runs low.",
    },
    {
      event: "digest",
      title: "Weekly digest",
      description: "A Monday summary of pipeline and activity.",
    },
  ];

/** The two delivery channels, in column order. */
export const NOTIFICATION_CHANNELS: { channel: NotificationChannel; label: string }[] = [
  { channel: "in_app", label: "In-app" },
  { channel: "email", label: "Email" },
];
