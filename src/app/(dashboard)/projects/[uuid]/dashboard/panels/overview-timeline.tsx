"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations, useLocale } from "next-intl";
import {
  Check,
  Circle,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  FileText,
  ListChecks,
  Lightbulb,
  MessageSquareText,
  ClipboardList,
} from "lucide-react";
import { getElaborationAction } from "./actions";
import { formatRelativeTime, getTaskStatusDotColor, type FlatTask } from "../utils";
import type { ProposalData } from "./proposal-view";
import type { ElaborationResponse } from "@/types/elaboration";

interface OverviewTimelineProps {
  idea: {
    uuid: string;
    title: string;
    content: string | null;
    status: string;
    elaborationStatus?: string;
    createdBy: { type: string; uuid: string; name: string } | null;
    createdAt: string;
    derivedStatus: string;
    badgeHint: string | null;
  };
  proposals: ProposalData[];
  tasks: FlatTask[];
  onSelectTask: (taskUuid: string) => void;
}

type NodeStatus = "completed" | "active" | "upcoming";

interface TimelineNode {
  id: string;
  labelKey: string;
  status: NodeStatus;
  icon: React.ReactNode;
}

export function OverviewTimeline({
  idea,
  proposals,
  tasks,
  onSelectTask,
}: OverviewTimelineProps) {
  const t = useTranslations("ideaTracker");
  const tRoot = useTranslations();
  const locale = useLocale();

  const [elaboration, setElaboration] = useState<ElaborationResponse | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  // Fetch elaboration data on mount
  useEffect(() => {
    if (idea.status !== "open") {
      getElaborationAction(idea.uuid).then((result) => {
        if (result.success && result.data) {
          setElaboration(result.data);
        }
      });
    }
  }, [idea.uuid, idea.status]);

  // Determine the current phase
  const currentPhase = useMemo(() => {
    if (idea.status === "open") return "idea_created";
    if (idea.status === "elaborating") return "elaboration";
    // If no proposals yet but elaborated
    if (proposals.length === 0) return "elaboration";
    // If proposals exist but none approved
    const hasApproved = proposals.some((p) => p.status === "approved");
    if (!hasApproved) return "proposal";
    // If tasks exist
    if (tasks.length > 0) return "tasks";
    return "proposal";
  }, [idea.status, proposals, tasks]);

  // Build timeline nodes
  const nodes = useMemo((): TimelineNode[] => {
    const phases = ["idea_created", "elaboration", "proposal", "tasks"] as const;
    const currentIdx = phases.indexOf(currentPhase as (typeof phases)[number]);

    return phases.map((phase, idx) => {
      let status: NodeStatus;
      if (idx < currentIdx) {
        status = "completed";
      } else if (idx === currentIdx) {
        status = "active";
      } else {
        status = "upcoming";
      }

      const icons: Record<string, React.ReactNode> = {
        idea_created: <Lightbulb className="h-3.5 w-3.5" />,
        elaboration: <MessageSquareText className="h-3.5 w-3.5" />,
        proposal: <ClipboardList className="h-3.5 w-3.5" />,
        tasks: <ListChecks className="h-3.5 w-3.5" />,
      };

      const labelKeys: Record<string, string> = {
        idea_created: "panel.timeline.ideaCreated",
        elaboration: "panel.timeline.elaboration",
        proposal: "panel.timeline.proposal",
        tasks: "panel.timeline.tasksProgress",
      };

      return {
        id: phase,
        labelKey: labelKeys[phase],
        status,
        icon: icons[phase],
      };
    });
  }, [currentPhase]);

  // Auto-expand active node on mount
  useEffect(() => {
    const activeNode = nodes.find((n) => n.status === "active");
    if (activeNode) {
      setExpandedNodes(new Set([activeNode.id]));
    }
    // Intentionally omitting nodes — only currentPhase should trigger re-expansion, not node array identity
  }, [currentPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  // Elaboration summary text
  const elaborationSummary = useMemo(() => {
    if (idea.status === "open") return t("panel.timeline.noElaboration");
    if (idea.elaborationStatus === "skipped") return t("panel.timeline.elaborationSkipped");
    if (idea.elaborationStatus === "resolved" && elaboration) {
      return t("panel.timeline.elaborationComplete", { count: elaboration.summary.totalQuestions });
    }
    if (idea.status === "elaborating") return t("panel.timeline.elaborationInProgress");
    if (elaboration && elaboration.summary.totalQuestions > 0) {
      return t("panel.timeline.elaborationComplete", { count: elaboration.summary.totalQuestions });
    }
    return t("panel.timeline.noElaboration");
  }, [idea.status, idea.elaborationStatus, elaboration, t]);

  // Proposal summary — aggregate across all proposals
  const proposalSummary = useMemo(() => {
    if (proposals.length === 0) return t("panel.timeline.noProposal");
    const approved = proposals.filter((p) => p.status === "approved").length;
    const pending = proposals.filter((p) => p.status === "pending").length;
    if (approved > 0 && proposals.length === 1) return t("panel.timeline.proposalApproved");
    if (approved > 0) return t("panel.timeline.proposalsApproved", { count: approved, total: proposals.length });
    if (pending > 0) return t("panel.timeline.proposalPending");
    const latest = proposals[0];
    switch (latest.status) {
      case "draft": return t("panel.timeline.proposalDraft");
      case "rejected": return t("panel.timeline.proposalRejected");
      default: return t("panel.timeline.proposalDraft");
    }
  }, [proposals, t]);

  // Aggregate doc/task counts across all proposals
  const proposalStats = useMemo(() => {
    let docCount = 0;
    let taskDraftCount = 0;
    for (const p of proposals) {
      docCount += p.documentDrafts?.length ?? 0;
      taskDraftCount += p.taskDrafts?.length ?? 0;
    }
    return { docCount, taskDraftCount };
  }, [proposals]);

  // Task stats
  const taskStats = useMemo(() => {
    const done = tasks.filter((t) => t.status === "done").length;
    const inProgress = tasks.filter((t) => t.status === "in_progress").length;
    const toVerify = tasks.filter((t) => t.status === "to_verify").length;
    const open = tasks.filter((t) => t.status === "open" || t.status === "assigned").length;
    return { done, inProgress, toVerify, open, total: tasks.length };
  }, [tasks]);

  const renderNodeContent = (node: TimelineNode) => {
    const isExpanded = expandedNodes.has(node.id);

    switch (node.id) {
      case "idea_created":
        return isExpanded ? (
          <div className="mt-2 space-y-1.5">
            {idea.createdBy && (
              <p className="text-[12px] text-[#6B6B6B]">
                {t("panel.timeline.createdBy", { name: idea.createdBy.name })}
              </p>
            )}
            <p className="text-[12px] text-[#9A9A9A]">
              {formatRelativeTime(idea.createdAt, tRoot, locale)}
            </p>
            {idea.content && (
              <p className="text-[12px] text-[#6B6B6B] line-clamp-2">
                {idea.content.slice(0, 120)}
                {idea.content.length > 120 ? "..." : ""}
              </p>
            )}
          </div>
        ) : null;

      case "elaboration":
        return isExpanded ? (
          <div className="mt-2 space-y-1.5">
            <p className="text-[12px] text-[#6B6B6B]">{elaborationSummary}</p>
            {elaboration && elaboration.rounds.length > 0 && (
              <p className="text-[12px] text-[#9A9A9A]">
                {t("panel.timeline.rounds", { count: elaboration.rounds.length })}
              </p>
            )}
          </div>
        ) : null;

      case "proposal":
        return isExpanded ? (
          <div className="mt-2 space-y-1.5">
            <p className="text-[12px] text-[#6B6B6B]">{proposalSummary}</p>
            {proposals.length > 0 && (
              <div className="space-y-1">
                {proposalStats.docCount > 0 && (
                  <div className="flex items-center gap-1.5 text-[12px] text-[#9A9A9A]">
                    <FileText className="h-3 w-3" />
                    <span>{t("panel.timeline.documents", { count: proposalStats.docCount })}</span>
                  </div>
                )}
                {proposalStats.taskDraftCount > 0 && (
                  <div className="flex items-center gap-1.5 text-[12px] text-[#9A9A9A]">
                    <ListChecks className="h-3 w-3" />
                    <span>{t("panel.timeline.tasks", { count: proposalStats.taskDraftCount })}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : null;

      case "tasks":
        return isExpanded ? (
          <div className="mt-2 space-y-2">
            {tasks.length === 0 ? (
              <p className="text-[12px] text-[#9A9A9A]">{t("panel.timeline.noTasks")}</p>
            ) : (
              <>
                {/* Progress bar */}
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 rounded-full bg-[#F0EDE8] overflow-hidden flex">
                    {taskStats.done > 0 && (
                      <div
                        className="h-full bg-[#00796B]"
                        style={{ width: `${(taskStats.done / taskStats.total) * 100}%` }}
                      />
                    )}
                    {taskStats.inProgress > 0 && (
                      <div
                        className="h-full bg-[#1976D2]"
                        style={{ width: `${(taskStats.inProgress / taskStats.total) * 100}%` }}
                      />
                    )}
                    {taskStats.toVerify > 0 && (
                      <div
                        className="h-full bg-[#7B1FA2]"
                        style={{ width: `${(taskStats.toVerify / taskStats.total) * 100}%` }}
                      />
                    )}
                  </div>
                  <span className="text-[11px] text-[#9A9A9A] shrink-0">
                    {t("panel.timeline.tasksComplete", { done: taskStats.done, total: taskStats.total })}
                  </span>
                </div>

                {/* Task cards */}
                <div className="space-y-1">
                  {tasks.slice(0, 5).map((task) => (
                    <button
                      key={task.uuid}
                      onClick={() => onSelectTask(task.uuid)}
                      className="flex items-center gap-2 w-full text-left rounded-md px-2 py-1.5 hover:bg-[#F5F2EC] transition-colors group cursor-pointer"
                    >
                      <ChevronLeft className="h-3 w-3 text-[#D9D9D9] shrink-0 group-hover:text-[#C67A52]" />
                      <span className={`h-2 w-2 rounded-full shrink-0 ${getTaskStatusDotColor(task.status)}`} />
                      <span className="flex-1 text-[12px] text-[#2C2C2C] truncate group-hover:text-[#C67A52]">
                        {task.title}
                      </span>
                    </button>
                  ))}
                  {tasks.length > 5 && (
                    <p className="text-[11px] text-[#9A9A9A] px-2">
                      {t("panel.timeline.moreItems", { count: tasks.length - 5 })}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        ) : null;

      default:
        return null;
    }
  };

  const getOneLiner = (node: TimelineNode): string => {
    switch (node.id) {
      case "idea_created":
        return idea.createdBy ? idea.createdBy.name : "";
      case "elaboration":
        return elaborationSummary;
      case "proposal":
        return proposalSummary;
      case "tasks":
        return tasks.length > 0
          ? t("panel.timeline.tasksComplete", { done: taskStats.done, total: taskStats.total })
          : t("panel.timeline.noTasks");
      default:
        return "";
    }
  };

  return (
    <div className="space-y-0">
      {nodes.map((node, idx) => {
        const isExpanded = expandedNodes.has(node.id);
        const isLast = idx === nodes.length - 1;

        return (
          <div key={node.id} className="flex gap-3">
            {/* Left: vertical line + dot */}
            <div className="flex flex-col items-center w-5 shrink-0">
              {/* Dot */}
              <div className="mt-1">
                {node.status === "completed" ? (
                  <div className="h-5 w-5 rounded-full bg-[#E0F2F1] flex items-center justify-center">
                    <Check className="h-3 w-3 text-[#00796B]" />
                  </div>
                ) : node.status === "active" ? (
                  <div className="h-5 w-5 rounded-full bg-[#C67A52] flex items-center justify-center">
                    <Circle className="h-2 w-2 fill-white text-white" />
                  </div>
                ) : (
                  <div className="h-5 w-5 rounded-full border-2 border-dashed border-[#D9D9D9] flex items-center justify-center">
                    <Circle className="h-2 w-2 text-[#D9D9D9]" />
                  </div>
                )}
              </div>
              {/* Vertical line */}
              {!isLast && (
                <div className="flex-1 w-px bg-[#E5E0D8] mt-1 min-h-[8px]" />
              )}
            </div>

            {/* Right: content */}
            <div className={`flex-1 min-w-0 ${isLast ? "pb-0" : "pb-4"}`}>
              <button
                onClick={() => toggleNode(node.id)}
                className="flex items-center gap-1.5 w-full text-left group cursor-pointer"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 text-[#9A9A9A] shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-[#9A9A9A] shrink-0" />
                )}
                <span
                  className={`text-[13px] font-medium ${
                    node.status === "active"
                      ? "text-[#C67A52]"
                      : node.status === "completed"
                        ? "text-[#2C2C2C]"
                        : "text-[#9A9A9A]"
                  }`}
                >
                  {t(node.labelKey)}
                </span>
                {!isExpanded && (
                  <span className="text-[11px] text-[#9A9A9A] truncate ml-1">
                    {getOneLiner(node)}
                  </span>
                )}
              </button>

              {renderNodeContent(node)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
