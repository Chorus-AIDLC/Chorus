"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Bot, User, Loader2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { formatCwd, formatHost } from "@/lib/daemon-instance-format";
import {
  claimIdeaAction,
  claimIdeaToAgentAction,
  claimIdeaToUserAction,
  releaseIdeaAction,
  getPmAgentsAction,
  getAgentInstancesAction,
} from "./[ideaUuid]/actions";

interface Idea {
  uuid: string;
  title: string;
  content: string | null;
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

interface AssignIdeaModalProps {
  idea: Idea;
  projectUuid: string;
  currentUserUuid: string;
  onClose: () => void;
}

type AssignOption = "self" | "agent" | "user" | "release";

export function AssignIdeaModal({
  idea,
  projectUuid,
  currentUserUuid,
  onClose,
}: AssignIdeaModalProps) {
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

  // The selected agent's ONLINE (host, cwd) daemon instances for the idea-root
  // pin. The idea is the authoritative pin ROOT — pinning it cascades to the
  // proposal/tasks/wakes of the same agent. Only online instances are pinnable
  // (an offline instance is not a wake target), so the picker is filtered to
  // online; a fully-offline agent yields no picker and assigns the plain agent.
  const [instances, setInstances] = useState<InstanceCandidate[]>([]);
  const [isLoadingInstances, setIsLoadingInstances] = useState(false);
  const [pinnedConnectionUuid, setPinnedConnectionUuid] = useState<string | null>(
    null,
  );

  const isAssigned = !!idea.assignee;

  // Load PM agents and users
  useEffect(() => {
    async function loadData() {
      setIsLoadingData(true);
      const result = await getPmAgentsAction();
      setAgents(result.agents || []);
      setUsers((result.users || []).filter((u: CompanyUser) => u.uuid !== currentUserUuid));
      setIsLoadingData(false);
    }
    loadData();
  }, [currentUserUuid]);

  // Load the selected agent's daemon instances whenever the agent changes (and
  // the agent option is active). Resets the pin so a stale (host, cwd) from a
  // previously-selected agent never leaks across agents (the re-assign path:
  // agent → different agent re-loads the new agent's instances).
  useEffect(() => {
    if (selectedOption !== "agent" || !selectedAgentUuid) {
      setInstances([]);
      setPinnedConnectionUuid(null);
      return;
    }
    let cancelled = false;
    setIsLoadingInstances(true);
    setPinnedConnectionUuid(null);
    getAgentInstancesAction(selectedAgentUuid)
      .then((res) => {
        if (cancelled) return;
        // Online-only: an offline instance is not a wake target, so it never
        // appears in the picker. A fully-offline agent yields [] → no picker.
        setInstances(filterOnlineInstances(res.instances));
      })
      .finally(() => {
        if (!cancelled) setIsLoadingInstances(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedOption, selectedAgentUuid]);

  // The instance the owner pinned, resolved from the controlled connectionUuid.
  // null → "inherit / plain agent" (revert-to-plain-agent is simply no pin).
  const pinnedInstance =
    instances.find((i) => i.connectionUuid === pinnedConnectionUuid) ?? null;
  // Host is included in a target confirmation only when it disambiguates — i.e.
  // the agent's instances span 2+ distinct hosts (same rule as the picker rows).
  const isMultiHost = new Set(instances.map((i) => i.host)).size > 1;

  // The CTA label names the resolved (path · host) of the pinned online instance;
  // host only when it disambiguates (2+ hosts). No pin → the plain "Assign" label.
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
      result = await claimIdeaAction(idea.uuid);
    } else if (selectedOption === "agent" && selectedAgentUuid) {
      // Thread the DURABLE AgentInstance pin when the owner picked one — no pin
      // (revert-to-plain-agent / inherit) → undefined assigns the plain agent.
      result = await claimIdeaToAgentAction(
        idea.uuid,
        selectedAgentUuid,
        pinnedInstance?.agentInstanceUuid ?? undefined,
      );
    } else if (selectedOption === "user" && selectedUserUuid) {
      result = await claimIdeaToUserAction(idea.uuid, selectedUserUuid);
    } else if (selectedOption === "release") {
      result = await releaseIdeaAction(idea.uuid);
    } else {
      setIsLoading(false);
      return;
    }

    setIsLoading(false);
    if (result?.success) {
      router.refresh();
      onClose();
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
      className="bg-white sm:max-w-[400px]"
      header={
        <ScrollableDialogTitle className="text-base font-semibold text-[#2C2C2C]">
          {t("ideas.assignIdea")}
        </ScrollableDialogTitle>
      }
      footer={
        <div className="flex w-full items-center justify-end gap-4">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isLoading}
            className="border-[#E5E0D8]"
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isLoading || !canSubmit}
            className="bg-[#C67A52] hover:bg-[#B56A42] text-white"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : selectedOption === "release" ? (
              t("common.release")
            ) : (
              // When an instance is pinned the CTA names the resolved (path · host)
              // target; otherwise the plain label.
              resolvePinLabel()
            )}
          </Button>
        </div>
      }
      bodyClassName="space-y-4"
    >
      {/* Body */}
      {/* Idea Info */}
          <div className="rounded-lg bg-[#FAF8F4] p-3">
            <p className="text-[13px] font-medium text-[#2C2C2C]">{idea.title}</p>
            {idea.content && (
              <p className="mt-1 text-[11px] text-[#6B6B6B] line-clamp-2">
                {idea.content}
              </p>
            )}
          </div>

          {/* Current Assignee (if assigned) */}
          {isAssigned && (
            <div className="rounded-lg bg-[#E3F2FD] p-3">
              <p className="text-xs text-[#1976D2]">
                {t("common.currentAssignee")}: <span className="font-medium">{idea.assignee?.name}</span>
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-[#FEE2E2] p-3">
              <p className="text-xs text-[#D32F2F]">{error}</p>
            </div>
          )}

          <p className="text-[13px] text-[#6B6B6B]">
            {t("ideas.selectIdeaAssignee")}
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
                    ? "bg-[#FDF8F6] border-2 border-[#C67A52]"
                    : "bg-white border border-[#E5E0D8] hover:border-[#C67A52]/50"
                }`}
                onClick={() => setSelectedOption("self")}
              >
                <div className="flex items-center gap-2.5">
                  <RadioGroupItem value="self" id="idea-self" className="border-[#C67A52] text-[#C67A52]" />
                  <Label htmlFor="idea-self" className="text-sm font-medium text-[#2C2C2C] cursor-pointer">
                    {t("assign.assignToMyself")}
                  </Label>
                </div>
                <p className="mt-2 ml-6 text-xs text-[#6B6B6B] leading-relaxed">
                  {t("ideas.assignToMyselfIdeaDesc")}
                </p>
              </div>

              {/* Option 2: Assign to specific PM Agent */}
              <div
                className={`rounded-[10px] p-4 transition-colors ${
                  selectedOption === "agent"
                    ? "bg-[#FDF8F6] border-2 border-[#C67A52]"
                    : "bg-white border border-[#E5E0D8]"
                }`}
              >
                <div
                  className="flex items-center gap-2.5 cursor-pointer"
                  onClick={() => setSelectedOption("agent")}
                >
                  <RadioGroupItem value="agent" id="idea-agent" className="border-[#C67A52] text-[#C67A52]" />
                  <Label htmlFor="idea-agent" className="text-sm font-medium text-[#2C2C2C] cursor-pointer">
                    {t("ideas.orAssignToPmAgent")}
                  </Label>
                </div>
                <p className="mt-2 ml-6 text-xs text-[#6B6B6B] leading-relaxed">
                  {t("ideas.onlySelectedPmAgentCanWork")}
                </p>

                {selectedOption === "agent" && (
                  <div className="mt-3 ml-6 space-y-3">
                    <Select
                      value={selectedAgentUuid}
                      onValueChange={setSelectedAgentUuid}
                    >
                      <SelectTrigger className="w-full border-[#E5E0D8]">
                        <SelectValue placeholder={t("ideas.selectPmAgent")} />
                      </SelectTrigger>
                      <SelectContent className="z-[120]">
                        {agents.length > 0 ? (
                          agents.map((agent) => (
                            <SelectItem key={agent.uuid} value={agent.uuid}>
                              <div className="flex items-center gap-2">
                                <Bot className="h-4 w-4 text-[#C67A52]" />
                                <span>{agent.name}</span>
                              </div>
                            </SelectItem>
                          ))
                        ) : (
                          <div className="px-3 py-2 text-xs text-[#9A9A9A]">
                            {t("ideas.noPmAgentsAvailable")}
                          </div>
                        )}
                      </SelectContent>
                    </Select>

                    {/* Idea-root instance pin (the authoritative pin root for the
                        whole conversation). ONLINE-only: an offline instance is
                        not a wake target, so it is filtered out and never shown. A
                        fully-offline agent yields no instances → no picker; the
                        idea is assigned to the plain agent with no pin (the same
                        path that reverts an instance-pinned idea back to a plain
                        agent). The picker is a SECONDARY menu under the agent
                        select — leaving it unselected keeps the plain agent. */}
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
                        ) : instances.length === 0 ? (
                          <p className="rounded-lg bg-[#FAF8F4] p-2.5 text-[11px] leading-relaxed text-[#6B6B6B]">
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
                        <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[#9A8C7E]">
                          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                          <span>{t("assignInstance.ideaPinNote")}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Option 3: Assign to another user */}
              <div
                className={`rounded-[10px] p-4 transition-colors ${
                  selectedOption === "user"
                    ? "bg-[#FDF8F6] border-2 border-[#C67A52]"
                    : "bg-white border border-[#E5E0D8]"
                }`}
              >
                <div
                  className="flex items-center gap-2.5 cursor-pointer"
                  onClick={() => setSelectedOption("user")}
                >
                  <RadioGroupItem value="user" id="idea-user" className="border-[#C67A52] text-[#C67A52]" />
                  <Label htmlFor="idea-user" className="text-sm font-medium text-[#2C2C2C] cursor-pointer">
                    {t("assign.orAssignToUser")}
                  </Label>
                </div>

                {selectedOption === "user" && (
                  <div className="mt-3 ml-6">
                    <Select
                      value={selectedUserUuid}
                      onValueChange={setSelectedUserUuid}
                    >
                      <SelectTrigger className="w-full border-[#E5E0D8]">
                        <SelectValue placeholder={t("tasks.selectUser")} />
                      </SelectTrigger>
                      <SelectContent className="z-[120]">
                        {users.length > 0 ? (
                          users.map((user) => (
                            <SelectItem key={user.uuid} value={user.uuid}>
                              <div className="flex items-center gap-2">
                                <User className="h-4 w-4 text-[#6B6B6B]" />
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
                      ? "bg-[#FDF8F6] border-2 border-[#C67A52]"
                      : "bg-white border border-[#E5E0D8] hover:border-[#C67A52]/50"
                  }`}
                  onClick={() => setSelectedOption("release")}
                >
                  <div className="flex items-center gap-2.5">
                    <RadioGroupItem value="release" id="idea-release" className="border-[#C67A52] text-[#C67A52]" />
                    <Label htmlFor="idea-release" className="text-sm font-medium text-[#2C2C2C] cursor-pointer">
                      {t("assign.releaseAssignee")}
                    </Label>
                  </div>
                  <p className="mt-2 ml-6 text-xs text-[#6B6B6B] leading-relaxed">
                    {t("ideas.releaseIdeaAssigneeDesc")}
                  </p>
                </div>
              )}
            </RadioGroup>
          )}
    </ScrollableDialog>
  );
}
