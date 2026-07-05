// Minimal i18n loader: a flat per-locale catalog + {placeholder} interpolation. No heavy runtime;
// locales are static and bundled. RTL is handled by logical CSS properties in the surfaces (08 §7).
import { type MessageKey, en } from "./locales/en.ts";

const catalogs: Record<string, Partial<Record<MessageKey, string>>> = { en };

let activeLocale = "en";

export function setLocale(locale: string): void {
  if (catalogs[locale]) {
    activeLocale = locale;
  }
}

/** Translate a key, interpolating {name} placeholders from `vars`. Falls back to English, then the key. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const template = catalogs[activeLocale]?.[key] ?? en[key] ?? key;
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}
