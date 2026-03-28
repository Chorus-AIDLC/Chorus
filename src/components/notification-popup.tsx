"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  CheckCircle2,
  XCircle,
  MessageSquare,
  UserCheck,
  Send,
  RefreshCw,
  AtSign,
} from "lucide-react";
import { motion } from "framer-motion";
import { staggerItem } from "@/lib/animation";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { authFetch } from "@/lib/auth-client";
import { useNotification } from "@/contexts/notification-context";

// ===== Types =====

interface Notification {
  uuid: string;
  projectUuid: string;
  projectName: string;
  entityType: string;
  entityUuid: string;
  entityTitle: string;
  action: string;
  message: string;
  actorType: string;
  actorUuid: string;
  actorName: string;
  readAt: string | null;
  createdAt: string;
}

// ===== Utility: hash-based color for project badges =====

const PROJECT_COLORS = [
  { bg: "bg-amber-100 dark:bg-amber-900/30", text: "text-amber-800 dark:text-amber-300" },
  { bg: "bg-blue-100 dark:bg-blue-900/30", text: "text-blue-800 dark:text-blue-300" },
  { bg: "bg-emerald-100 dark:bg-emerald-900/30", text: "text-emerald-800 dark:text-emerald-300" },
  { bg: "bg-violet-100 dark:bg-violet-900/30", text: "text-violet-800 dark:text-violet-300" },
  { bg: "bg-rose-100 dark:bg-rose-900/30", text: "text-rose-800 dark:text-rose-300" },
  { bg: "bg-cyan-100 dark:bg-cyan-900/30", text: "text-cyan-800 dark:text-cyan-300" },
  { bg: "bg-orange-100 dark:bg-orange-900/30", text: "text-orange-800 dark:text-orange-300" },
  { bg: "bg-indigo-100 dark:bg-indigo-900/30", text: "text-indigo-800 dark:text-indigo-300" },
];

function hashProjectColor(projectUuid: string) {
  let hash = 0;
  for (let i = 0; i < projectUuid.length; i++) {
    hash = (hash * 31 + projectUuid.charCodeAt(i)) | 0;
  }
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
}

// ===== Utility: type icon with semantic color =====

function getTypeIcon(action: string) {
  switch (action) {
    case "task_assigned":
    case "idea_claimed":
      return { Icon: UserCheck, color: "text-[#C67A52]" }; // terracotta
    case "proposal_approved":
    case "task_verified":
      return { Icon: CheckCircle2, color: "text-green-600" };
    case "proposal_rejected":
    case "task_reopened":
      return { Icon: XCircle, color: "text-red-500" };
    case "comment_added":
      return { Icon: MessageSquare, color: "text-orange-500" };
    case "mentioned":
      return { Icon: AtSign, color: "text-blue-600" };
    case "proposal_submitted":
      return { Icon: Send, color: "text-blue-500" };
    case "task_status_changed":
      return { Icon: RefreshCw, color: "text-blue-500" };
    default:
      return { Icon: Send, color: "text-muted-foreground" };
  }
}

// ===== Utility: relative time =====

function useRelativeTime(t: ReturnType<typeof useTranslations>) {
  return useCallback(
    (dateStr: string) => {
      const now = Date.now();
      const date = new Date(dateStr).getTime();
      const diffMs = now - date;
      const diffMin = Math.floor(diffMs / 60_000);
      const diffHrs = Math.floor(diffMs / 3_600_000);
      const diffDays = Math.floor(diffMs / 86_400_000);

      if (diffMin < 1) return t("justNow");
      if (diffMin < 60) return t("minutesAgo", { count: diffMin });
      if (diffHrs < 24) return t("hoursAgo", { count: diffHrs });
      return t("daysAgo", { count: diffDays });
    },
    [t]
  );
}

// ===== Entity navigation =====

function getEntityPath(notification: Notification): string {
  const { entityType, entityUuid, projectUuid } = notification;
  const base = `/projects/${projectUuid}`;
  switch (entityType) {
    case "task":
      return `${base}/tasks/${entityUuid}`;
    case "idea":
      return `${base}/ideas/${entityUuid}`;
    case "proposal":
      return `${base}/proposals/${entityUuid}`;
    case "document":
      return `${base}/documents/${entityUuid}`;
    default:
      return base;
  }
}

// Internal notification actions that should not be displayed in the popup
const HIDDEN_ACTIONS = new Set(["agent_checkin"]);

function filterDisplayable(notifications: Notification[]) {
  return notifications.filter((n) => !HIDDEN_ACTIONS.has(n.action));
}

// ===== NotificationPopup =====

interface NotificationPopupProps {
  onClose: () => void;
}

export function NotificationPopup({ onClose }: NotificationPopupProps) {
  const t = useTranslations("notifications");
  const router = useRouter();
  const { refreshNotifications } = useNotification();
  const relativeTime = useRelativeTime(t);

  const [allNotifications, setAllNotifications] = useState<Notification[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState<Notification[]>([]);
  const [allTotal, setAllTotal] = useState(0);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const fetchNotifications = useCallback(async (unreadOnly: boolean, offset: number) => {
    const params = new URLSearchParams({
      limit: "20",
      offset: String(offset),
    });
    if (unreadOnly) params.set("unreadOnly", "true");

    const res = await authFetch(`/api/notifications?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success) return null;
    return data.data as {
      notifications: Notification[];
      unreadCount: number;
    };
  }, []);

  // Initial load — fetch both tabs
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const [allRes, unreadRes] = await Promise.all([
        fetchNotifications(false, 0),
        fetchNotifications(true, 0),
      ]);
      if (cancelled) return;
      if (allRes) {
        setAllNotifications(allRes.notifications);
        setAllTotal(allRes.notifications.length < 20 ? allRes.notifications.length : 999);
      }
      if (unreadRes) {
        setUnreadNotifications(unreadRes.notifications);
        setUnreadTotal(unreadRes.unreadCount);
      }
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [fetchNotifications]);

  const handleMarkAllRead = async () => {
    await authFetch("/api/notifications/read-all", { method: "POST" });
    setUnreadNotifications([]);
    setUnreadTotal(0);
    setAllNotifications((prev) =>
      prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() }))
    );
    refreshNotifications();
  };

  const handleClickNotification = async (notification: Notification) => {
    // Mark as read if unread
    if (!notification.readAt) {
      authFetch(`/api/notifications/${notification.uuid}/read`, { method: "PATCH" });
      setUnreadNotifications((prev) => prev.filter((n) => n.uuid !== notification.uuid));
      setAllNotifications((prev) =>
        prev.map((n) =>
          n.uuid === notification.uuid ? { ...n, readAt: new Date().toISOString() } : n
        )
      );
      refreshNotifications();
    }
    onClose();
    router.push(getEntityPath(notification));
  };

  const loadMore = async (unreadOnly: boolean) => {
    const current = unreadOnly ? unreadNotifications : allNotifications;
    const res = await fetchNotifications(unreadOnly, current.length);
    if (!res) return;
    if (unreadOnly) {
      setUnreadNotifications((prev) => [...prev, ...res.notifications]);
    } else {
      setAllNotifications((prev) => [...prev, ...res.notifications]);
    }
  };

  const renderItem = (notification: Notification) => {
    const { Icon, color } = getTypeIcon(notification.action);
    const projectColor = hashProjectColor(notification.projectUuid);
    const isUnread = !notification.readAt;

    return (
      <motion.div key={notification.uuid} variants={staggerItem}>
      <button
        onClick={() => handleClickNotification(notification)}
        className="flex w-full gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors border-b border-border last:border-b-0"
      >
        {/* Unread dot */}
        <div className="mt-1.5 flex-shrink-0">
          {isUnread ? (
            <div className="h-2 w-2 rounded-full bg-[#C67A52]" />
          ) : (
            <div className="h-2 w-2" />
          )}
        </div>

        {/* Type icon */}
        <div className="mt-0.5 flex-shrink-0">
          <Icon className={`h-4 w-4 ${color}`} />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Project badge */}
          <Badge
            variant="secondary"
            className={`mb-1 px-1.5 py-0 text-[10px] font-medium ${projectColor.bg} ${projectColor.text} border-0`}
          >
            {notification.projectName}
          </Badge>

          {/* Title + action */}
          <div className="text-[13px] font-medium text-foreground truncate">
            {notification.entityTitle}
          </div>
          <div className="text-[12px] text-muted-foreground truncate">
            {t(`types.${notification.action}` as Parameters<typeof t>[0])}
          </div>

          {/* Actor + time */}
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {notification.actorName} &middot; {relativeTime(notification.createdAt)}
          </div>
        </div>
      </button>
      </motion.div>
    );
  };

  const renderList = (rawItems: Notification[], isUnread: boolean, total: number) => {
    const items = filterDisplayable(rawItems);
    if (loading) {
      return (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          {t("loadMore")}...
        </div>
      );
    }

    if (items.length === 0) {
      return (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          {isUnread ? t("noUnread") : t("noNotifications")}
        </div>
      );
    }

    return (
      <>
        <motion.div initial="initial" animate="animate" transition={{ staggerChildren: 0.04 }}>
          {items.map(renderItem)}
        </motion.div>
        {items.length < total && (
          <div className="p-3 text-center">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => loadMore(isUnread)}
            >
              {t("loadMore")}
            </Button>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="w-[calc(100vw-2rem)] max-w-[360px]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">{t("title")}</h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto p-0 text-xs text-primary hover:text-primary/80"
          onClick={handleMarkAllRead}
        >
          {t("markAllRead")}
        </Button>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="unread" className="gap-0">
        <TabsList className="w-full rounded-none border-b border-border bg-transparent px-4 py-0 h-9">
          <TabsTrigger value="unread" className="text-xs rounded-none data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary">
            {t("tabUnread")} {unreadTotal > 0 && `(${unreadTotal})`}
          </TabsTrigger>
          <TabsTrigger value="all" className="text-xs rounded-none data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary">
            {t("tabAll")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="mt-0">
          <motion.div
            key="tab-all"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
          >
            <ScrollArea className="max-h-[400px] overflow-y-auto">
              {renderList(allNotifications, false, allTotal)}
            </ScrollArea>
          </motion.div>
        </TabsContent>

        <TabsContent value="unread" className="mt-0">
          <motion.div
            key="tab-unread"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
          >
            <ScrollArea className="max-h-[400px] overflow-y-auto">
              {renderList(unreadNotifications, true, unreadTotal)}
            </ScrollArea>
          </motion.div>
        </TabsContent>
      </Tabs>

      {/* Footer */}
      <div className="border-t border-border px-4 py-2 text-center">
        <Link
          href="/settings"
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t("notificationPreferences")}
        </Link>
      </div>
    </div>
  );
}
