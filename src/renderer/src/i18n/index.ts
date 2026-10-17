import { useAppStore } from "../store/app-store";
import { enUS } from "./locales/en-US";
import { zhTW, type MessageKey } from "./locales/zh-TW";

export const SUPPORTED_LOCALES = ["zh-TW", "en-US"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type TranslationVariables = Record<string, string | number>;

export const dictionaries: Record<Locale, Record<MessageKey, string>> = {
  "zh-TW": zhTW,
  "en-US": enUS,
};

export function normalizeLocale(locale: unknown): Locale {
  return locale === "en-US" ? "en-US" : "zh-TW";
}

export function translate(
  locale: unknown,
  key: MessageKey,
  vars: TranslationVariables = {},
): string {
  const normalized = normalizeLocale(locale);
  const template = dictionaries[normalized][key] ?? dictionaries["zh-TW"][key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

export function useI18n(): {
  locale: Locale;
  t: (key: MessageKey, vars?: TranslationVariables) => string;
} {
  const locale = useAppStore((state) => normalizeLocale(state.settings?.locale));
  return { locale, t: (key, vars) => translate(locale, key, vars) };
}

export type { MessageKey };
