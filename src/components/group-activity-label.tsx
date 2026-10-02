"use client";

import { useTranslations } from "next-intl";

const ACTIONS = new Set([
  "created", "updated", "approved", "rejected", "claimed", "completed",
  "verified", "submitted", "assigned", "deleted", "status_changed",
  "project_member_added", "project_member_role_changed", "project_member_removed",
  "project_visibility_changed", "project_group_changed", "group_created",
  "group_updated", "group_deleted", "group_access_initialized",
  "group_member_removed", "group_member_changed",
]);
const ENTITIES = new Set(["task", "idea", "proposal", "document", "project", "project_group"]);

export function GroupActivityLabel({ targetType, action }: { targetType: string; action: string }) {
  const t = useTranslations("groupDashboard");
  const entity = t(`entities.${ENTITIES.has(targetType) ? targetType : "entity"}`);
  return <>{t(`activity.${ACTIONS.has(action) ? action : "updated"}`, { entity })}</>;
}
