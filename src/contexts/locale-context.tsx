"use client";

// src/contexts/locale-context.tsx
// Client-side locale management with localStorage persistence

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { NextIntlClientProvider } from "next-intl";
import {
  locales,
  defaultLocale,
  detectBrowserLocale,
  type Locale,
} from "@/i18n/config";
import { clientLogger } from "@/lib/logger-client";

const LOCALE_STORAGE_KEY = "chorus-locale";

interface LocaleContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextType | null>(null);

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useLocale must be used within LocaleProvider");
  }
  return context;
}

interface LocaleProviderProps {
  children: ReactNode;
}

export function LocaleProvider({ children }: LocaleProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);
  const [messages, setMessages] = useState<Record<string, unknown> | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize locale from localStorage or browser detection
  useEffect(() => {
    let resolved: Locale;
    const storedLocale = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (storedLocale && locales.includes(storedLocale as Locale)) {
      resolved = storedLocale as Locale;
    } else {
      resolved = detectBrowserLocale();
      localStorage.setItem(LOCALE_STORAGE_KEY, resolved);
    }
    setLocaleState(resolved);
    // Sync to cookie so Server Components can read the locale
    document.cookie = `chorus-locale=${resolved};path=/;max-age=${365 * 24 * 60 * 60};SameSite=Lax`;
    setIsInitialized(true);
  }, []);

  // Load messages when locale changes
  useEffect(() => {
    if (!isInitialized) return;

    import(`../../messages/${locale}.json`)
      .then((mod) => {
        setMessages(mod.default);
      })
      .catch((err) => {
        clientLogger.error(`Failed to load messages for locale ${locale}:`, err);
        // Fallback to default locale
        import(`../../messages/${defaultLocale}.json`).then((mod) => {
          setMessages(mod.default);
        });
      });
  }, [locale, isInitialized]);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem(LOCALE_STORAGE_KEY, newLocale);
    // Sync to cookie so Server Components can read the locale
    document.cookie = `chorus-locale=${newLocale};path=/;max-age=${365 * 24 * 60 * 60};SameSite=Lax`;
    // Update html lang attribute
    document.documentElement.lang = newLocale;
  }, []);

  // Show nothing until initialized and messages loaded
  if (!isInitialized || !messages) {
    return null;
  }

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      <NextIntlClientProvider locale={locale} messages={messages}>
        {children}
      </NextIntlClientProvider>
    </LocaleContext.Provider>
  );
}
