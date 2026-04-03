"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  CheckCircle2,
  XCircle,
  MessageSquare,
  UserCheck,
  Send,
  RefreshCw,
  AtSign,
} from "lucide-react";
import { authFetch } from "@/lib/auth-client";

function getToastIcon(action: string) {
  switch (action) {
    case "task_assigned":
    case "idea_claimed":
      return <UserCheck className="h-4 w-4 text-[#C67A52]" />;
    case "proposal_approved":
    case "task_verified":
      return <CheckCircle2 className="h-4 w-4 text-green-600" />;
    case "proposal_rejected":
    case "task_reopened":
      return <XCircle className="h-4 w-4 text-red-500" />;
    case "comment_added":
      return <MessageSquare className="h-4 w-4 text-orange-500" />;
    case "mentioned":
      return <AtSign className="h-4 w-4 text-blue-600" />;
    case "proposal_submitted":
      return <Send className="h-4 w-4 text-blue-500" />;
    case "task_status_changed":
      return <RefreshCw className="h-4 w-4 text-blue-500" />;
    default:
      return <Send className="h-4 w-4 text-muted-foreground" />;
  }
}

interface NotificationContextType {
  unreadCount: number;
  refreshNotifications: () => void;
}

const NotificationContext = createContext<NotificationContextType | null>(null);

interface NotificationProviderProps {
  children: ReactNode;
}

// Hidden actions that should not trigger a toast
const TOAST_HIDDEN_ACTIONS = new Set(["agent_checkin"]);

function getEntityPath(entityType: string, entityUuid: string, projectUuid: string): string {
  const base = `/projects/${projectUuid}`;
  switch (entityType) {
    case "task": return `${base}/tasks/${entityUuid}`;
    case "idea": return `${base}/ideas/${entityUuid}`;
    case "proposal": return `${base}/proposals/${entityUuid}`;
    case "document": return `${base}/documents/${entityUuid}`;
    default: return base;
  }
}

export function NotificationProvider({ children }: NotificationProviderProps) {
  const [unreadCount, setUnreadCount] = useState(0);
  const subscribersRef = useRef<Set<() => void>>(new Set());
  const router = useRouter();
  const t = useTranslations("notifications");

  const notify = useCallback(() => {
    subscribersRef.current.forEach((cb) => cb());
  }, []);

  // Fetch initial unread count from REST API
  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await authFetch("/api/notifications?readFilter=unread&take=0");
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setUnreadCount(data.data.unreadCount);
        }
      }
    } catch {
      // Silently fail — will retry on next SSE event or visibility change
    }
  }, []);

  const refreshNotifications = useCallback(() => {
    fetchUnreadCount();
    notify();
  }, [fetchUnreadCount, notify]);

  const showToast = useCallback(
    (data: {
      action?: string;
      actorName?: string;
      entityTitle?: string;
      entityType?: string;
      entityUuid?: string;
      projectUuid?: string;
    }) => {
      if (!data.action || TOAST_HIDDEN_ACTIONS.has(data.action)) return;
      if (!data.entityTitle || !data.actorName) return;

      const actionLabel = t(`types.${data.action}` as Parameters<typeof t>[0]);
      const title = data.entityTitle;
      const description = `${data.actorName} · ${actionLabel}`;

      toast(title, {
        description,
        icon: getToastIcon(data.action!),
        duration: 5000,
        action:
          data.entityType && data.entityUuid && data.projectUuid
            ? {
                label: t("viewDetail"),
                onClick: () =>
                  router.push(
                    getEntityPath(data.entityType!, data.entityUuid!, data.projectUuid!)
                  ),
              }
            : undefined,
      });
    },
    [t, router]
  );

  useEffect(() => {
    let es: EventSource | null = null;
    let debounceTimer: NodeJS.Timeout;

    function connect() {
      disconnect();
      es = new EventSource("/api/events/notifications");

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (typeof data.unreadCount === "number") {
            setUnreadCount(data.unreadCount);
          }
          if (data.type === "new_notification") {
            showToast(data);
          }
        } catch {
          // Ignore parse errors
        }
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(notify, 300);
      };

      es.onerror = () => {
        // Browser EventSource auto-reconnects on error
      };
    }

    function disconnect() {
      if (es) {
        es.close();
        es = null;
      }
    }

    function handleVisibility() {
      if (document.visibilityState === "visible") {
        connect();
        fetchUnreadCount();
      } else {
        disconnect();
      }
    }

    // Initial connection and data fetch
    connect();
    fetchUnreadCount();

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disconnect();
      clearTimeout(debounceTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchUnreadCount, notify, showToast]);

  const contextValue = useMemo(
    () => ({ unreadCount, refreshNotifications }),
    [unreadCount, refreshNotifications]
  );

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
    </NotificationContext.Provider>
  );
}

/**
 * Access notification context (unreadCount + refreshNotifications).
 * Returns null values gracefully if called outside NotificationProvider.
 */
export function useNotification() {
  const context = useContext(NotificationContext);
  if (!context) {
    return { unreadCount: 0, refreshNotifications: () => {} };
  }
  return context;
}
