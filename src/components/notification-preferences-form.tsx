"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { clientLogger } from "@/lib/logger-client";

interface NotificationPreferences {
  taskAssigned: boolean;
  taskStatusChanged: boolean;
  taskVerified: boolean;
  taskReopened: boolean;
  proposalSubmitted: boolean;
  proposalApproved: boolean;
  proposalRejected: boolean;
  ideaClaimed: boolean;
  commentAdded: boolean;
  elaborationRequested: boolean;
  elaborationAnswered: boolean;
  mentioned: boolean;
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  taskAssigned: true,
  taskStatusChanged: true,
  taskVerified: true,
  taskReopened: true,
  proposalSubmitted: true,
  proposalApproved: true,
  proposalRejected: true,
  ideaClaimed: true,
  commentAdded: true,
  elaborationRequested: true,
  elaborationAnswered: true,
  mentioned: true,
};

type PreferenceKey = keyof NotificationPreferences;

interface PreferenceGroup {
  labelKey: string;
  items: { key: PreferenceKey; labelKey: string }[];
}

const PREFERENCE_GROUPS: PreferenceGroup[] = [
  {
    labelKey: "taskEvents",
    items: [
      { key: "taskAssigned", labelKey: "taskAssigned" },
      { key: "taskStatusChanged", labelKey: "taskStatusChanged" },
      { key: "taskVerified", labelKey: "taskVerified" },
      { key: "taskReopened", labelKey: "taskReopened" },
    ],
  },
  {
    labelKey: "proposalEvents",
    items: [
      { key: "proposalSubmitted", labelKey: "proposalSubmitted" },
      { key: "proposalApproved", labelKey: "proposalApproved" },
      { key: "proposalRejected", labelKey: "proposalRejected" },
    ],
  },
  {
    labelKey: "ideaEvents",
    items: [{ key: "ideaClaimed", labelKey: "ideaClaimed" }],
  },
  {
    labelKey: "elaborationEvents",
    items: [
      { key: "elaborationRequested", labelKey: "elaborationRequested" },
      { key: "elaborationAnswered", labelKey: "elaborationAnswered" },
    ],
  },
  {
    labelKey: "commentEvents",
    items: [{ key: "commentAdded", labelKey: "commentAdded" }],
  },
  {
    labelKey: "mentionEvents",
    items: [{ key: "mentioned", labelKey: "mentioned" }],
  },
];

export function NotificationPreferencesForm() {
  const t = useTranslations("notifications.preferences");
  const [preferences, setPreferences] =
    useState<NotificationPreferences>(DEFAULT_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    async function fetchPreferences() {
      try {
        const res = await fetch("/api/notifications/preferences");
        if (res.ok) {
          const json = await res.json();
          if (json.success && json.data) {
            const {
              taskAssigned,
              taskStatusChanged,
              taskVerified,
              taskReopened,
              proposalSubmitted,
              proposalApproved,
              proposalRejected,
              ideaClaimed,
              commentAdded,
              elaborationRequested,
              elaborationAnswered,
              mentioned,
            } = json.data;
            setPreferences({
              taskAssigned,
              taskStatusChanged,
              taskVerified,
              taskReopened,
              proposalSubmitted,
              proposalApproved,
              proposalRejected,
              ideaClaimed,
              commentAdded,
              elaborationRequested: elaborationRequested ?? true,
              elaborationAnswered: elaborationAnswered ?? true,
              mentioned: mentioned ?? true,
            });
          }
        }
      } catch (error) {
        clientLogger.error("Failed to fetch notification preferences:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchPreferences();
  }, []);

  const savePreferences = useCallback(
    (updated: NotificationPreferences) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(async () => {
        try {
          await fetch("/api/notifications/preferences", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updated),
          });
        } catch (error) {
          clientLogger.error("Failed to save notification preferences:", error);
        }
      }, 500);
    },
    []
  );

  const handleToggle = (key: PreferenceKey, checked: boolean) => {
    const updated = { ...preferences, [key]: checked };
    setPreferences(updated);
    savePreferences(updated);
  };

  if (loading) {
    return null;
  }

  return (
    <div className="space-y-6">
      {PREFERENCE_GROUPS.map((group) => (
        <div key={group.labelKey} className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">
            {t(group.labelKey)}
          </h3>
          <div className="space-y-3">
            {group.items.map((item) => (
              <div
                key={item.key}
                className="flex items-center justify-between"
              >
                <Label
                  htmlFor={item.key}
                  className="text-sm text-muted-foreground cursor-pointer"
                >
                  {t(item.labelKey)}
                </Label>
                <Switch
                  id={item.key}
                  checked={preferences[item.key]}
                  onCheckedChange={(checked) =>
                    handleToggle(item.key, checked)
                  }
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
