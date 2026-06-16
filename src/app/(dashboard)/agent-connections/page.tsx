"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bot, RadioTower, Server, Clock, Activity, CalendarClock } from "lucide-react";
import { authFetch } from "@/lib/auth-client";
import { clientLogger } from "@/lib/logger-client";

// Shape returned by GET /api/agent-connections (see daemon-connection.service.ts → ConnectionView).
interface ConnectionView {
  uuid: string;
  agentUuid: string;
  clientType: string;
  clientVersion: string | null;
  host: string; // "" when host-less
  startedAt: string | null;
  status: string;
  effectiveStatus: "online" | "offline";
  connectedAt: string;
  lastSeenAt: string;
  disconnectedAt: string | null;
}

const POLL_INTERVAL_MS = 15_000;

// Relative "last active" formatter — reuses the shared `time.*` i18n namespace
// already used by the projects page, so wording stays consistent.
function useRelativeTime() {
  const t = useTranslations("time");
  return (dateStr: string) => {
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffMinutes < 1) return t("justNow");
    if (diffMinutes < 60) return t("minutesAgo", { minutes: diffMinutes });
    if (diffHours < 24) return t("hoursAgo", { hours: diffHours });
    return t("daysAgo", { days: diffDays });
  };
}

// Uptime (duration since connectedAt) formatter — its own i18n keys since the
// shared `time.*` namespace only covers "ago"-style relative time.
function useUptime() {
  const t = useTranslations("agentConnections");
  return (connectedAt: string) => {
    const diffMs = Date.now() - new Date(connectedAt).getTime();
    const totalMinutes = Math.floor(diffMs / (1000 * 60));
    if (totalMinutes < 1) return t("uptimeJustStarted");
    const totalHours = Math.floor(totalMinutes / 60);
    if (totalHours < 1) return t("uptimeMinutes", { minutes: totalMinutes });
    const totalDays = Math.floor(totalHours / 24);
    if (totalDays < 1) return t("uptimeHoursMinutes", { hours: totalHours, minutes: totalMinutes % 60 });
    return t("uptimeDaysHours", { days: totalDays, hours: totalHours % 24 });
  };
}

function useClientTypeLabel() {
  const t = useTranslations("agentConnections");
  return (clientType: string) => {
    switch (clientType) {
      case "claude_code":
        return t("clientClaudeCode");
      case "openclaw":
        return t("clientOpenclaw");
      default:
        return t("clientUnknown");
    }
  };
}

function MetaRow({ icon: Icon, label, value }: { icon: typeof Server; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <Icon className="h-3.5 w-3.5 shrink-0 text-[#9A9A9A]" />
      <span className="text-[#9A9A9A]">{label}</span>
      <span className="truncate font-medium text-[#2C2C2C]">{value}</span>
    </div>
  );
}

function ConnectionCard({ connection }: { connection: ConnectionView }) {
  const t = useTranslations("agentConnections");
  const clientTypeLabel = useClientTypeLabel();
  const formatRelative = useRelativeTime();
  const formatUptime = useUptime();

  const isOnline = connection.effectiveStatus === "online";
  const host = connection.host === "" ? t("hostUnknown") : connection.host;
  const version = connection.clientVersion ?? t("versionUnknown");

  return (
    <Card className="gap-3 rounded-xl border-[#E5E2DC] p-5 shadow-none">
      {/* Header: client type + version pill, status badge */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#C67A5215]">
            <Bot className="h-4 w-4 text-[#C67A52]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-[#2C2C2C]">
                {clientTypeLabel(connection.clientType)}
              </span>
              <Badge
                variant="secondary"
                className="shrink-0 border-0 bg-[#F0EDE8] text-[10px] font-medium text-[#6B6B6B]"
              >
                {version}
              </Badge>
            </div>
          </div>
        </div>
        <Badge
          className={`shrink-0 gap-1.5 border-0 text-[11px] font-medium ${
            isOnline ? "bg-[#DCFCE7] text-[#15803D]" : "bg-[#F0EDE8] text-[#6B6B6B]"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${isOnline ? "bg-[#22C55E]" : "bg-[#9A9A9A]"}`}
            aria-hidden
          />
          {isOnline ? t("statusOnline") : t("statusOffline")}
        </Badge>
      </div>

      {/* Meta */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <MetaRow icon={Server} label={t("fieldHost")} value={host} />
        {/* Uptime is only meaningful while the daemon is up — computing now-connectedAt
            for an offline connection would show an ever-growing, misleading duration.
            Offline connections convey their timing via "last active" below instead. */}
        {isOnline && (
          <MetaRow icon={Clock} label={t("fieldUptime")} value={formatUptime(connection.connectedAt)} />
        )}
        <MetaRow icon={Activity} label={t("fieldLastActive")} value={formatRelative(connection.lastSeenAt)} />
        {connection.startedAt && (
          <MetaRow
            icon={CalendarClock}
            label={t("fieldStarted")}
            value={formatRelative(connection.startedAt)}
          />
        )}
      </div>
    </Card>
  );
}

export default function AgentConnectionsPage() {
  const t = useTranslations("agentConnections");
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConnections = useCallback(async () => {
    try {
      const res = await authFetch("/api/agent-connections");
      if (!res.ok) return;
      const json = await res.json();
      if (json.success) {
        setConnections(json.data.connections ?? []);
      }
    } catch (error) {
      clientLogger.error("Failed to fetch agent connections:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnections();
    const interval = setInterval(fetchConnections, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchConnections]);

  const onlineCount = connections.filter((c) => c.effectiveStatus === "online").length;

  return (
    <div className="bg-[#FAF8F4] p-4 md:px-8 md:py-6">
      {/* Header */}
      <div className="mb-4 md:mb-6">
        <div className="flex items-center gap-2.5">
          <h1 className="text-2xl font-semibold text-[#2C2C2C]">{t("title")}</h1>
          {!loading && (
            <Badge
              variant="secondary"
              className="border-0 bg-[#F0EDE8] text-[11px] font-medium text-[#6B6B6B]"
            >
              {t("summary", { online: onlineCount, total: connections.length })}
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-[#6B6B6B]">{t("subtitle")}</p>
      </div>

      {loading ? (
        <p className="text-sm text-[#6B6B6B]">{t("loading")}</p>
      ) : connections.length === 0 ? (
        <Card className="items-center gap-3 rounded-xl border-[#E5E2DC] p-8 text-center shadow-none md:p-12">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#C67A5215]">
            <RadioTower className="h-6 w-6 text-[#C67A52]" />
          </div>
          <h2 className="text-base font-semibold text-[#2C2C2C]">{t("empty.title")}</h2>
          <p className="max-w-md text-[13px] leading-relaxed text-[#6B6B6B]">{t("empty.body")}</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {connections.map((connection) => (
            <ConnectionCard key={connection.uuid} connection={connection} />
          ))}
        </div>
      )}
    </div>
  );
}
