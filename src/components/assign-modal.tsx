"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/hooks/use-progress-router";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { User, Loader2 } from "lucide-react";

interface Agent {
  uuid: string;
  name: string;
  roles: string[];
  ownerUuid?: string | null;
}

interface CompanyUser {
  uuid: string;
  name: string | null;
  email: string | null;
}

interface AssignModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  agents: Agent[];
  users?: CompanyUser[];
  currentUserUuid?: string;
  onAssignToSelf: () => Promise<{ success: boolean; error?: string }>;
  onAssignToAgent: (agentUuid: string) => Promise<{ success: boolean; error?: string }>;
  onAssignToUser?: (userUuid: string) => Promise<{ success: boolean; error?: string }>;
}

export function AssignModal({
  open,
  onOpenChange,
  title,
  agents,
  users = [],
  currentUserUuid,
  onAssignToSelf,
  onAssignToAgent,
  onAssignToUser,
}: AssignModalProps) {
  const t = useTranslations();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selectedOption, setSelectedOption] = useState<string>("self");
  const [error, setError] = useState<string | null>(null);

  // Filter out current user from the users list
  const otherUsers = users.filter((u) => u.uuid !== currentUserUuid);

  const handleAssign = () => {
    setError(null);
    startTransition(async () => {
      try {
        let result;
        if (selectedOption === "self") {
          result = await onAssignToSelf();
        } else if (selectedOption.startsWith("user:") && onAssignToUser) {
          const userUuid = selectedOption.replace("user:", "");
          result = await onAssignToUser(userUuid);
        } else {
          result = await onAssignToAgent(selectedOption);
        }

        if (result.success) {
          onOpenChange(false);
          router.refresh();
        } else {
          setError(result.error || t("common.failedToAssign"));
        }
      } catch {
        setError(t("common.genericError"));
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t("assign.selectAssignee")}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <RadioGroup
          value={selectedOption}
          onValueChange={setSelectedOption}
          className="space-y-3 py-4"
        >
          {/* Assign to myself option (always first) */}
          <div
            className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
              selectedOption === "self"
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50"
            }`}
          >
            <RadioGroupItem value="self" id="assign-self" className="sr-only" />
            <Label
              htmlFor="assign-self"
              className="flex flex-1 cursor-pointer items-center gap-3"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                <User className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1">
                <div className="font-medium">{t("assign.assignToMyself")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("assign.assignToMyselfDesc")}
                </div>
              </div>
            </Label>
          </div>

          {/* Other users section */}
          {otherUsers.length > 0 && onAssignToUser && (
            <>
              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">
                    {t("assign.orAssignToUser")}
                  </span>
                </div>
              </div>

              {otherUsers.map((user) => (
                <div
                  key={user.uuid}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
                    selectedOption === `user:${user.uuid}`
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  <RadioGroupItem
                    value={`user:${user.uuid}`}
                    id={`assign-user-${user.uuid}`}
                    className="sr-only"
                  />
                  <Label
                    htmlFor={`assign-user-${user.uuid}`}
                    className="flex flex-1 cursor-pointer items-center gap-3"
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100">
                      <User className="h-5 w-5 text-blue-600" />
                    </div>
                    <div className="flex-1">
                      <div className="font-medium">{user.name || user.email}</div>
                      <div className="text-xs text-muted-foreground">
                        {user.email}
                      </div>
                    </div>
                  </Label>
                </div>
              ))}
            </>
          )}

          {/* Assign to specific agent options */}
          {agents.length > 0 && (
            <>
              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">
                    {t("assign.orAssignToAgent")}
                  </span>
                </div>
              </div>

              {agents.map((agent) => (
                <div
                  key={agent.uuid}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
                    selectedOption === agent.uuid
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  <RadioGroupItem
                    value={agent.uuid}
                    id={`assign-agent-${agent.uuid}`}
                    className="sr-only"
                  />
                  <Label
                    htmlFor={`assign-agent-${agent.uuid}`}
                    className="flex flex-1 cursor-pointer items-center gap-3"
                  >
                    <AgentAvatar name={agent.name} size={40} className="rounded-full" />
                    <div className="flex-1">
                      <div className="font-medium">{agent.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {agent.roles.join(", ")}
                      </div>
                    </div>
                  </Label>
                </div>
              ))}
            </>
          )}
        </RadioGroup>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleAssign} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("common.processing")}
              </>
            ) : (
              t("common.assign")
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
