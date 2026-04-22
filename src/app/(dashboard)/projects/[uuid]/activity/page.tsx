// src/app/(dashboard)/projects/[uuid]/activity/page.tsx
// Server Component - UUID obtained from URL

import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/card";
import { Monitor, User, Settings } from "lucide-react";
import { getServerAuthContext } from "@/lib/auth-server";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { listActivities } from "@/services/activity.service";
import { projectExists } from "@/services/project.service";
import { prisma } from "@/lib/prisma";
import { AnimatedEmptyState } from "@/components/animated-empty-state";

interface ActivityWithActor {
  uuid: string;
  targetType: string;
  targetUuid: string;
  action: string;
  value: unknown;
  createdAt: Date;
  actorName: string;
  isAgent: boolean;
}

const actionConfig: Record<string, { i18nKey: string; color: string }> = {
  created: { i18nKey: "activity.actionCreated", color: "text-[#5A9E6F]" },
  updated: { i18nKey: "activity.actionUpdated", color: "text-[#1976D2]" },
  approved: { i18nKey: "activity.actionApproved", color: "text-[#5A9E6F]" },
  rejected: { i18nKey: "activity.actionRejected", color: "text-[#D32F2F]" },
  claimed: { i18nKey: "activity.actionClaimed", color: "text-[#7B1FA2]" },
  completed: { i18nKey: "activity.actionCompleted", color: "text-[#00796B]" },
};

const entityTypeConfig: Record<string, { i18nKey: string; color: string }> = {
  idea: { i18nKey: "activity.entityIdea", color: "bg-[#FFF3E0] text-[#E65100]" },
  proposal: { i18nKey: "activity.entityProposal", color: "bg-[#F3E5F5] text-[#7B1FA2]" },
  task: { i18nKey: "activity.entityTask", color: "bg-[#E3F2FD] text-[#1976D2]" },
  document: { i18nKey: "activity.entityDocument", color: "bg-[#E8F5E9] text-[#5A9E6F]" },
  project: { i18nKey: "activity.entityProject", color: "bg-[#FFF3E0] text-[#E65100]" },
};

function formatRelativeOrNull(date: Date, t: Awaited<ReturnType<typeof getTranslations>>): string | null {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutesAgo", { minutes });
  if (hours < 24) return t("time.hoursAgo", { hours });
  if (days < 7) return t("time.daysAgo", { days });
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function groupByDate(activities: ActivityWithActor[], t: any): Record<string, ActivityWithActor[]> {
  const groups: Record<string, ActivityWithActor[]> = {};

  activities.forEach((activity) => {
    const date = new Date(activity.createdAt);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    let key: string;
    if (date.toDateString() === today.toDateString()) {
      key = t("time.today");
    } else if (date.toDateString() === yesterday.toDateString()) {
      key = t("time.yesterday");
    } else {
      key = date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    }

    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(activity);
  });

  return groups;
}

interface PageProps {
  params: Promise<{ uuid: string }>;
}

export default async function ActivityPage({ params }: PageProps) {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const { uuid: projectUuid } = await params;
  const t = await getTranslations();

  // Validate project exists
  const exists = await projectExists(auth.companyUuid, projectUuid);
  if (!exists) {
    redirect("/projects");
  }

  // Get Activities
  const { activities: rawActivities } = await listActivities({
    companyUuid: auth.companyUuid,
    projectUuid,
    skip: 0,
    take: 100,
  });

  // Get Actor information
  const actorUuids = [...new Set(rawActivities.map((a) => a.actorUuid))];

  const [users, agents] = await Promise.all([
    prisma.user.findMany({
      where: { uuid: { in: actorUuids } },
      select: { uuid: true, name: true },
    }),
    prisma.agent.findMany({
      where: { uuid: { in: actorUuids } },
      select: { uuid: true, name: true },
    }),
  ]);

  const userMap = new Map(users.map((u) => [u.uuid, { name: u.name || t("common.unknown"), isAgent: false }]));
  const agentMap = new Map(agents.map((a) => [a.uuid, { name: a.name, isAgent: true }]));

  // Format Activities
  const activities: ActivityWithActor[] = rawActivities.map((activity) => {
    const actor = userMap.get(activity.actorUuid) || agentMap.get(activity.actorUuid) || { name: t("common.system"), isAgent: false };

    return {
      uuid: activity.uuid,
      targetType: activity.targetType,
      targetUuid: activity.targetUuid,
      action: activity.action,
      value: activity.value,
      createdAt: activity.createdAt,
      actorName: actor.name,
      isAgent: actor.isAgent,
    };
  });

  const groupedActivities = groupByDate(activities, t);

  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[#2C2C2C]">{t("activity.title")}</h1>
        <p className="mt-1 text-sm text-[#6B6B6B]">{t("activity.subtitle")}</p>
      </div>

      {/* Activity Feed */}
      {activities.length === 0 ? (
        <AnimatedEmptyState>
          <Card className="flex flex-col items-center justify-center p-12 text-center border-[#E5E0D8]">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#F5F2EC]">
              <Monitor className="h-8 w-8 text-[#6B6B6B]" />
            </div>
            <h3 className="mb-2 text-lg font-medium text-[#2C2C2C]">{t("activity.noActivity")}</h3>
            <p className="max-w-sm text-sm text-[#6B6B6B]">{t("activity.noActivityDesc")}</p>
          </Card>
        </AnimatedEmptyState>
      ) : (
        <div className="space-y-8">
          {Object.entries(groupedActivities).map(([dateLabel, items]) => (
            <div key={dateLabel}>
              <h3 className="mb-4 text-sm font-medium text-[#6B6B6B]">{dateLabel}</h3>
              <div className="space-y-3">
                {items.map((activity, index) => {
                  const actionConf = actionConfig[activity.action] || actionConfig.updated;
                  const entityConf = entityTypeConfig[activity.targetType] || entityTypeConfig.project;

                  return (
                    <Card key={activity.uuid} className="flex items-start gap-4 border-[#E5E0D8] p-4" style={{ animation: `fade-in-up 0.2s ease-out ${index * 0.04}s both` }}>
                      <div className={`mt-0.5 flex h-8 w-8 items-center justify-center rounded-full ${activity.isAgent ? "bg-[#E3F2FD]" : "bg-[#F5F2EC]"}`}>
                        {activity.isAgent ? (
                          <Monitor className="h-4 w-4 text-[#1976D2]" />
                        ) : (
                          <User className="h-4 w-4 text-[#6B6B6B]" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="font-medium text-[#2C2C2C]">{activity.actorName}</span>
                          <span className={actionConf.color}>{t(actionConf.i18nKey)}</span>
                          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${entityConf.color}`}>
                            {t(entityConf.i18nKey)}
                          </span>
                        </div>
                        {activity.value && typeof activity.value === "object" && "title" in (activity.value as object) ? (
                          <p className="mt-1 text-sm text-[#6B6B6B] truncate">
                            {String((activity.value as { title: string }).title)}
                          </p>
                        ) : null}
                      </div>

                      <div className="text-xs text-[#9A9A9A] whitespace-nowrap">
                        {formatRelativeOrNull(activity.createdAt, t) ?? <FormattedDateTime date={activity.createdAt} />}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
