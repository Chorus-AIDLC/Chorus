// src/i18n/config.ts
// i18n configuration

export const locales = ['en', 'zh', 'ko'] as const;
export const defaultLocale = 'en' as const;
export type Locale = (typeof locales)[number];

export const localeNames: Record<Locale, string> = {
  en: 'English',
  zh: '中文',
  ko: '한국어',
};

// Detect browser language, fallback to default
export function detectBrowserLocale(): Locale {
  if (typeof navigator === 'undefined') return defaultLocale;

  const browserLang = navigator.language.split('-')[0];
  return locales.includes(browserLang as Locale)
    ? (browserLang as Locale)
    : defaultLocale;
}
