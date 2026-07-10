"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { updateTaskStatusAction } from "./actions";

const statusOrder = ["open", "assigned", "in_progress", "to_verify", "done"];

const statusI18nKeys: Record<string, string> = {
  open: "status.open",
  assigned: "status.assigned",
  in_progress: "status.inProgress",
  to_verify: "status.toVerify",
  done: "status.done",
};

interface TaskStatusProgressProps {
  taskUuid: string;
  currentStatus: string;
}

export function TaskStatusProgress({ taskUuid, currentStatus }: TaskStatusProgressProps) {
  const t = useTranslations();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const currentIndex = statusOrder.indexOf(currentStatus);

  const handleStatusChange = (newStatus: string) => {
    startTransition(async () => {
      const result = await updateTaskStatusAction(taskUuid, newStatus);
      if (result.success) {
        router.refresh();
      }
    });
  };

  return (
    <Card className="border-border p-6">
      <h2 className="mb-4 text-lg font-medium text-foreground">{t("tasks.statusProgress")}</h2>
      <div className="flex items-center justify-between">
        {statusOrder.map((status, index) => {
          const isActive = index === currentIndex;
          const isComplete = index < currentIndex;

          return (
            <div key={status} className="flex flex-1 items-center">
              <button
                onClick={() => handleStatusChange(status)}
                disabled={isPending}
                className={`flex flex-col items-center ${
                  isActive || isComplete ? "cursor-pointer" : "cursor-pointer opacity-50"
                }`}
              >
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full ${
                    isActive
                      ? "bg-primary text-white"
                      : isComplete
                      ? "bg-[#5A9E6F] text-white"
                      : "border-2 border-border text-[#9A9A9A]"
                  }`}
                >
                  {isComplete ? (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-4 w-4"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <span className="text-xs font-medium">{index + 1}</span>
                  )}
                </div>
                <span className="mt-2 text-xs font-medium text-muted-foreground">
                  {t(statusI18nKeys[status] || status)}
                </span>
              </button>
              {index < statusOrder.length - 1 && (
                <div
                  className={`mx-2 h-0.5 flex-1 ${
                    index < currentIndex ? "bg-[#5A9E6F]" : "bg-border"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
