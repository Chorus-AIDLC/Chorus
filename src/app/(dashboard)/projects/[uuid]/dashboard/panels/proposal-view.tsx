"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  ClipboardList,
  Loader2,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  ListChecks,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PresenceIndicator } from "@/components/ui/presence-indicator";
import { usePresence, injectPresence } from "@/hooks/use-presence";
import { useRealtimeEntityTypeEvent } from "@/contexts/realtime-context";
import { Streamdown } from "streamdown";
import { code as codePlugin } from "@streamdown/code";
import { TaskDag, type TaskDagTask, type TaskDagEdge } from "@/components/task-dag";
import { normalizeNewlines, DOC_TYPE_I18N_KEYS } from "./utils";
import { getProposalsForIdeaAction, getTasksForProposalAction } from "./actions";
import type { IdeaResponse } from "@/services/idea.service";
import { clientLogger } from "@/lib/logger-client";

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

export interface ProposalData {
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
  initialProposals?: ProposalData[];
}


export function ProposalView({ idea, projectUuid, onTaskClick, onDocClick, initialProposals }: ProposalViewProps) {
  const t = useTranslations("ideaTracker");

  const [proposals, setProposals] = useState<ProposalData[]>(initialProposals ?? []);
  const [isLoading, setIsLoading] = useState(!initialProposals);

  const fetchProposals = useCallback(async (): Promise<ProposalData[]> => {
    try {
      const result = await getProposalsForIdeaAction(projectUuid, idea.uuid);
      if (result.success) {
        setProposals(result.data);
        return result.data;
      }
    } catch (e) {
      clientLogger.error("Failed to fetch proposals:", e);
    } finally {
      setIsLoading(false);
    }
    return [];
  }, [projectUuid, idea.uuid]);

  useEffect(() => {
    if (!initialProposals) {
      fetchProposals();
    }
  }, [fetchProposals, initialProposals]);

  // Track previous proposals for diff (inject presence on new drafts)
  const prevProposalsRef = useRef(proposals);
  prevProposalsRef.current = proposals;
  const { getPresence } = usePresence();

  // SSE: refresh proposals when any proposal changes (draft added/removed/updated)
  useRealtimeEntityTypeEvent("proposal", async () => {
    const oldProposals = prevProposalsRef.current;
    const newProposals = await fetchProposals();

    // Inject presence on newly created drafts
    for (const np of newProposals) {
      const op = oldProposals.find((o) => o.uuid === np.uuid);
      if (!op) continue;
      const oldDocIds = new Set((op.documentDrafts ?? []).map((d) => d.uuid));
      const oldTaskIds = new Set((op.taskDrafts ?? []).map((d) => d.uuid));
      const newDocs = (np.documentDrafts ?? []).filter((d) => d.uuid && !oldDocIds.has(d.uuid));
      const newTasks = (np.taskDrafts ?? []).filter((d) => d.uuid && !oldTaskIds.has(d.uuid));
      const allNewIds = [...newDocs.map((d) => d.uuid!), ...newTasks.map((d) => d.uuid!)];
      if (allNewIds.length > 0) {
        const presence = getPresence("proposal", np.uuid);
        const agent = presence[0];
        if (agent) {
          for (const id of allNewIds) {
            injectPresence({
              entityType: "proposal",
              entityUuid: np.uuid,
              subEntityType: "draft",
              subEntityUuid: id,
              agentUuid: agent.agentUuid,
              agentName: agent.agentName,
              action: "mutate",
            });
          }
        }
      }
    }
  });

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

const PROPOSAL_STATUS_COLORS: Record<string, string> = {
  draft: "bg-[#F5F5F5] text-[#6B6B6B]",
  pending: "bg-[#FFF3E0] text-[#E65100]",
  approved: "bg-[#E8F5E9] text-[#5A9E6F]",
  rejected: "bg-[#FFEBEE] text-[#C4574C]",
  revised: "bg-[#E3F2FD] text-[#1976D2]",
  closed: "bg-[#F5F5F5] text-[#9A9A9A]",
};

function ProposalContent({
  proposal,
  projectUuid,
  onTaskClick,
  onDocClick,
}: {
  proposal: ProposalData;
  projectUuid: string;
  onTaskClick?: (taskUuid: string) => void;
  onDocClick?: (doc: { title: string; type: string; content: string }) => void;
}) {
  const t = useTranslations("ideaTracker");
  const tRoot = useTranslations();
  const tProposals = useTranslations("proposals");
  const tTasks = useTranslations("tasks");
  const tDocs = useTranslations("documents");

  const docDrafts = proposal.documentDrafts || [];
  const taskDrafts = proposal.taskDrafts || [];
  const [expandedTasks, setExpandedTasks] = useState<Set<number>>(new Set());
  const [taskView, setTaskView] = useState<"cards" | "dag">("cards");
  const [materializedTasks, setMaterializedTasks] = useState<MaterializedTask[]>([]);
  const isApproved = proposal.status === "approved";

  // For approved proposals, fetch materialized tasks to enable navigation
  useEffect(() => {
    if (!isApproved) return;
    getTasksForProposalAction(projectUuid, proposal.uuid).then((result) => {
      if (result.success) setMaterializedTasks(result.data || []);
    }).catch((e) => clientLogger.error("Failed to fetch materialized tasks:", e));
  }, [isApproved, projectUuid, proposal.uuid]);

  // Map draft title → materialized task info for navigation + status
  const draftTitleToTask = useMemo(() => {
    const map = new Map<string, MaterializedTask>();
    for (const mt of materializedTasks) {
      map.set(mt.title, mt);
    }
    return map;
  }, [materializedTasks]);

  const toggleTask = (index: number) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  // Build DAG data — use real task status for approved proposals
  const { dagTasks, dagEdges, dagHeight } = useMemo(() => {
    const tasks: TaskDagTask[] = taskDrafts.map((td) => {
      const mt = draftTitleToTask.get(td.title);
      return {
        uuid: mt?.uuid || td.uuid,
        title: td.title,
        status: mt?.status || "open",
        priority: td.priority || "medium",
      };
    });
    const edges: TaskDagEdge[] = [];
    // Build a UUID lookup for O(1) dep resolution
    const draftUuidMap = new Map(taskDrafts.map((d) => [d.uuid, d]));
    for (const td of taskDrafts) {
      if (td.dependsOnDraftUuids) {
        for (const depUuid of td.dependsOnDraftUuids) {
          const fromMt = draftTitleToTask.get(td.title);
          const depDraft = draftUuidMap.get(depUuid);
          const toMt = depDraft ? draftTitleToTask.get(depDraft.title) : undefined;
          edges.push({
            from: fromMt?.uuid || td.uuid,
            to: toMt?.uuid || depUuid,
          });
        }
      }
    }
    return { dagTasks: tasks, dagEdges: edges, dagHeight: Math.max(350, tasks.length * 90) };
  }, [taskDrafts, draftTitleToTask]);

  // Count completed tasks (for progress display)
  const completedCount = isApproved
    ? materializedTasks.filter((t) => t.status === "done" || t.status === "closed").length
    : 0;

  return (
    <div className="space-y-5">
      {/* Title + Status */}
      <div className="flex items-center gap-2">
        <h3 className="text-[14px] font-semibold text-[#2C2C2C] truncate flex-1">
          {proposal.title}
        </h3>
        <Badge className={`text-[11px] font-semibold border-0 shrink-0 ${PROPOSAL_STATUS_COLORS[proposal.status] || ""}`}>
          {tRoot(`status.${proposal.status}`)}
        </Badge>
      </div>

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
              <PresenceIndicator key={doc.uuid || i} entityType="proposal" entityUuid={proposal.uuid} subEntityType="draft" subEntityUuid={doc.uuid || `draft-${i}`} badgeInside>
                <Button
                  variant="ghost"
                  className="w-full justify-start h-auto text-left flex items-center gap-2.5 py-3.5 hover:bg-[#FAF8F4] transition-colors cursor-pointer -mx-1 px-1 rounded-lg"
                  onClick={() => doc.content && onDocClick?.({ title: doc.title, type: doc.type, content: doc.content })}
                >
                  <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-[#B4B2A9]" />
                  <Badge
                    variant="outline"
                    className="shrink-0 text-[10px] font-medium border-[#E5E0D8] text-[#6B6B6B] bg-[#F5F2EC] px-2 py-0.5 font-mono"
                  >
                    {tDocs(DOC_TYPE_I18N_KEYS[doc.type] || "typeOther")}
                  </Badge>
                  <span className="flex-1 min-w-0 text-left text-[13px] text-[#2C2C2A] truncate">
                    {doc.title}
                  </span>
                </Button>
              </PresenceIndicator>
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
                {tTasks("dagView")}
              </Button>
            </div>
          )}

          {/* Task list */}
          {taskView === "cards" && (
            <div className="space-y-0">
              {isApproved && materializedTasks.length > 0
                ? materializedTasks.map((mt) => (
                    <PresenceIndicator key={mt.uuid} entityType="task" entityUuid={mt.uuid} badgeInside>
                      <TaskDraftRow
                        task={{ uuid: mt.uuid, title: mt.title }}
                        expanded={false}
                        onToggle={() => {}}
                        onNavigate={onTaskClick ? () => onTaskClick(mt.uuid) : undefined}
                        taskStatus={mt.status}
                      />
                    </PresenceIndicator>
                  ))
                : taskDrafts.map((task, i) => (
                    <PresenceIndicator key={task.uuid} entityType="proposal" entityUuid={proposal.uuid} subEntityType="draft" subEntityUuid={task.uuid} badgeInside>
                      <TaskDraftRow
                        task={task}
                        expanded={expandedTasks.has(i)}
                        onToggle={() => toggleTask(i)}
                      />
                    </PresenceIndicator>
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
        <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-[#B4B2A9]" />
        {dotEl}
        {titleEl}
        {badgeEl}
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
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#B4B2A9]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#B4B2A9]" />
        )}
        {dotEl}
        {titleEl}
        {badgeEl}
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
