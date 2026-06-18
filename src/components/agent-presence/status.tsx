"use client";

// Online/offline status vocabulary for the agent-presence rendering module.
//
// Presentational + prop-driven (no data fetching). Shared by the pill, popover,
// modal, and the (soon-relocated) Agent Connections page so the pulsing-dot
// vocabulary stays byte-identical. The pulse halo is gated behind Tailwind's
// `motion-safe:` variant so it degrades to a static dot under
// `prefers-reduced-motion`.

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";

// Pulsing online dot — green core with a translucent halo that animates only
// under `motion-safe:`. Offline renders as a flat grey dot, no halo.
export function StatusDot({
  online,
  size = "sm",
}: {
  online: boolean;
  size?: "sm" | "md";
}) {
  const halo = size === "md" ? "h-2.5 w-2.5" : "h-2 w-2";
  const core = size === "md" ? "h-1.5 w-1.5" : "h-1 w-1";
  if (!online) {
    return (
      <span
        aria-hidden
        className={`${halo} rounded-full bg-[#9A9A9A] opacity-60`}
      />
    );
  }
  return (
    <span aria-hidden className={`relative inline-flex ${halo} items-center justify-center`}>
      <span
        className={`absolute inline-flex h-full w-full rounded-full bg-[#22C55E] opacity-30 motion-safe:animate-ping`}
      />
      <span className={`relative inline-flex ${core} rounded-full bg-[#22C55E]`} />
    </span>
  );
}

export function StatusBadge({ online }: { online: boolean }) {
  const t = useTranslations("agentConnections");
  return (
    <Badge
      className={`gap-1.5 rounded-full border-0 px-2.5 py-1 text-[11px] font-semibold tracking-wide ${
        online ? "bg-[#DCFCE7] text-[#15803D]" : "bg-[#F0EDE8] text-[#6B6B6B]"
      }`}
    >
      <StatusDot online={online} />
      {(online ? t("statusOnline") : t("statusOffline")).toUpperCase()}
    </Badge>
  );
}
