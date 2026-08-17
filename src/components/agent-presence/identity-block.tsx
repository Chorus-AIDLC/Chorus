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
import { Badge } from "@/components/ui/badge";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { formatHost } from "@/lib/daemon-instance-format";
import { useClientTypeLabel } from "./hooks";
import { PathChip } from "./instance-group";
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

  // Agent identity tile footprint in px (matches the former icon-tile sizes:
  // sm 36 / md 40 / lg 48).
  const tilePx = size === "lg" ? 48 : size === "md" ? 40 : 36;
  const tileRadius = size === "lg" ? "rounded-xl" : "rounded-lg";
  const nameSize = size === "lg" ? "text-[20px]" : size === "md" ? "text-[16px]" : "text-[14px]";

  const agentName = connection.agentName?.trim() || t("unknownAgent");
  const version = connection.clientVersion ?? t("versionUnknown");
  // Host is de-emphasized + truncated via the shared T1 formatter so a long
  // host never breaks the subline; the formatter maps a host-less "" to the
  // localized "unknown host" KEY which we resolve here.
  const hostFmt = formatHost(connection.host);
  const hostLabel = hostFmt.isUnknown
    ? t("hostUnknown")
    : hostFmt.label;
  const hostTitle = hostFmt.isUnknown ? t("hostUnknown") : hostFmt.title;

  return (
    <div className="flex min-w-0 items-center gap-3">
      {/* Agent identity tile — the shared DiceBear <AgentAvatar> seeded by the
          agent name (replaces the former Bot-online / Clock3-offline icon tile).
          Online/offline liveness is conveyed by the adjacent StatusBadge /
          StatusDot at every call site, so both states show the agent's avatar. */}
      <AgentAvatar name={agentName} size={tilePx} className={`shrink-0 ${tileRadius}`} />
      <div className="min-w-0 flex-1">
        <div className={`truncate font-semibold text-foreground ${nameSize}`}>
          {agentName}
        </div>
        {/* Path-first: the connection's working directory leads as a monospace
            path chip (the primary per-instance identity). A null cwd renders
            the "unknown path" treatment. The chip flex-shrinks within the
            subline so a long path truncates (keeping its final segment) rather
            than overflowing. */}
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <PathChip cwd={connection.cwd} />
          <Badge
            variant="secondary"
            className="shrink-0 border-0 bg-[#F0EDE8] dark:bg-[#1f1e1c] px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
          >
            {clientTypeLabel(connection.clientType)}
          </Badge>
          <span
            title={hostTitle}
            className="truncate font-mono text-[11px] text-muted-foreground"
          >
            v{version} · {hostLabel}
          </span>
        </div>
      </div>
    </div>
  );
}
