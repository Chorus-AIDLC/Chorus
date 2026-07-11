"use client";

// src/components/sidebar-preferences.tsx
// Compact appearance/language control for the sidebar footer.
//
// Design intent: the previous full-width theme button mimicked a nav row and
// read as out of place in the footer. This replaces it with a quiet PAIR of
// icon-triggers — theme (sun/moon/monitor glyph) and language (short locale
// code) — sitting on one hairline-framed row above the presence pill. Each is a
// small square ghost trigger that rhymes with the footer's existing icon buttons
// (the logout icon), so appearance/language read as low-key utilities, not
// primary navigation. Both open a compact dropdown of radio options.
//
// A `mounted` gate is required for the theme trigger: next-themes can't know the
// resolved theme on the server, so the theme-dependent glyph would cause a
// hydration mismatch. Until mounted we render the neutral Monitor glyph.

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { Globe, Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLocale } from "@/contexts/locale-context";
import { locales, localeNames, type Locale } from "@/i18n/config";

type ThemeMode = "light" | "dark" | "system";

export function SidebarPreferences({ mobile = false }: { mobile?: boolean }) {
  const t = useTranslations();
  const { theme, setTheme } = useTheme();
  const { locale, setLocale } = useLocale();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const current = (mounted ? theme : undefined) as ThemeMode | undefined;
  const ThemeIcon =
    current === "light" ? Sun : current === "dark" ? Moon : Monitor;
  const themeLabel =
    current === "light"
      ? t("theme.light")
      : current === "dark"
        ? t("theme.dark")
        : t("theme.system");

  // Shared trigger sizing — a small square that matches the footer's icon
  // buttons. `mobile` nudges it up a touch to sit with the larger drawer scale.
  const triggerSize = mobile ? "h-8 min-w-8 px-2" : "h-7 min-w-7 px-1.5";
  const iconSize = mobile ? "h-4 w-4" : "h-3.5 w-3.5";

  return (
    <div className="flex items-center gap-1 px-2 pt-0.5">
      {/* Theme */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={`${triggerSize} justify-center gap-1.5 text-muted-foreground hover:text-foreground`}
            aria-label={t("theme.toggleLabel")}
            title={t("theme.toggleLabel")}
          >
            <ThemeIcon className={iconSize} />
            <span className="text-[12px] font-medium" suppressHydrationWarning>
              {mounted ? themeLabel : t("theme.system")}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-40">
          <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("theme.toggleLabel")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={current ?? "system"}
            onValueChange={(v) => setTheme(v as ThemeMode)}
          >
            <DropdownMenuRadioItem value="light">
              <Sun className="mr-2 h-4 w-4" />
              {t("theme.light")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <Moon className="mr-2 h-4 w-4" />
              {t("theme.dark")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">
              <Monitor className="mr-2 h-4 w-4" />
              {t("theme.system")}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Hairline divider between the two utilities. */}
      <span className="h-4 w-px bg-border" aria-hidden />

      {/* Language */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={`${triggerSize} justify-center gap-1.5 text-muted-foreground hover:text-foreground`}
            aria-label={t("settings.language")}
            title={t("settings.language")}
          >
            <Globe className={iconSize} />
            <span className="text-[12px] font-medium leading-none">
              {localeNames[locale]}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-40">
          <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("settings.language")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={locale}
            onValueChange={(v) => setLocale(v as Locale)}
          >
            {locales.map((loc) => (
              <DropdownMenuRadioItem key={loc} value={loc}>
                {localeNames[loc]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
