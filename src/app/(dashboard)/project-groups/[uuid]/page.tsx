"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Folder,
  Settings,
  ChevronRight,
  Plus,
} from "lucide-react";
import { authFetch } from "@/lib/auth-client";
import { ManageProjectGroupDialog } from "@/components/manage-project-group-dialog";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { getProjectInitials, getProjectIconColor } from "@/lib/project-colors";

// ── Types ──────────────────────────────────────────────────────
interface GroupDashboardData {
  group: {
    uuid: string;
    name: string;
    description: string | null;
  };
  stats: {
    projectCount: number;
    totalTasks: number;
    completedTasks: number;
    completionRate: number;
    openIdeas: number;
    activeProposals: number;
  };
  projects: {
    uuid: string;
    name: string;
    taskCount: number;
    completionRate: number;
  }[];
  recentActivity: {
    uuid: string;
    projectUuid: string;
    projectName: string;
    targetType: string;
    targetUuid: string;
    action: string;
    value: unknown;
    actorType: string;
    actorUuid: string;
    createdAt: string;
  }[];
}

// ── Helpers ────────────────────────────────────────────────────
const activityDotColors: Record<string, string> = {
  task: "#5A9E6F",
  idea: "#C67A52",
  proposal: "#1976D2",
  document: "#9A9A9A",
};

function formatRelativeTime(dateStr: string, t: ReturnType<typeof useTranslations>): string {
  const now = Date.now();
  const diff = now - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutesAgo", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { hours });
  const days = Math.floor(hours / 24);
  return t("time.daysAgo", { days });
}

function formatActivityText(activity: GroupDashboardData["recentActivity"][0]): string {
  const actionPast: Record<string, string> = {
    created: "created",
    updated: "updated",
    approved: "approved",
    rejected: "rejected",
    claimed: "claimed",
    completed: "completed",
    verified: "verified",
    submitted: "submitted",
    assigned: "assigned",
    status_changed: "updated",
  };
  const verb = actionPast[activity.action] ?? activity.action;
  const target = activity.targetType;
  return `${target.charAt(0).toUpperCase() + target.slice(1)} ${verb}`;
}

// ── Component ──────────────────────────────────────────────────
export default function ProjectGroupDashboardPage() {
  const params = useParams<{ uuid: string }>();
  const router = useRouter();
  const t = useTranslations();

  const [data, setData] = useState<GroupDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showManage, setShowManage] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);

  const fetchDashboard = async () => {
    try {
      const res = await authFetch(`/api/project-groups/${params.uuid}/dashboard`);
      if (!res.ok) {
        if (res.status === 404) {
          router.push("/projects");
          return;
        }
        setError(t("common.genericError"));
        return;
      }
      const json = await res.json();
      if (json.success) {
        setData(json.data);
      } else {
        setError(json.error || t("common.genericError"));
      }
    } catch {
      setError(t("common.genericError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.uuid]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-[13px] text-[#9A9A9A]">{t("common.loading")}</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-[13px] text-[#9A9A9A]">{error || t("common.genericError")}</span>
      </div>
    );
  }

  const { group, stats, projects, recentActivity } = data;

  const statCards = [
    {
      label: t("groupDashboard.statProjects"),
      value: stats.projectCount,
      valueColor: "text-[#2C2C2C]",
    },
    {
      label: t("groupDashboard.statTotalTasks"),
      value: stats.totalTasks,
      valueColor: "text-[#C67A52]",
    },
    {
      label: t("groupDashboard.statCompletionRate"),
      value: `${stats.completionRate}%`,
      valueColor: "text-[#5A9E6F]",
    },
    {
      label: t("groupDashboard.statOpenIdeas"),
      value: stats.openIdeas,
      valueColor: "text-[#2C2C2C]",
    },
    {
      label: t("groupDashboard.statActiveProposals"),
      value: stats.activeProposals,
      valueColor: "text-[#C67A52]",
    },
  ];

  return (
    <div className="flex h-full flex-col gap-6 bg-[#FAF8F4] p-4 md:p-6 lg:p-8">
      {/* Breadcrumb */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[12px]">
          <Link href="/projects" className="text-[#C67A52] hover:underline">
            {t("nav.projects")}
          </Link>
          <span className="text-[#9A9A9A]">/</span>
          <span className="text-[#9A9A9A]">{group.name}</span>
        </div>
      </div>

      {/* Title Section */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#C67A52]">
            <Folder className="h-[22px] w-[22px] text-white" />
          </div>
          <div>
            <h1 className="text-[24px] font-semibold tracking-tight text-[#2C2C2C]">
              {group.name}
            </h1>
            <p className="text-[13px] text-[#6B6B6B]">
              {t("groupDashboard.subtitle", { count: stats.projectCount })}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowManage(true)}
          className="gap-2 rounded-lg border-[#E5E2DC] bg-white text-[13px] font-medium text-[#2C2C2C] hover:border-[#C67A52] hover:bg-white"
        >
          <Settings className="h-3.5 w-3.5 text-[#6B6B6B]" />
          {t("projectGroups.manageGroup")}
        </Button>
      </div>

      {/* Stats Overview Row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {statCards.map((stat) => (
          <Card
            key={stat.label}
            className="rounded-2xl border-[#E5E2DC] bg-white !gap-1 p-4 !py-4 shadow-none"
          >
            <p className="text-[12px] font-normal text-[#9A9A9A]">{stat.label}</p>
            <p
              className={`mt-1.5 text-[32px] font-semibold leading-none tracking-tight ${stat.valueColor}`}
            >
              {stat.value}
            </p>
          </Card>
        ))}
      </div>

      {/* Content Columns */}
      <div className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row">
        {/* Left: Projects in this group */}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[14px] font-semibold text-[#2C2C2C]">
              {t("groupDashboard.projectsInGroup")}
            </h2>
            <Button
              size="sm"
              onClick={() => setShowCreateProject(true)}
              className="gap-1.5 rounded-lg bg-[#C67A52] text-[12px] font-medium text-white hover:bg-[#B56A42]"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("groupDashboard.newProject")}
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            {projects.length > 0 ? (
              projects.map((project) => {
                const initials = getProjectInitials(project.name);
                const iconColor = getProjectIconColor(project.name);
                return (
                  <Link
                    key={project.uuid}
                    href={`/projects/${project.uuid}/dashboard`}
                  >
                    <div className="flex cursor-pointer items-center justify-between rounded-xl border border-[#E5E2DC] bg-white py-3 px-4 transition-all hover:border-[#C67A52] hover:shadow-sm">
                      <div className="flex items-center gap-3">
                        <div
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold"
                          style={{ backgroundColor: iconColor.bg, color: iconColor.text }}
                        >
                          {initials}
                        </div>
                        <div>
                          <p className="text-[13px] font-semibold text-[#2C2C2C]">
                            {project.name}
                          </p>
                          <p className="text-[11px] text-[#9A9A9A]">
                            {t("groupDashboard.projectStats", {
                              tasks: project.taskCount,
                              completion: project.completionRate,
                            })}
                          </p>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-[#9A9A9A]" />
                    </div>
                  </Link>
                );
              })
            ) : (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[#E5E2DC] bg-[#FAF8F4] px-8 py-12">
                <Folder className="mb-3 h-8 w-8 text-[#D0CCC4]" />
                <p className="text-[13px] font-medium text-[#9A9A9A]">
                  {t("groupDashboard.noProjects")}
                </p>
                <p className="mt-1 text-[11px] text-[#C0BDB7]">
                  {t("groupDashboard.noProjectsHint")}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right: Recent Activity */}
        <div className="flex w-full flex-col gap-4 lg:w-[420px] lg:shrink-0">
          <h2 className="text-[14px] font-semibold text-[#2C2C2C]">
            {t("dashboard.recentActivity")}
          </h2>

          <Card className="flex flex-col overflow-hidden rounded-2xl border-[#E5E2DC] bg-white !gap-0 !py-0 shadow-none">
            {recentActivity.length > 0 ? (
              recentActivity.slice(0, 5).map((activity, i) => {
                const dotColor =
                  activityDotColors[activity.targetType] ?? "#9A9A9A";
                return (
                  <div
                    key={activity.uuid}
                    className={`flex items-start gap-3 px-4 py-3.5 ${
                      i < Math.min(recentActivity.length, 5) - 1
                        ? "border-b border-[#E5E2DC]"
                        : ""
                    }`}
                  >
                    <div
                      className="mt-1.5 h-2 w-2 shrink-0 rounded"
                      style={{ backgroundColor: dotColor }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] leading-[1.4] text-[#2C2C2C]">
                        {formatActivityText(activity)}
                      </p>
                      <p className="mt-1 text-[11px] text-[#9A9A9A]">
                        {activity.projectName} &middot;{" "}
                        {formatRelativeTime(activity.createdAt, t)}
                      </p>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="flex items-center justify-center p-8">
                <p className="text-[13px] text-[#9A9A9A]">
                  {t("dashboard.noRecentActivity")}
                </p>
              </div>
            )}
          </Card>
        </div>
      </div>
      {/* Create Project Dialog */}
      <CreateProjectDialog
        open={showCreateProject}
        onOpenChange={setShowCreateProject}
        groupUuid={group.uuid}
        groupName={group.name}
        onCreated={() => {
          setShowCreateProject(false);
          fetchDashboard();
        }}
      />

      {/* Manage Group Dialog */}
      <ManageProjectGroupDialog
        open={showManage}
        onOpenChange={setShowManage}
        groupUuid={group.uuid}
        groupName={group.name}
        groupDescription={group.description}
        projectCount={stats.projectCount}
        onUpdated={() => {
          setShowManage(false);
          fetchDashboard();
        }}
      />
    </div>
  );
}
