"use client";

import { useTranslations } from "next-intl";
import { Bot } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Label } from "@/components/ui/label";
import { AssigneeInstanceLine } from "@/components/agent-presence";
import { isAgentAssignee } from "@/lib/assignee-identity";

interface AssigneeSectionProps {
  assignee: {
    type: string;
    uuid: string;
    name: string;
    // Present only when type === "agent_instance": the pinned (host, cwd) place.
    instance?: { agentUuid: string; host: string; cwd: string | null };
  } | null;
}

export function AssigneeSection({ assignee }: AssigneeSectionProps) {
  const tCommon = useTranslations("common");

  return (
    <div>
      <Label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
        {tCommon("assignee")}
      </Label>
      <div className="mt-2 flex items-center gap-2.5 rounded-lg bg-[#FAF8F4] p-3">
        {assignee ? (
          <>
            <Avatar className="h-7 w-7">
              <AvatarFallback
                className={
                  isAgentAssignee(assignee)
                    ? "bg-[#C67A52] text-white"
                    : "bg-[#E5E0D8] text-[#6B6B6B]"
                }
              >
                {isAgentAssignee(assignee) ? (
                  <Bot className="h-3.5 w-3.5" />
                ) : (
                  assignee.name.charAt(0).toUpperCase()
                )}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="text-sm font-medium text-[#2C2C2C]">
                {assignee.name}
              </div>
              <div className="text-xs text-[#6B6B6B]">
                {isAgentAssignee(assignee)
                  ? tCommon("agent")
                  : tCommon("user")}
              </div>
              {/* Pinned (host, cwd) place for an agent_instance assignee. */}
              {assignee.type === "agent_instance" && assignee.instance && (
                <div className="mt-1">
                  <AssigneeInstanceLine
                    cwd={assignee.instance.cwd}
                    host={assignee.instance.host}
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          <span className="text-sm text-[#9A9A9A]">
            {tCommon("unassigned")}
          </span>
        )}
      </div>
    </div>
  );
}
