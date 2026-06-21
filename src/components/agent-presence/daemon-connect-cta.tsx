"use client";

// Shared "connect a daemon" call-to-action for the daemon-discoverability empty
// states. Rendered in three places — all of which mean "you have no online agent
// connection right now, here is how to get one":
//   - the sidebar agent-presence pill popover, when 0 connections are online
//     (compact variant),
//   - the onboarding completion screen, as the prominent "next step" block,
//   - the Agent Connections "View all" modal empty state.
//
// One component + one command constant so the three surfaces can never drift in
// the exact command they show. The component is purely presentational and
// prop-driven — it fetches nothing and never reads useAgentPresence(); the CALLER
// decides whether to render it (e.g. the pill only renders it on its 0-online
// branch). The command literal lives in the constants below, NOT in any i18n
// message, so a future package/bin rename is a one-line change here.

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Check, Copy, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clientLogger } from "@/lib/logger-client";

// ---------------------------------------------------------------------------
// Single source of truth for the daemon command.
//
// The CLI publishes to npm (package `@chorus-aidlc/chorus`, bin `chorus`), and
// the target user of this CTA has installed nothing — so the most
// copy-paste-runnable form is the zero-install `npx` form. Verified against the
// live CLI: `chorus.mjs` declares bin `chorus` for package `@chorus-aidlc/chorus`
// with subcommands exactly `daemon` and `login`; `daemon` resolves credentials by
// flag > env > ~/.chorus/daemon.json (written by `login`) > plugin fallback, so a
// first-time user runs `login` then `daemon`.
// ---------------------------------------------------------------------------
export const DAEMON_NPX_PACKAGE = "@chorus-aidlc/chorus";
export const DAEMON_START_COMMAND = `npx ${DAEMON_NPX_PACKAGE} daemon`;
export const DAEMON_LOGIN_COMMAND = `npx ${DAEMON_NPX_PACKAGE} login`;

// Where "Learn more" points: the onboarding wizard (which includes the
// multi-agent install guide as one of its steps) is the stable, always-available
// route covering how to connect an agent. We link to the wizard rather than
// inventing a new standalone route; it opens at the start of the flow.
const LEARN_MORE_HREF = "/onboarding";

export type DaemonConnectCtaVariant = "compact" | "prominent";

// A monospace command line with a one-click copy button. The copy is guarded so
// an unavailable Clipboard API (insecure context, etc.) degrades gracefully — the
// command text stays visible and nothing throws.
function CommandLine({ command }: { command: string }) {
  const t = useTranslations("daemonConnectCta");
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      clientLogger.error("Failed to copy daemon command:", error);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 overflow-x-auto rounded-md bg-foreground px-3 py-2 font-mono text-[12.5px] leading-relaxed text-background">
        {command}
      </code>
      <Button
        variant="outline"
        size="sm"
        onClick={copy}
        aria-label={copied ? t("copied") : t("copy")}
        aria-live="polite"
        className="shrink-0"
      >
        {copied ? (
          <>
            <Check className="mr-1 h-4 w-4 text-green-500" />
            {t("copied")}
          </>
        ) : (
          <>
            <Copy className="mr-1 h-4 w-4" />
            {t("copy")}
          </>
        )}
      </Button>
    </div>
  );
}

export function DaemonConnectCta({ variant }: { variant: DaemonConnectCtaVariant }) {
  const t = useTranslations("daemonConnectCta");

  if (variant === "compact") {
    // Narrow surface (sidebar pill popover ~360px): tight spacing, the primary
    // start command + copy, and a condensed login note + learn-more link.
    return (
      <div className="flex flex-col gap-2.5 px-1 py-1.5">
        <div className="flex items-start gap-2">
          <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-[#C67A52]" aria-hidden />
          <p className="text-[12.5px] leading-relaxed text-[#6B6B6B]">
            {t("body")}
          </p>
        </div>
        <CommandLine command={DAEMON_START_COMMAND} />
        <p className="text-[11.5px] leading-relaxed text-[#9A9A9A]">
          {t("loginNote", { command: DAEMON_LOGIN_COMMAND })}
        </p>
        <Link
          href={LEARN_MORE_HREF}
          className="text-[12px] font-medium text-[#C67A52] hover:text-[#A65F3C] hover:underline"
        >
          {t("learnMore")}
        </Link>
      </div>
    );
  }

  // Prominent surface (onboarding completion screen, also fine in the wider
  // Agent Connections modal): a framed "next step" card with headline, the
  // "installed plugin ≠ resident online" body, command + copy, login note, and
  // the learn-more link.
  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-[#EFEBE4] bg-[#FCFBF8] p-5 text-left">
      <div className="flex items-center gap-2">
        <Terminal className="h-4 w-4 text-[#C67A52]" aria-hidden />
        <h3 className="text-[14px] font-semibold text-[#2C2C2C]">
          {t("headline")}
        </h3>
      </div>
      <p className="text-[13px] leading-relaxed text-[#6B6B6B]">{t("bodyLong")}</p>
      <CommandLine command={DAEMON_START_COMMAND} />
      <p className="text-[12px] leading-relaxed text-[#9A9A9A]">
        {t("loginNote", { command: DAEMON_LOGIN_COMMAND })}
      </p>
      <Link
        href={LEARN_MORE_HREF}
        className="text-[12.5px] font-medium text-[#C67A52] hover:text-[#A65F3C] hover:underline"
      >
        {t("learnMore")}
      </Link>
    </div>
  );
}
