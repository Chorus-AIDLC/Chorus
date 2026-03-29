"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
} from "@hello-pangea/dnd";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Plus,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Folder,
  List,
  Grid2X2,
  SquareCheckBig,
  Lightbulb,
  FileText,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { MoveProjectConfirmDialog } from "@/components/move-project-confirm-dialog";
import { CreateProjectGroupDialog } from "@/components/create-project-group-dialog";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { getProjectInitials, getProjectIconColor } from "@/lib/project-colors";

// Types
interface ProjectData {
  uuid: string;
  name: string;
  description: string | null;
  groupUuid: string | null;
  createdAt: string;
  updatedAt: string;
  counts: {
    ideas: number;
    documents: number;
    tasks: number;
    doneTasks: number;
    proposals: number;
  };
}

interface ProjectGroupData {
  uuid: string;
  name: string;
  description: string | null;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}

function getProgressColor(percent: number): { bar: string; text: string } {
  if (percent >= 100) return { bar: "#1D9E75", text: "#0F6E56" };
  if (percent >= 60) return { bar: "#5DCAA5", text: "#0F6E56" };
  if (percent >= 30) return { bar: "#FAC775", text: "#854F0B" };
  return { bar: "#F09595", text: "#A32D2D" };
}

function useRelativeDate() {
  const t = useTranslations("time");
  return (dateStr: string) => {
    const now = new Date();
    const date = new Date(dateStr);
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffMinutes < 1) return t("justNow");
    if (diffMinutes < 60) return t("minutesAgo", { minutes: diffMinutes });
    if (diffHours < 24) return t("hoursAgo", { hours: diffHours });
    if (diffDays === 0) return t("today");
    if (diffDays === 1) return t("yesterday");
    return t("daysAgo", { days: diffDays });
  };
}


type ViewMode = "list" | "grid";

function ProjectStats({ counts, compact = false }: { counts: ProjectData["counts"]; compact?: boolean }) {
  const t = useTranslations();
  return (
    <span className={`flex items-center gap-2 text-[#9A9A9A] ${compact ? "text-[10px]" : "text-[11px]"}`}>
      <span className="inline-flex items-center gap-1">
        <SquareCheckBig className={`text-[#BDBDBD] ${compact ? "h-[11px] w-[11px]" : "h-3 w-3"}`} />
        {counts.tasks}{!compact && ` ${t("projects.tasks")}`}
      </span>
      <span className="inline-flex items-center gap-1">
        <Lightbulb className={`text-[#BDBDBD] ${compact ? "h-[11px] w-[11px]" : "h-3 w-3"}`} />
        {counts.ideas}{!compact && ` ${t("projects.ideas")}`}
      </span>
      <span className="inline-flex items-center gap-1">
        <FileText className={`text-[#BDBDBD] ${compact ? "h-[11px] w-[11px]" : "h-3 w-3"}`} />
        {counts.documents}{!compact && ` ${t("projects.docs")}`}
      </span>
    </span>
  );
}

function ProjectGridCard({ project }: { project: ProjectData }) {
  const t = useTranslations();
  const formatRelative = useRelativeDate();
  const initials = getProjectInitials(project.name);
  const iconColor = getProjectIconColor(project.name);
  const progress = project.counts.tasks > 0
    ? Math.round((project.counts.doneTasks / project.counts.tasks) * 100)
    : 0;
  const progressColor = getProgressColor(progress);
  const isEmpty = project.counts.tasks === 0;
  const isComplete = progress === 100 && !isEmpty;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[#E5E2DC] bg-white p-4 transition-colors hover:bg-[#F5F2EC]">
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold"
          style={{ backgroundColor: iconColor.bg, color: iconColor.text }}
        >
          {initials}
        </div>
        <span className="truncate text-[13px] font-semibold text-[#2C2C2C]">
          {project.name}
        </span>
        {isEmpty && (
          <Badge variant="outline" className="shrink-0 border-0 bg-[#FEF3C7] px-1.5 py-0 text-[10px] font-medium text-[#92400E]">
            {t("projects.empty")}
          </Badge>
        )}
        {isComplete && (
          <Badge variant="outline" className="shrink-0 border-0 bg-[#D1FAE5] px-1.5 py-0 text-[10px] font-medium text-[#065F46]">
            {t("projects.complete")}
          </Badge>
        )}
      </div>

      {/* Stats */}
      <ProjectStats counts={project.counts} />

      {/* Progress */}
      <div className="flex flex-col gap-1.5">
        <Progress
          value={progress}
          className="h-1.5 w-full bg-[#F0EDE8]"
          style={{ '--progress-indicator': progressColor.bar } as React.CSSProperties}
        />
        <div className="flex justify-between">
          <span className="text-[11px] font-semibold" style={{ color: progressColor.text }}>
            {progress}%
          </span>
          <span className="text-[11px] text-[#9A9A9A]">
            {formatRelative(project.updatedAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

function ProjectListRow({ project, showDivider = true }: { project: ProjectData; showDivider?: boolean }) {
  const t = useTranslations();
  const formatRelative = useRelativeDate();
  const initials = getProjectInitials(project.name);
  const iconColor = getProjectIconColor(project.name);
  const progress = project.counts.tasks > 0
    ? Math.round((project.counts.doneTasks / project.counts.tasks) * 100)
    : 0;
  const progressColor = getProgressColor(progress);
  const isEmpty = project.counts.tasks === 0;
  const isComplete = progress === 100 && !isEmpty;

  return (
    <div
      className="flex w-full flex-col gap-1.5 px-4 py-2.5 md:flex-row md:items-center md:gap-4 md:px-6 md:py-2"
      style={showDivider ? { borderBottom: '1px solid #0000000a' } : undefined}
    >
      {/* Line 1: Icon + Name + Badge */}
      <div className="flex items-center gap-2.5 md:min-w-0 md:flex-1 md:gap-4">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold md:h-9 md:w-9 md:rounded-[10px] md:text-[11px]"
          style={{ backgroundColor: iconColor.bg, color: iconColor.text }}
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-[#2C2C2C]">
              {project.name}
            </span>
            {isEmpty && (
              <Badge variant="outline" className="shrink-0 border-0 bg-[#FEF3C7] px-1.5 py-0 text-[10px] font-medium text-[#92400E]">
                {t("projects.empty")}
              </Badge>
            )}
            {isComplete && (
              <Badge variant="outline" className="shrink-0 border-0 bg-[#D1FAE5] px-1.5 py-0 text-[10px] font-medium text-[#065F46]">
                {t("projects.complete")}
              </Badge>
            )}
          </div>
          {/* Desktop: stats below name */}
          <div className="hidden md:block">
            <ProjectStats counts={project.counts} />
          </div>
        </div>
      </div>

      {/* Line 2 (mobile): compact stats + time + percentage */}
      <div className="flex items-center justify-between md:hidden">
        <span className="flex items-center gap-1.5 text-[10px] text-[#9A9A9A]">
          <ProjectStats counts={project.counts} compact />
          <span>&middot;</span>
          <span>{formatRelative(project.updatedAt)}</span>
        </span>
        <span className="text-[10px] font-semibold" style={{ color: progressColor.text }}>
          {progress}%
        </span>
      </div>

      {/* Line 3 (mobile): full-width progress bar only */}
      <div className="md:hidden">
        <Progress
          value={progress}
          className="h-1 w-full bg-[#F0EDE8]"
          style={{ '--progress-indicator': progressColor.bar } as React.CSSProperties}
        />
      </div>

      {/* Desktop: Progress bar + percentage */}
      <div className="hidden w-[200px] shrink-0 items-center gap-2 md:flex">
        <Progress
          value={progress}
          className="h-1.5 flex-1 bg-[#F0EDE8]"
          style={{ '--progress-indicator': progressColor.bar } as React.CSSProperties}
        />
        <span className="w-9 text-right text-[11px] font-semibold" style={{ color: progressColor.text }}>
          {progress}%
        </span>
      </div>

      {/* Desktop: Updated time */}
      <span className="hidden w-[80px] shrink-0 text-right text-[11px] text-[#9A9A9A] md:block">
        {formatRelative(project.updatedAt)}
      </span>
    </div>
  );
}

const UNGROUPED_DROPPABLE_ID = "__ungrouped__";

function GroupSection({
  group,
  projects,
  stats,
  onNewProject,
  defaultOpen = false,
  viewMode,
}: {
  group: ProjectGroupData;
  projects: ProjectData[];
  stats: { totalTasks: number; completedTasks: number; openIdeas: number };
  onNewProject: () => void;
  defaultOpen?: boolean;
  viewMode: ViewMode;
}) {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const completionRate =
    stats.totalTasks > 0
      ? Math.round((stats.completedTasks / stats.totalTasks) * 100)
      : 0;

  return (
    <Droppable droppableId={group.uuid}>
      {(provided, snapshot) => (
        <div ref={provided.innerRef} {...provided.droppableProps}>
          <Collapsible open={isOpen} onOpenChange={setIsOpen}>
            <Card
              className={`overflow-hidden rounded-2xl border-[#E5E2DC] gap-0 py-0 shadow-none transition-colors hover:border-[#C67A52]/40 ${
                snapshot.isDraggingOver
                  ? "border-[#C67A52] bg-[#C67A5208]"
                  : ""
              }`}
            >
              {/* Group Header */}
              <div className="flex flex-col gap-2 px-4 py-2.5 md:flex-row md:items-center md:justify-between md:px-6 md:py-3">
                <CollapsibleTrigger className="flex flex-1 cursor-pointer items-center gap-2.5 text-left md:gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#C67A5215] md:h-9 md:w-9">
                    <Folder className="h-4 w-4 text-[#C67A52]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 md:gap-2">
                      <h2 className="truncate text-sm font-semibold text-[#2C2C2C] md:text-base">
                        {group.name}
                      </h2>
                      <Badge
                        variant="secondary"
                        className="shrink-0 border-0 bg-[#F0EDE8] text-[10px] font-medium text-[#6B6B6B] md:text-[11px]"
                      >
                        {projects.length}
                      </Badge>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-[#9A9A9A] md:text-[11px]">
                      <span>
                        {stats.totalTasks} {t("projects.tasks")} &middot;{" "}
                        {completionRate}% {t("projectGroups.complete")}
                      </span>
                      <span className="hidden md:inline">
                        {stats.openIdeas} {t("projectGroups.openIdeas")}
                      </span>
                    </div>
                  </div>
                  {isOpen ? (
                    <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-[#9A9A9A] md:h-4 md:w-4" />
                  ) : (
                    <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-[#9A9A9A] md:h-4 md:w-4" />
                  )}
                </CollapsibleTrigger>
                <div className={`hidden items-center gap-2 md:flex`}>
                  <Link href={`/project-groups/${group.uuid}`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-[#C67A52] hover:text-[#B56A42]"
                    >
                      {t("projectGroups.viewDashboard")}
                      <ArrowRight className="ml-1 h-3 w-3" />
                    </Button>
                  </Link>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-[#E5E2DC] text-xs"
                    onClick={onNewProject}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    {t("projects.newProject")}
                  </Button>
                </div>
              </div>

              {/* Projects Content */}
              <CollapsibleContent>
                <div className="border-t border-[#0000000a] py-0">
                  {projects.length === 0 && !snapshot.isDraggingOver ? (
                    <p className="py-4 text-center text-sm text-[#9A9A9A]">
                      {t("projectGroups.noProjectsInGroup")}
                    </p>
                  ) : (
                    <div className={viewMode === "grid" ? "md:grid md:grid-cols-2 md:gap-4 md:p-5 lg:grid-cols-3" : ""}>
                      {projects.map((project, index) => (
                        <Draggable
                          key={project.uuid}
                          draggableId={project.uuid}
                          index={index}
                        >
                          {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              {...provided.dragHandleProps}
                            >
                              <Link
                                href={`/projects/${project.uuid}/dashboard`}
                                draggable={false}
                                onClick={(e) => {
                                  if (snapshot.isDragging) e.preventDefault();
                                }}
                              >
                                {viewMode === "grid" ? (
                                  <>
                                    {/* Mobile: always list */}
                                    <div className={`md:hidden transition-colors hover:bg-[#F5F2EC] ${snapshot.isDragging ? "rotate-1 opacity-90 shadow-md rounded-lg bg-white" : ""}`}>
                                      <ProjectListRow project={project} showDivider={index < projects.length - 1} />
                                    </div>
                                    {/* Desktop: grid card */}
                                    <div className={`hidden md:block ${snapshot.isDragging ? "rotate-1 opacity-90 shadow-md" : ""}`}>
                                      <ProjectGridCard project={project} />
                                    </div>
                                  </>
                                ) : (
                                  <div
                                    className={`transition-colors hover:bg-[#F5F2EC] ${
                                      snapshot.isDragging
                                        ? "rotate-1 opacity-90 shadow-md rounded-lg bg-white"
                                        : ""
                                    }`}
                                  >
                                    <ProjectListRow project={project} showDivider={index < projects.length - 1} />
                                  </div>
                                )}
                              </Link>
                            </div>
                          )}
                        </Draggable>
                      ))}
                    </div>
                  )}
                  {provided.placeholder}
                </div>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </div>
      )}
    </Droppable>
  );
}

function UngroupedSection({ projects, onNewProject, viewMode }: { projects: ProjectData[]; onNewProject: () => void; viewMode: ViewMode }) {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Droppable droppableId={UNGROUPED_DROPPABLE_ID}>
      {(provided, snapshot) => {
        if (projects.length === 0 && !snapshot.isDraggingOver) {
          return (
            <div ref={provided.innerRef} {...provided.droppableProps} className="hidden">
              {provided.placeholder}
            </div>
          );
        }

        return (
          <div ref={provided.innerRef} {...provided.droppableProps}>
            <Collapsible open={isOpen} onOpenChange={setIsOpen}>
              <Card
                className={`overflow-hidden rounded-2xl border-[#E5E2DC] gap-0 py-0 shadow-none transition-colors hover:border-[#C67A52]/40 ${
                  snapshot.isDraggingOver
                    ? "border-[#C67A52] bg-[#C67A5208]"
                    : ""
                }`}
              >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-2.5 md:px-6 md:py-3">
                  <CollapsibleTrigger className="flex flex-1 cursor-pointer items-center gap-2.5 text-left md:gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F0EDE8] md:h-9 md:w-9">
                      <FolderOpen className="h-4 w-4 text-[#9A9A9A]" />
                    </div>
                    <div className="flex items-center gap-1.5 md:gap-2">
                      <h2 className="text-sm font-semibold text-[#6B6B6B] md:text-base">
                        {t("projectGroups.ungrouped")}
                      </h2>
                      <Badge
                        variant="secondary"
                        className="shrink-0 border-0 bg-[#F0EDE8] text-[10px] font-medium text-[#6B6B6B] md:text-[11px]"
                      >
                        {projects.length}
                      </Badge>
                    </div>
                    {isOpen ? (
                      <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-[#9A9A9A] md:h-4 md:w-4" />
                    ) : (
                      <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-[#9A9A9A] md:h-4 md:w-4" />
                    )}
                  </CollapsibleTrigger>
                  <div className="hidden items-center gap-2 md:flex">
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 border-[#E5E2DC] text-xs"
                      onClick={onNewProject}
                    >
                      <Plus className="mr-1 h-3 w-3" />
                      {t("projects.newProject")}
                    </Button>
                  </div>
                </div>

                {/* Projects */}
                <CollapsibleContent>
                  <div className="border-t border-[#0000000a] py-0">
                    {projects.length === 0 ? (
                      <p className="py-4 text-center text-sm text-[#9A9A9A]">
                        {t("projectGroups.noProjectsInGroup")}
                      </p>
                    ) : (
                      <div className={viewMode === "grid" ? "md:grid md:grid-cols-2 md:gap-4 md:p-5 lg:grid-cols-3" : ""}>
                        {projects.map((project, index) => (
                          <Draggable
                            key={project.uuid}
                            draggableId={project.uuid}
                            index={index}
                          >
                            {(provided, snapshot) => (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                {...provided.dragHandleProps}
                              >
                                <Link
                                  href={`/projects/${project.uuid}/dashboard`}
                                  draggable={false}
                                  onClick={(e) => {
                                    if (snapshot.isDragging) e.preventDefault();
                                  }}
                                >
                                  {viewMode === "grid" ? (
                                    <div className={snapshot.isDragging ? "rotate-1 opacity-90 shadow-md" : ""}>
                                      <ProjectGridCard project={project} />
                                    </div>
                                  ) : (
                                    <div
                                      className={`transition-colors hover:bg-[#F5F2EC] ${
                                        snapshot.isDragging
                                          ? "rotate-1 opacity-90 shadow-md rounded-lg bg-white"
                                          : ""
                                      }`}
                                    >
                                      <ProjectListRow project={project} showDivider={index < projects.length - 1} />
                                    </div>
                                  )}
                                </Link>
                              </div>
                            )}
                          </Draggable>
                        ))}
                      </div>
                    )}
                    {provided.placeholder}
                  </div>
                </CollapsibleContent>
              </Card>
            </Collapsible>
          </div>
        );
      }}
    </Droppable>
  );
}

interface PendingMove {
  projectUuid: string;
  projectName: string;
  sourceGroupName: string;
  targetGroupUuid: string | null;
  targetGroupName: string;
}

export default function ProjectsPage() {
  const t = useTranslations();
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [groups, setGroups] = useState<ProjectGroupData[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("chorus_projects_view_mode");
      if (saved === "list" || saved === "grid") return saved;
    }
    return "list";
  });
  useEffect(() => {
    localStorage.setItem("chorus_projects_view_mode", viewMode);
  }, [viewMode]);

  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [createProjectTarget, setCreateProjectTarget] = useState<{ groupUuid: string | null; groupName: string } | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [projectsRes, groupsRes] = await Promise.all([
        fetch("/api/projects?pageSize=200"),
        fetch("/api/project-groups"),
      ]);
      const projectsJson = await projectsRes.json();
      const groupsJson = await groupsRes.json();
      if (projectsJson.success) {
        setProjects(projectsJson.data.data || projectsJson.data || []);
      }
      if (groupsJson.success) {
        setGroups(groupsJson.data.groups || []);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Group projects by groupUuid
  const projectsByGroup = new Map<string, ProjectData[]>();
  const ungroupedProjects: ProjectData[] = [];

  for (const project of projects) {
    if (project.groupUuid) {
      const existing = projectsByGroup.get(project.groupUuid) || [];
      existing.push(project);
      projectsByGroup.set(project.groupUuid, existing);
    } else {
      ungroupedProjects.push(project);
    }
  }

  // Compute stats for each group
  function getGroupStats(groupProjects: ProjectData[]) {
    let totalTasks = 0;
    let completedTasks = 0;
    let openIdeas = 0;
    for (const p of groupProjects) {
      totalTasks += p.counts.tasks;
      completedTasks += p.counts.doneTasks;
      openIdeas += p.counts.ideas;
    }
    return { totalTasks, completedTasks, openIdeas };
  }

  function getGroupName(groupUuid: string | null): string {
    if (!groupUuid) return t("projectGroups.ungrouped");
    const group = groups.find((g) => g.uuid === groupUuid);
    return group?.name ?? t("projectGroups.ungrouped");
  }

  function handleDragEnd(result: DropResult) {
    const { destination, source, draggableId } = result;

    // Dropped outside a droppable
    if (!destination) return;

    // Dropped in the same group
    if (destination.droppableId === source.droppableId) return;

    // Find the project that was dragged
    const project = projects.find((p) => p.uuid === draggableId);
    if (!project) return;

    const targetGroupUuid =
      destination.droppableId === UNGROUPED_DROPPABLE_ID
        ? null
        : destination.droppableId;
    const sourceGroupUuid = project.groupUuid;

    setPendingMove({
      projectUuid: project.uuid,
      projectName: project.name,
      sourceGroupName: getGroupName(sourceGroupUuid),
      targetGroupUuid,
      targetGroupName: getGroupName(targetGroupUuid),
    });
  }

  async function handleConfirmMove() {
    if (!pendingMove) return;
    const res = await fetch(`/api/projects/${pendingMove.projectUuid}/group`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupUuid: pendingMove.targetGroupUuid }),
    });
    const json = await res.json();
    if (!json.success) {
      throw new Error(json.error || t("projectGroups.moveFailed"));
    }
    // Refresh data
    await fetchData();
  }

  if (loading) {
    return (
      <div className="bg-[#FAF8F4] p-4 md:px-8 md:py-6">
        <div className="mx-auto max-w-[1200px]">
          <p className="text-sm text-[#6B6B6B]">
            {t("projects.loadingProjects")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="bg-[#FAF8F4] p-4 md:px-8 md:py-6">
        <div className="mx-auto max-w-[1200px]">
          {/* Header */}
          <div className="mb-4 md:mb-6">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-semibold text-[#2C2C2C]">
                {t("projects.title")}
              </h1>
              <div className="flex items-center gap-3">
                {/* View toggle — desktop only, mobile always uses list */}
                <div className="hidden overflow-hidden rounded-lg border border-[#E5E2DC] md:flex">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setViewMode("list")}
                    className={`flex items-center gap-1.5 rounded-none px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      viewMode === "list"
                        ? "bg-[#F5F2EC] text-[#C67A52]"
                        : "text-[#9A9A9A] hover:text-[#6B6B6B]"
                    }`}
                  >
                    <List className="h-3.5 w-3.5" />
                    {t("projects.listView")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setViewMode("grid")}
                    className={`flex items-center gap-1.5 rounded-none px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      viewMode === "grid"
                        ? "bg-[#F5F2EC] text-[#C67A52]"
                        : "text-[#9A9A9A] hover:text-[#6B6B6B]"
                    }`}
                  >
                    <Grid2X2 className="h-3.5 w-3.5" />
                    {t("projects.gridView")}
                  </Button>
                </div>
                <Button
                  className="hidden rounded-xl bg-[#C67A52] px-5 text-white hover:bg-[#B56A42] md:flex"
                  onClick={() => setShowCreateGroup(true)}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {t("projectGroups.newProjectGroup")}
                </Button>
              </div>
            </div>
            <p className="mt-1 text-sm text-[#6B6B6B]">
              {t("projects.subtitle")}
            </p>
          </div>

          {projects.length === 0 && groups.length === 0 ? (
            <Card className="flex flex-col items-center justify-center border-[#E5E0D8] p-12 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#F5F2EC]">
                <FolderOpen className="h-8 w-8 text-[#C67A52]" />
              </div>
              <h3 className="mb-2 text-lg font-medium text-[#2C2C2C]">
                {t("projects.noProjects")}
              </h3>
              <p className="mb-6 max-w-sm text-sm text-[#6B6B6B]">
                {t("projects.noProjectsDesc")}
              </p>
              <Link href="/projects/new">
                <Button className="bg-[#C67A52] text-white hover:bg-[#B56A42]">
                  {t("projects.createFirst")}
                </Button>
              </Link>
            </Card>
          ) : (
            <div className="space-y-4">
              {/* Groups */}
              {groups.map((group, index) => {
                const groupProjects = projectsByGroup.get(group.uuid) || [];
                const stats = getGroupStats(groupProjects);
                return (
                  <GroupSection
                    key={group.uuid}
                    group={group}
                    projects={groupProjects}
                    stats={stats}
                    defaultOpen={index === 0}
                    viewMode={viewMode}
                    onNewProject={() => setCreateProjectTarget({ groupUuid: group.uuid, groupName: group.name })}
                  />
                );
              })}

              {/* Ungrouped */}
              <UngroupedSection
                projects={ungroupedProjects}
                viewMode={viewMode}
                onNewProject={() => setCreateProjectTarget({ groupUuid: null, groupName: t("projectGroups.ungrouped") })}
              />

              {/* Mobile: full-width New Project Group button */}
              <Button
                className="w-full rounded-xl bg-[#C67A52] text-white hover:bg-[#B56A42] md:hidden"
                onClick={() => setShowCreateGroup(true)}
              >
                <Plus className="mr-2 h-4 w-4" />
                {t("projectGroups.newProjectGroup")}
              </Button>
            </div>
          )}
        </div>
        </div>
      </DragDropContext>

      {/* Move confirmation dialog */}
      <MoveProjectConfirmDialog
        open={pendingMove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingMove(null);
        }}
        projectName={pendingMove?.projectName ?? ""}
        sourceGroupName={pendingMove?.sourceGroupName ?? ""}
        targetGroupName={pendingMove?.targetGroupName ?? ""}
        onConfirm={handleConfirmMove}
      />

      {/* Create Project Group dialog */}
      <CreateProjectGroupDialog
        open={showCreateGroup}
        onOpenChange={setShowCreateGroup}
        onCreated={() => {
          setShowCreateGroup(false);
          fetchData();
        }}
      />

      {/* Create Project dialog */}
      <CreateProjectDialog
        open={createProjectTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCreateProjectTarget(null);
        }}
        groupUuid={createProjectTarget?.groupUuid ?? null}
        groupName={createProjectTarget?.groupName ?? ""}
        onCreated={() => {
          setCreateProjectTarget(null);
          fetchData();
        }}
      />
    </>
  );
}
