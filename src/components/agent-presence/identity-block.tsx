"use client";

// Identity inversion: every surface leads with the owning agent's display name
// (`agentName` from the read API) and demotes the client type to a small badge.
// Two connections that share a client type but belong to different agents must
// stay distinguishable, so the agent name wins as primary identity everywhere.
//
// Presentational + prop-driven (no data fetching). Shared by the pill, popover,
// modal, and the (soon-relocated) Agent Connections page so the identity
// vocabulary stays byte-identical.

import { useTranslations } from "next-intl";
import { Bot, Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useClientTypeLabel } from "./hooks";
import type { ConnectionView } from "./types";

// Identity tile (icon-on-tinted-square + agent name + clientType badge + version·host subline).
// Used by desktop detail header AND mobile list cards / mobile detail screen,
// just at slightly different sizes via `size`.
export function IdentityBlock({
  connection,
  size,
}: {
  connection: ConnectionView;
  size: "sm" | "md" | "lg";
}) {
  const t = useTranslations("agentConnections");
  const clientTypeLabel = useClientTypeLabel();
  const online = connection.effectiveStatus === "online";

  // Icon: bot for online (active agent), clock for offline (paused/stopped).
  const Icon = online ? Bot : Clock3;
  const iconColor = online ? "#C67A52" : "#9A9A9A";
  const tileColor = online ? "#C67A5214" : "#9A9A9A14";

  const tileSize = size === "lg" ? "h-12 w-12" : size === "md" ? "h-10 w-10" : "h-9 w-9";
  const iconSize = size === "lg" ? "h-6 w-6" : size === "md" ? "h-5 w-5" : "h-4 w-4";
  const tileRadius = size === "lg" ? "rounded-xl" : "rounded-lg";
  const nameSize = size === "lg" ? "text-[20px]" : size === "md" ? "text-[16px]" : "text-[14px]";

  const agentName = connection.agentName?.trim() || t("unknownAgent");
  const version = connection.clientVersion ?? t("versionUnknown");
  const host = connection.host === "" ? t("hostUnknown") : connection.host;

  return (
    <div className="flex min-w-0 items-center gap-3">
      <div
        className={`${tileSize} ${tileRadius} flex shrink-0 items-center justify-center`}
        style={{ backgroundColor: tileColor }}
      >
        <Icon className={iconSize} style={{ color: iconColor }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className={`truncate font-semibold text-[#2C2C2C] ${nameSize}`}>
          {agentName}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge
            variant="secondary"
            className="shrink-0 border-0 bg-[#F0EDE8] px-2 py-0.5 text-[10px] font-medium text-[#6B6B6B]"
          >
            {clientTypeLabel(connection.clientType)}
          </Badge>
          <span className="truncate font-mono text-[11px] text-[#9A9A9A]">
            v{version} · {host}
          </span>
        </div>
      </div>
    </div>
  );
}
