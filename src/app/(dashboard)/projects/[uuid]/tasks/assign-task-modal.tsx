"use client";

import { useState, useEffect } from "react";
import { useRouter } from "@/hooks/use-progress-router";
import { useTranslations } from "next-intl";
import { User, Loader2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import {
  ScrollableDialog,
  ScrollableDialogTitle,
} from "@/components/ui/scrollable-dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  InstancePicker,
  filterOnlineInstances,
  type InstanceCandidate,
} from "@/components/agent-presence/instance-picker";
import {
  formatCwd,
  formatHost,
} from "@/lib/daemon-instance-format";
import { FixedCwdAnchor } from "@/components/agent-presence/fixed-cwd-anchor";
import type { ResolvedProjectAgentCwdTarget } from "@/services/project-agent-cwd.service";
import {
  claimTaskAction,
  claimTaskToAgentAction,
  claimTaskToUserAction,
  releaseTaskAction,
  getDeveloperAgentsAction,
  getAgentInstancesAction,
} from "./[taskUuid]/actions";

interface Task {
  uuid: string;
  title: string;
  description: string | null;
  status: string;
  assignee: {
    type: string;
    uuid: string;
    name: string;
  } | null;
}

interface Agent {
  uuid: string;
  name: string;
  roles: string[];
  ownerUuid: string | null;
}

interface CompanyUser {
  uuid: string;
  name: string | null;
  email: string | null;
}

interface AssignTaskModalProps {
  task: Task;
  projectUuid: string;
  currentUserUuid: string;
  onClose: () => void;
}

type AssignOption = "self" | "agent" | "user" | "release";

export function AssignTaskModal({
  task,
  projectUuid,
  currentUserUuid,
  onClose,
}: AssignTaskModalProps) {
  const t = useTranslations();
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [selectedOption, setSelectedOption] = useState<AssignOption>("self");
  const [selectedAgentUuid, setSelectedAgentUuid] = useState<string>("");
  const [selectedUserUuid, setSelectedUserUuid] = useState<string>("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The selected agent's ONLINE (host, cwd) daemon instances for the optional
  // override pin. Default = inherit the root idea (a plain agent assignment, no
  // instance). Only online instances are pinnable — an offline instance is not a
  // wake target, so it is filtered out (a fully-offline agent shows no picker and
  // just assigns plainly, inheriting the root idea's instance via wake lineage).
  const [instances, setInstances] = useState<InstanceCandidate[]>([]);
  const [isLoadingInstances, setIsLoadingInstances] = useState(false);
  const [resolvedTarget, setResolvedTarget] =
    useState<ResolvedProjectAgentCwdTarget | null>(null);
  const [pinnedConnectionUuid, setPinnedConnectionUuid] = useState<string | null>(
    null,
  );

  const isAssigned = !!task.assignee;

  // Load agents and users
  useEffect(() => {
    async function loadData() {
      setIsLoadingData(true);
      const result = await getDeveloperAgentsAction();
      setAgents(result.agents || []);
      setUsers((result.users || []).filter((u: CompanyUser) => u.uuid !== currentUserUuid));
      setIsLoadingData(false);
    }
    loadData();
  }, [currentUserUuid]);

  // All developer agents in the company are available for assignment

  // Load the selected agent's daemon instances whenever the agent changes (and
  // the agent option is active). Resets the pin so a stale (host, cwd) from a
  // previously-selected agent never leaks across agents.
  useEffect(() => {
    if (selectedOption !== "agent" || !selectedAgentUuid) {
      setInstances([]);
      setPinnedConnectionUuid(null);
      setResolvedTarget(null);
      return;
    }
    let cancelled = false;
    setIsLoadingInstances(true);
    setPinnedConnectionUuid(null);
    getAgentInstancesAction(selectedAgentUuid, projectUuid)
      .then((res) => {
        if (cancelled) return;
        // Online-only: an offline instance is not a wake target, so it never
        // appears in the picker. A fully-offline agent yields [] → no picker.
        setInstances(filterOnlineInstances(res.instances));
        setResolvedTarget(res.resolvedTarget);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingInstances(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectUuid, selectedOption, selectedAgentUuid]);

  // The instance the owner pinned, resolved from the controlled connectionUuid.
  const pinnedInstance =
    instances.find((i) => i.connectionUuid === pinnedConnectionUuid) ?? null;
  // Host is included in a target confirmation only when it disambiguates — i.e.
  // the agent's instances span 2+ distinct hosts (same rule as the picker rows).
  const isMultiHost = new Set(instances.map((i) => i.host)).size > 1;

  // The CTA label / footer confirmation names the resolved (path · host) of the
  // pinned online instance; host only when it disambiguates (2+ hosts).
  function resolvePinLabel(): string {
    if (selectedOption !== "agent" || !pinnedInstance) {
      return t("common.assign");
    }
    const cwd = formatCwd(pinnedInstance.cwd);
    const pathLabel = cwd.isUnknown ? t(cwd.label) : cwd.label;
    const host = formatHost(pinnedInstance.host);
    const hostLabel = host.isUnknown ? t(host.label) : host.label;
    if (isMultiHost) {
      return t("assignInstance.assignToWithHost", {
        path: pathLabel,
        host: hostLabel,
      });
    }
    return t("assignInstance.assignTo", { path: pathLabel });
  }

  const handleSubmit = async () => {
    setIsLoading(true);
    setError(null);
    let result;

    if (selectedOption === "self") {
      result = await claimTaskAction(task.uuid);
    } else if (selectedOption === "agent" && selectedAgentUuid) {
      // Thread the DURABLE AgentInstance pin when the owner picked one — the
      // stable pointer that survives a daemon restart, NOT the ephemeral
      // connectionUuid. No pin (default = inherit root idea) → undefined, which
      // assigns the plain agent and lets wake lineage inherit the idea's instance.
      result = await claimTaskToAgentAction(
        task.uuid,
        selectedAgentUuid,
        pinnedInstance?.agentInstanceUuid ?? undefined,
      );
    } else if (selectedOption === "user" && selectedUserUuid) {
      result = await claimTaskToUserAction(task.uuid, selectedUserUuid);
    } else if (selectedOption === "release") {
      result = await releaseTaskAction(task.uuid);
    } else {
      setIsLoading(false);
      return;
    }

    setIsLoading(false);
    if (result?.success) {
      onClose();
      router.refresh();
    } else if (result?.error) {
      setError(result.error);
    }
  };

  const canSubmit =
    selectedOption === "self" ||
    (selectedOption === "agent" && selectedAgentUuid) ||
    (selectedOption === "user" && selectedUserUuid) ||
    (selectedOption === "release" && isAssigned);

  return (
    // Mobile-safe shell: ScrollableDialog (shadcn Dialog) keeps the title and the
    // footer Cancel/Assign pinned and the body scrollable within a dynamic-viewport
    // height cap. Conditionally mounted by the parent (no `open` prop there), so we
    // render it always-open and route every close path back to onClose.
    <ScrollableDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className="bg-card sm:max-w-[400px]"
      header={
        <ScrollableDialogTitle className="text-base font-semibold text-foreground">
          {t("tasks.assignTask")}
        </ScrollableDialogTitle>
      }
      footer={
        <div className="flex w-full items-center justify-end gap-4">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isLoading}
            className="border-border"
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isLoading || !canSubmit}
            className="bg-primary hover:bg-[#B56A42] text-white"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : selectedOption === "release" ? (
              t("common.release")
            ) : (
              // When an instance is pinned the CTA names the resolved (path · host)
              // target (cwd-addressable instances, T4); otherwise the plain label.
              resolvePinLabel()
            )}
          </Button>
        </div>
      }
      bodyClassName="space-y-4"
    >
      {/* Body */}
      {/* Task Info */}
          <div className="rounded-lg bg-background p-3">
            <p className="text-[13px] font-medium text-foreground">{task.title}</p>
            {task.description && (
              <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">
                {task.description}
              </p>
            )}
          </div>

          {/* Current Assignee (if assigned) */}
          {isAssigned && (
            <div className="rounded-lg bg-[#E3F2FD] dark:bg-[#13253a] p-3">
              <p className="text-xs text-[#1976D2] dark:text-[#5AA9F0]">
                {t("common.currentAssignee")}: <span className="font-medium">{task.assignee?.name}</span>
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-[#FEE2E2] dark:bg-[#331619] p-3">
              <p className="text-xs text-[#D32F2F] dark:text-[#F08078]">{error}</p>
            </div>
          )}

          <p className="text-[13px] text-muted-foreground">
            {t("assign.selectAssignee")}
          </p>

          {isLoadingData ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-[#9A9A9A]" />
            </div>
          ) : (
            <RadioGroup
              value={selectedOption}
              onValueChange={(value) => setSelectedOption(value as AssignOption)}
              className="space-y-3"
            >
              {/* Option 1: Assign to myself */}
              <div
                className={`rounded-[10px] p-4 transition-colors cursor-pointer ${
                  selectedOption === "self"
                    ? "bg-[#FDF8F6] dark:bg-[#201d1b] border-2 border-primary"
                    : "bg-card border border-border hover:border-primary/50"
                }`}
                onClick={() => setSelectedOption("self")}
              >
                <div className="flex items-center gap-2.5">
                  <RadioGroupItem value="self" id="self" className="border-primary text-primary" />
                  <Label htmlFor="self" className="text-sm font-medium text-foreground cursor-pointer">
                    {t("assign.assignToMyself")}
                  </Label>
                </div>
                <p className="mt-2 ml-6 text-xs text-muted-foreground leading-relaxed">
                  {t("assign.assignToMyselfDesc")}
                </p>
              </div>

              {/* Option 2: Assign to specific agent */}
              <div
                className={`rounded-[10px] p-4 transition-colors ${
                  selectedOption === "agent"
                    ? "bg-[#FDF8F6] dark:bg-[#201d1b] border-2 border-primary"
                    : "bg-card border border-border"
                }`}
              >
                <div
                  className="flex items-center gap-2.5 cursor-pointer"
                  onClick={() => setSelectedOption("agent")}
                >
                  <RadioGroupItem value="agent" id="agent" className="border-primary text-primary" />
                  <Label htmlFor="agent" className="text-sm font-medium text-foreground cursor-pointer">
                    {t("assign.orAssignToAgent")}
                  </Label>
                </div>
                <p className="mt-2 ml-6 text-xs text-muted-foreground leading-relaxed">
                  {t("tasks.onlySelectedAgentCanWork")}
                </p>

                {selectedOption === "agent" && (
                  <div className="mt-3 ml-6 space-y-3">
                    <Select
                      value={selectedAgentUuid}
                      onValueChange={setSelectedAgentUuid}
                    >
                      <SelectTrigger className="w-full border-border">
                        <SelectValue placeholder={t("tasks.selectAgent")} />
                      </SelectTrigger>
                      <SelectContent className="z-[120]">
                        {agents.length > 0 ? (
                          agents.map((agent) => (
                            <SelectItem key={agent.uuid} value={agent.uuid}>
                              <div className="flex items-center gap-2">
                                <AgentAvatar name={agent.name} size={16} className="rounded-full" />
                                <span>{agent.name}</span>
                              </div>
                            </SelectItem>
                          ))
                        ) : (
                          <div className="px-3 py-2 text-xs text-[#9A9A9A]">
                            {t("tasks.noAgentsAvailable")}
                          </div>
                        )}
                      </SelectContent>
                    </Select>

                    {/* Working-directory pin (cwd-addressable instances).
                        ONLINE-only: an offline instance is not a wake target, so
                        it is filtered out and never shown. A fully-offline agent
                        yields no instances → no picker; the task is assigned
                        plainly with no pin (a plain notification, no wake). */}
                    {selectedAgentUuid && (
                      <div className="space-y-2">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                          {t("assignInstance.workingDirectory")}
                        </span>
                        {isLoadingInstances ? (
                          <div className="flex items-center gap-2 py-2 text-xs text-[#9A9A9A]">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {t("assignInstance.loadingInstances")}
                          </div>
                        ) : resolvedTarget?.source === "project_fixed" ? (
                          <FixedCwdAnchor target={resolvedTarget} />
                        ) : instances.length === 0 ? (
                          <p className="rounded-lg bg-background p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                            {t("assignInstance.noInstances")}
                          </p>
                        ) : (
                          <InstancePicker
                            instances={instances}
                            selectedConnectionUuid={pinnedConnectionUuid}
                            onSelect={(inst) =>
                              setPinnedConnectionUuid(inst.connectionUuid)
                            }
                            ariaLabel={t("assignInstance.workingDirectory")}
                          />
                        )}
                        {resolvedTarget?.source !== "project_fixed" && (
                          <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[#9A8C7E]">
                            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                            <span>{t("assignInstance.pinNote")}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Option 3: Assign to another user */}
              <div
                className={`rounded-[10px] p-4 transition-colors ${
                  selectedOption === "user"
                    ? "bg-[#FDF8F6] dark:bg-[#201d1b] border-2 border-primary"
                    : "bg-card border border-border"
                }`}
              >
                <div
                  className="flex items-center gap-2.5 cursor-pointer"
                  onClick={() => setSelectedOption("user")}
                >
                  <RadioGroupItem value="user" id="user" className="border-primary text-primary" />
                  <Label htmlFor="user" className="text-sm font-medium text-foreground cursor-pointer">
                    {t("assign.orAssignToUser")}
                  </Label>
                </div>

                {selectedOption === "user" && (
                  <div className="mt-3 ml-6">
                    <Select
                      value={selectedUserUuid}
                      onValueChange={setSelectedUserUuid}
                    >
                      <SelectTrigger className="w-full border-border">
                        <SelectValue placeholder={t("tasks.selectUser")} />
                      </SelectTrigger>
                      <SelectContent className="z-[120]">
                        {users.length > 0 ? (
                          users.map((user) => (
                            <SelectItem key={user.uuid} value={user.uuid}>
                              <div className="flex items-center gap-2">
                                <User className="h-4 w-4 text-muted-foreground" />
                                <span>{user.name || user.email}</span>
                              </div>
                            </SelectItem>
                          ))
                        ) : (
                          <div className="px-3 py-2 text-xs text-[#9A9A9A]">
                            {t("tasks.noUsersAvailable")}
                          </div>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              {/* Option 4: Release (Clear Assignee) */}
              {isAssigned && (
                <div
                  className={`rounded-[10px] p-4 transition-colors cursor-pointer ${
                    selectedOption === "release"
                      ? "bg-[#FDF8F6] dark:bg-[#201d1b] border-2 border-primary"
                      : "bg-card border border-border hover:border-primary/50"
                  }`}
                  onClick={() => setSelectedOption("release")}
                >
                  <div className="flex items-center gap-2.5">
                    <RadioGroupItem value="release" id="release" className="border-primary text-primary" />
                    <Label htmlFor="release" className="text-sm font-medium text-foreground cursor-pointer">
                      {t("assign.releaseAssignee")}
                    </Label>
                  </div>
                  <p className="mt-2 ml-6 text-xs text-muted-foreground leading-relaxed">
                    {t("assign.releaseAssigneeDesc")}
                  </p>
                </div>
              )}
            </RadioGroup>
          )}
    </ScrollableDialog>
  );
}
