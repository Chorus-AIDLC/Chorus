"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  ClipboardList,
  Loader2,
  ChevronRight,
  ListChecks,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Streamdown } from "streamdown";
import { code as codePlugin } from "@streamdown/code";
import { TaskDag, type TaskDagTask, type TaskDagEdge } from "@/components/task-dag";
import type { IdeaResponse } from "@/services/idea.service";

interface AcceptanceCriteriaItem {
  description: string;
  required?: boolean;
}

interface TaskDraftData {
  uuid: string;
  title: string;
  description?: string;
  priority?: string;
  acceptanceCriteria?: string;
  acceptanceCriteriaItems?: AcceptanceCriteriaItem[];
  dependsOnDraftUuids?: string[];
}

interface DocDraftData {
  uuid?: string;
  title: string;
  type: string;
  content?: string;
}

interface ProposalData {
  uuid: string;
  title: string;
  description: string | null;
  status: string;
  documentDrafts: DocDraftData[] | null;
  taskDrafts: TaskDraftData[] | null;
  createdAt: string;
}

interface ProposalViewProps {
  idea: IdeaResponse;
  projectUuid: string;
  onTaskClick?: (taskUuid: string) => void;
  onDocClick?: (doc: { title: string; type: string; content: string }) => void;
}

function getDocTypeLabel(type: string): string {
  const map: Record<string, string> = {
    prd: "PRD",
    tech_design: "Tech Design",
    adr: "ADR",
    spec: "Spec",
    guide: "Guide",
  };
  return map[type] || type.replace(/_/g, " ");
}

/** Normalize escaped newlines from JSON into real newlines for markdown rendering */
function normalizeNewlines(text: string): string {
  return text.replace(/\\n/g, "\n");
}

export function ProposalView({ idea, projectUuid, onTaskClick, onDocClick }: ProposalViewProps) {
  const t = useTranslations("ideaTracker");
  const tProposals = useTranslations("proposals");

  const [proposals, setProposals] = useState<ProposalData[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchProposals = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/projects/${projectUuid}/proposals?pageSize=100`
      );
      const json = await res.json();
      if (json.success) {
        const matching = (json.data || []).filter(
          (p: { inputUuids: string[] }) =>
            Array.isArray(p.inputUuids) && p.inputUuids.includes(idea.uuid)
        );
        setProposals(matching);
      }
    } catch {
      // empty state will show
    } finally {
      setIsLoading(false);
    }
  }, [projectUuid, idea.uuid]);

  useEffect(() => {
    fetchProposals();
  }, [fetchProposals]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-[#C67A52]" />
      </div>
    );
  }

  if (proposals.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#F3E5F5]">
          <ClipboardList className="h-5 w-5 text-[#7B1FA2]" />
        </div>
        <p className="text-sm text-[#9A9A9A]">{t("panel.noProposals")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {proposals.map((p) => (
        <ProposalContent
          key={p.uuid}
          proposal={p}
          projectUuid={projectUuid}
          t={t}
          tProposals={tProposals}
          onTaskClick={onTaskClick}
          onDocClick={onDocClick}
        />
      ))}
    </div>
  );
}

interface MaterializedTask {
  uuid: string;
  title: string;
  status: string;
}

function ProposalContent({
  proposal,
  projectUuid,
  t,
  tProposals,
  onTaskClick,
  onDocClick,
}: {
  proposal: ProposalData;
  projectUuid: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tProposals: any;
  onTaskClick?: (taskUuid: string) => void;
  onDocClick?: (doc: { title: string; type: string; content: string }) => void;
}) {
  const docDrafts = proposal.documentDrafts || [];
  const taskDrafts = proposal.taskDrafts || [];
  const [expandedTasks, setExpandedTasks] = useState<Set<number>>(new Set());
  const [taskView, setTaskView] = useState<"cards" | "dag">("cards");
  const [materializedTasks, setMaterializedTasks] = useState<MaterializedTask[]>([]);
  const isApproved = proposal.status === "approved";

  // For approved proposals, fetch materialized tasks to enable navigation
  useEffect(() => {
    if (!isApproved) return;
    fetch(`/api/projects/${projectUuid}/tasks?proposalUuids=${proposal.uuid}&pageSize=100`)
      .then((res) => res.json())
      .then((json) => {
        if (json.success) setMaterializedTasks(json.data || []);
      })
      .catch(() => {});
  }, [isApproved, projectUuid, proposal.uuid]);

  // Map draft title → materialized task info for navigation + status
  const draftTitleToTask = new Map<string, MaterializedTask>();
  for (const mt of materializedTasks) {
    draftTitleToTask.set(mt.title, mt);
  }

  const toggleTask = (index: number) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  // Build DAG data — use real task status for approved proposals
  const dagTasks: TaskDagTask[] = taskDrafts.map((td) => {
    const mt = draftTitleToTask.get(td.title);
    return {
      uuid: mt?.uuid || td.uuid,
      title: td.title,
      status: mt?.status || "open",
      priority: td.priority || "medium",
    };
  });
  const dagEdges: TaskDagEdge[] = [];
  for (const td of taskDrafts) {
    if (td.dependsOnDraftUuids) {
      for (const depUuid of td.dependsOnDraftUuids) {
        // Resolve draft UUIDs to materialized UUIDs if available
        const fromMt = draftTitleToTask.get(td.title);
        const depDraft = taskDrafts.find((d) => d.uuid === depUuid);
        const toMt = depDraft ? draftTitleToTask.get(depDraft.title) : undefined;
        dagEdges.push({
          from: fromMt?.uuid || td.uuid,
          to: toMt?.uuid || depUuid,
        });
      }
    }
  }
  const dagHeight = Math.max(350, dagTasks.length * 90);

  // Count completed tasks (for progress display)
  const completedCount = isApproved
    ? materializedTasks.filter((t) => t.status === "done" || t.status === "closed").length
    : 0;

  return (
    <div className="space-y-5">
      {/* Description — plain text, markdown rendered */}
      {proposal.description && (
        <div className="max-h-[120px] overflow-y-auto text-[13px] leading-relaxed text-[#4A4A4A] prose prose-sm max-w-none [&_h1]:text-sm [&_h2]:text-[13px] [&_h3]:text-xs [&_p]:text-[13px] [&_p]:text-[#4A4A4A] [&_p]:my-1.5 [&_li]:text-[13px] [&_li]:text-[#4A4A4A] [&_ul]:my-1 [&_ol]:my-1 [&_strong]:text-[#2C2C2C]">
          <Streamdown plugins={{ code: codePlugin }}>
            {normalizeNewlines(proposal.description)}
          </Streamdown>
        </div>
      )}

      {/* View Full Proposal Link */}
      <Link
        href={`/projects/${projectUuid}/proposals/${proposal.uuid}`}
        className="flex items-center gap-1 text-[13px] font-medium text-[#C67A52] hover:underline"
      >
        {t("panel.viewProposal")}
        <ChevronRight className="h-3.5 w-3.5" />
      </Link>

      {/* Document Drafts Section */}
      {docDrafts.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[1px] text-[#9A9A9A]">
              {isApproved ? tProposals("documents") : tProposals("documentDrafts")}
            </span>
            <span className="text-[11px] text-[#9A9A9A]">{docDrafts.length}</span>
          </div>
          <div className="space-y-0">
            {docDrafts.map((doc, i) => (
              <Button
                key={doc.uuid || i}
                variant="ghost"
                className="w-full justify-start h-auto text-left flex items-center gap-2.5 py-3.5 hover:bg-[#FAF8F4] transition-colors cursor-pointer -mx-1 px-1 rounded-lg"
                onClick={() => doc.content && onDocClick?.({ title: doc.title, type: doc.type, content: doc.content })}
              >
                <Badge
                  variant="outline"
                  className="shrink-0 text-[10px] font-medium border-[#E5E0D8] text-[#6B6B6B] bg-[#F5F2EC] px-2 py-0.5 font-mono"
                >
                  {getDocTypeLabel(doc.type)}
                </Badge>
                <span className="flex-1 min-w-0 text-left text-[13px] text-[#2C2C2A] truncate">
                  {doc.title}
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#B4B2A9]" />
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Tasks Section */}
      {(taskDrafts.length > 0 || materializedTasks.length > 0) && (
        <div>
          {/* Header with count + progress */}
          <div className="flex items-center justify-between pb-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[1px] text-[#9A9A9A]">
                {isApproved ? tProposals("tasks") : tProposals("taskDrafts")}
              </span>
              <span className="text-[11px] text-[#9A9A9A]">
                {isApproved && materializedTasks.length > 0 ? materializedTasks.length : taskDrafts.length}
              </span>
            </div>
            <span className="text-[12px] text-[#9A9A9A]">
              {completedCount}/{isApproved && materializedTasks.length > 0 ? materializedTasks.length : taskDrafts.length}
            </span>
          </div>

          {/* Full-width divider under header */}
          <div className="-mx-6 border-t border-[#E5E0D8]" />

          {/* Cards/DAG toggle (only when deps exist) */}
          {dagEdges.length > 0 && (
            <div className="flex gap-0.5 rounded-lg border border-[#E5E0D8] bg-[#F7F6F3] p-0.5 mt-3 w-fit">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTaskView("cards")}
                className={`rounded-md px-2.5 py-1 h-auto text-[11px] font-medium transition-colors ${
                  taskView === "cards"
                    ? "bg-white text-[#2C2C2C] shadow-sm"
                    : "text-[#9A9A9A] hover:text-[#6B6B6B]"
                }`}
              >
                {tProposals("cardsView")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTaskView("dag")}
                className={`rounded-md px-2.5 py-1 h-auto text-[11px] font-medium transition-colors ${
                  taskView === "dag"
                    ? "bg-white text-[#2C2C2C] shadow-sm"
                    : "text-[#9A9A9A] hover:text-[#6B6B6B]"
                }`}
              >
                DAG
              </Button>
            </div>
          )}

          {/* Task list */}
          {taskView === "cards" && (
            <div className="space-y-0">
              {isApproved && materializedTasks.length > 0
                ? materializedTasks.map((mt) => (
                    <TaskDraftRow
                      key={mt.uuid}
                      task={{ uuid: mt.uuid, title: mt.title }}
                      expanded={false}
                      onToggle={() => {}}
                      onNavigate={onTaskClick ? () => onTaskClick(mt.uuid) : undefined}
                      taskStatus={mt.status}
                    />
                  ))
                : taskDrafts.map((task, i) => (
                    <TaskDraftRow
                      key={task.uuid}
                      task={task}
                      expanded={expandedTasks.has(i)}
                      onToggle={() => toggleTask(i)}
                    />
                  ))
              }
            </div>
          )}

          {/* DAG view */}
          {taskView === "dag" && (
            <div className="mt-3">
              <TaskDag
                tasks={dagTasks}
                edges={dagEdges}
                readonly
                height={dagHeight}
                onNodeClick={onTaskClick}
              />
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {docDrafts.length === 0 && taskDrafts.length === 0 && materializedTasks.length === 0 && (
        <p className="text-xs text-[#9A9A9A] italic">
          {tProposals("emptyContainer")}
        </p>
      )}
    </div>
  );
}

// Dot color per task status
const taskDotColor: Record<string, string> = {
  open: "border-[#D9D9D9] bg-white",                 // hollow gray — not started
  assigned: "border-[#1976D2] bg-[#1976D2]",         // blue — assigned
  in_progress: "border-[#5A9E6F] bg-[#5A9E6F]",     // green — building
  to_verify: "border-[#7B1FA2] bg-[#7B1FA2]",       // purple — needs verify
  done: "border-[#00796B] bg-[#00796B]",             // teal — done
  closed: "border-[#9A9A9A] bg-[#9A9A9A]",          // gray — closed
};

// Badge style per task status (only shown for notable states)
const taskBadgeStyle: Record<string, { className: string; key: string } | null> = {
  open: null,
  assigned: null,
  in_progress: { className: "bg-[#E8F5E9] text-[#5A9E6F]", key: "inProgress" },
  to_verify: { className: "bg-[#F3E5F5] text-[#7B1FA2]", key: "toVerify" },
  done: { className: "bg-[#E0F2F1] text-[#00796B]", key: "done" },
  closed: { className: "bg-[#F5F5F5] text-[#9A9A9A]", key: "done" },
};

/** Task draft row — opens task detail panel when materialized, expands inline for drafts */
function TaskDraftRow({
  task,
  expanded,
  onToggle,
  onNavigate,
  taskStatus,
}: {
  task: TaskDraftData;
  expanded: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
  taskStatus?: string;
}) {
  const tProposals = useTranslations("proposals");
  const tAC = useTranslations("acceptanceCriteria");
  const tStatus = useTranslations("status");
  const acItems = task.acceptanceCriteriaItems || [];
  const hasDetails = !!(task.description || acItems.length > 0);

  const dotClass = taskStatus
    ? taskDotColor[taskStatus] || taskDotColor.open
    : "border-[#D9D9D9] bg-white";
  const badge = taskStatus ? taskBadgeStyle[taskStatus] : null;

  const dotEl = (
    <span className={`shrink-0 h-2 w-2 rounded-full border-[1.5px] ${dotClass} transition-colors`} />
  );

  const titleEl = (
    <span className="flex-1 min-w-0 text-[13px] leading-snug truncate text-[#6B6B6B]">
      {task.title}
    </span>
  );

  const badgeEl = badge ? (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}>
      {tStatus(badge.key)}
    </span>
  ) : null;

  // If materialized task exists, open task detail panel
  if (onNavigate) {
    return (
      <Button
        variant="ghost"
        onClick={onNavigate}
        className="w-full justify-start h-auto text-left flex items-center gap-2.5 py-4 cursor-pointer hover:bg-[#FAF8F4] -mx-1 px-1 rounded-lg transition-colors"
      >
        {dotEl}
        {titleEl}
        {badgeEl}
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#B4B2A9]" />
      </Button>
    );
  }

  // Draft — expand inline
  return (
    <div>
      <Button
        variant="ghost"
        onClick={hasDetails ? onToggle : undefined}
        className={`w-full justify-start h-auto text-left flex items-center gap-2.5 py-4 ${
          hasDetails ? "cursor-pointer hover:bg-[#FAF8F4] -mx-1 px-1 rounded-lg" : ""
        } transition-colors`}
      >
        {dotEl}
        {titleEl}
        {badgeEl}
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#B4B2A9]" />
      </Button>

      {expanded && hasDetails && (
        <div className="pb-3 pl-5 space-y-3">
          {task.description && (
            <p className="text-[11px] leading-relaxed text-[#6B6B6B]">
              {task.description}
            </p>
          )}
          {acItems.length > 0 && (
            <div className="rounded-lg bg-[#FAF8F4] p-3 space-y-2">
              <div className="flex items-center gap-1.5">
                <ListChecks className="h-3.5 w-3.5 text-[#888780]" />
                <span className="text-[11px] font-semibold text-[#2C2C2C]">
                  {tProposals("taskAcceptanceCriteria")}
                </span>
              </div>
              <div className="space-y-1.5">
                {acItems.map((ac, j) => (
                  <div key={j} className="flex items-start justify-between gap-2">
                    <p className="text-[11px] leading-snug text-[#4A4A4A] flex-1">
                      {ac.description}
                    </p>
                    {ac.required !== false && (
                      <span className="shrink-0 text-[10px] font-medium text-[#E65100]">
                        {tAC("required")}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
