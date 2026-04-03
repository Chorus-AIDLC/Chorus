"use client";

// src/app/(dashboard)/projects/[uuid]/dashboard/idea-tracker-stats.tsx
// IdeaTracker Stats Tab — Stats Cards, Task Pipeline, Recent Activity

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import {
  Lightbulb,
  LayoutGrid,
  ClipboardList,
  FileText,
  Loader2,
} from "lucide-react";

interface ProjectStats {
  ideas: { total: number; open: number };
  tasks: { total: number; inProgress: number; todo: number; toVerify: number; done: number };
  proposals: { total: number; pending: number };
  documents: { total: number };
}

interface ActivityItem {
  uuid: string;
  targetType: string;
  action: string;
  actorName: string;
  createdAt: string;
}

interface StatsData {
  stats: ProjectStats;
  recentActivities: ActivityItem[];
}

const pipelineColors = [
  { key: "todo", bg: "#E65100" },
  { key: "inProgress", bg: "#5A9E6F" },
  { key: "toVerify", bg: "#7B1FA2" },
  { key: "done", bg: "#00796B" },
] as const;

const activityDotColors: Record<string, string> = {
  idea: "bg-[#C67A52]",
  task: "bg-[#5A9E6F]",
  proposal: "bg-[#1976D2]",
  document: "bg-[#9A9A9A]",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatRelativeTime(dateStr: string, t: any): string {
  const now = Date.now();
  const diff = now - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t("justNow");
  if (minutes < 60) return t("minutesAgo", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("hoursAgo", { hours });
  const days = Math.floor(hours / 24);
  return t("daysAgo", { days });
}

interface IdeaTrackerStatsProps {
  projectUuid: string;
}

export function IdeaTrackerStats({ projectUuid }: IdeaTrackerStatsProps) {
  const t = useTranslations("ideaTracker");
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectUuid}/stats`);
      if (!res.ok) return;
      const json = await res.json();
      if (json.success) {
        setData(json.data);
      }
    } finally {
      setLoading(false);
    }
  }, [projectUuid]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-[#9A9A9A]" />
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const { stats, recentActivities } = data;

  const statCards = [
    {
      label: t("stats.totalIdeas"),
      value: stats.ideas.total,
      badge: stats.ideas.open > 0 ? t("stats.openCount", { count: stats.ideas.open }) : null,
      badgeStyle: "bg-[#C67A5220] text-[#C67A52]",
      href: `/projects/${projectUuid}/ideas`,
      iconBg: "bg-[#FFF3E0]",
      icon: <Lightbulb className="h-5 w-5 text-[#E65100]" />,
    },
    {
      label: t("stats.totalTasks"),
      value: stats.tasks.total,
      badge: stats.tasks.inProgress > 0 ? t("stats.activeCount", { count: stats.tasks.inProgress }) : null,
      badgeStyle: "bg-[#5A9E6F20] text-[#5A9E6F]",
      href: `/projects/${projectUuid}/tasks`,
      iconBg: "bg-[#E3F2FD]",
      icon: <LayoutGrid className="h-5 w-5 text-[#1976D2]" />,
    },
    {
      label: t("stats.totalProposals"),
      value: stats.proposals.total,
      badge: stats.proposals.pending > 0 ? t("stats.pendingCount", { count: stats.proposals.pending }) : null,
      badgeStyle: "bg-[#C67A5220] text-[#C67A52]",
      href: `/projects/${projectUuid}/proposals`,
      iconBg: "bg-[#F3E5F5]",
      icon: <ClipboardList className="h-5 w-5 text-[#7B1FA2]" />,
    },
    {
      label: t("stats.totalDocuments"),
      value: stats.documents.total,
      badge: null,
      badgeStyle: "",
      href: `/projects/${projectUuid}/documents`,
      iconBg: "bg-[#E8F5E9]",
      icon: <FileText className="h-5 w-5 text-[#5A9E6F]" />,
    },
  ];

  const pipelineCounts = [stats.tasks.todo, stats.tasks.inProgress, stats.tasks.toVerify, stats.tasks.done];
  const pipelineTotal = stats.tasks.total;

  const pipelineLegend = [
    { label: t("stats.todoCount", { count: stats.tasks.todo }), color: "#E65100" },
    { label: t("stats.inProgressCount", { count: stats.tasks.inProgress }), color: "#5A9E6F" },
    { label: t("stats.toVerifyCount", { count: stats.tasks.toVerify }), color: "#7B1FA2" },
    { label: t("stats.doneCount", { count: stats.tasks.done }), color: "#00796B" },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Stats Cards Row */}
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
        {statCards.map((stat) => (
          <Link key={stat.label} href={stat.href}>
            <Card className="cursor-pointer rounded-2xl border-0 bg-white p-3 shadow-none transition-all hover:shadow-md md:p-5">
              <div className="mb-2 flex items-center justify-between md:mb-3.5">
                <div className={`flex h-8 w-8 items-center justify-center rounded-lg md:h-10 md:w-10 md:rounded-xl ${stat.iconBg}`}>
                  {stat.icon}
                </div>
                {stat.badge && (
                  <span className={`hidden rounded-lg px-2.5 py-1 text-[11px] font-medium sm:inline ${stat.badgeStyle}`}>
                    {stat.badge}
                  </span>
                )}
              </div>
              <div className="text-2xl font-semibold leading-none tracking-tight text-[#2C2C2C] md:text-[32px]">
                {stat.value}
              </div>
              <div className="mt-0.5 text-[12px] text-[#6B6B6B] md:text-[13px]">{stat.label}</div>
            </Card>
          </Link>
        ))}
      </div>

      {/* Bottom Row: Task Pipeline + Recent Activity */}
      <div className="grid min-h-0 gap-5 lg:grid-cols-2">
        {/* Task Pipeline Card */}
        <Card className="flex flex-col rounded-2xl border-0 bg-white p-6 shadow-none">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-[16px] font-semibold text-[#2C2C2C]">{t("stats.taskPipeline")}</h2>
            <span className="text-[12px] text-[#9A9A9A]">{t("stats.totalCount", { count: pipelineTotal })}</span>
          </div>

          {pipelineTotal > 0 ? (
            <>
              {/* Progress Bar */}
              <div className="mb-5 flex h-3 w-full overflow-hidden rounded-md">
                {pipelineCounts.map((count, i) =>
                  count > 0 ? (
                    <div
                      key={pipelineColors[i].key}
                      className="h-full"
                      style={{
                        width: `${(count / pipelineTotal) * 100}%`,
                        backgroundColor: pipelineColors[i].bg,
                      }}
                    />
                  ) : null
                )}
              </div>

              {/* Legend */}
              <div className="flex flex-wrap gap-5">
                {pipelineLegend.map((item) => (
                  <div key={item.color} className="flex items-center gap-1.5">
                    <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: item.color }} />
                    <span className="text-[12px] text-[#6B6B6B]">{item.label}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center py-10 text-[13px] text-[#9A9A9A]">
              {t("stats.noTasks")}
            </div>
          )}
        </Card>

        {/* Recent Activity Card */}
        <Card className="flex flex-col rounded-2xl border-0 bg-white p-6 shadow-none">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[16px] font-semibold text-[#2C2C2C]">{t("stats.recentActivity")}</h2>
            <Link href={`/projects/${projectUuid}/activity`} className="text-[12px] font-medium text-[#C67A52] hover:underline">
              {t("stats.viewAll")}
            </Link>
          </div>

          {recentActivities.length > 0 ? (
            <div className="flex flex-col">
              {recentActivities.map((activity, i) => {
                const dotColor = activityDotColors[activity.targetType] || "bg-[#9A9A9A]";
                return (
                  <div key={activity.uuid} className={`flex items-start gap-3 py-3 ${i < recentActivities.length - 1 ? "border-b border-[#F5F2EC]" : ""}`}>
                    <div className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotColor}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-[#2C2C2C]">
                        {activity.actorName} {activity.action}
                      </p>
                      <span className="text-[11px] text-[#9A9A9A]">
                        {formatRelativeTime(activity.createdAt, t)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center py-10 text-[13px] text-[#9A9A9A]">
              {t("stats.noActivity")}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
