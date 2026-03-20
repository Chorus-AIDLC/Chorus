"use client";

import { useCallback, useEffect, useState } from "react";
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
import { Progress } from "@/components/ui/progress";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Plus,
  FolderOpen,
  Lightbulb,
  ClipboardList,
  FileText,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Folder,
} from "lucide-react";
import { MoveProjectConfirmDialog } from "@/components/move-project-confirm-dialog";
import { CreateProjectGroupDialog } from "@/components/create-project-group-dialog";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { StaggerList, StaggerItem } from "@/components/stagger-list";

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

// Avatar color palette based on project name hash
const AVATAR_COLORS = [
  "#C67A52", // terracotta
  "#1976D2", // blue
  "#5A9E6F", // green
  "#8E6BBF", // purple
  "#D4805A", // warm orange
  "#2E86AB", // teal
  "#A45A52", // muted red
  "#6B8E5A", // olive
];

function getProjectInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
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

const UNGROUPED_DROPPABLE_ID = "__ungrouped__";

function ProjectCardContent({ project }: { project: ProjectData }) {
  const t = useTranslations();
  const formatRelative = useRelativeDate();
  const initials = getProjectInitials(project.name);
  const avatarColor = getAvatarColor(project.name);
  const progress = project.counts.tasks > 0
    ? Math.round((project.counts.doneTasks / project.counts.tasks) * 100)
    : 0;

  return (
    <Card className="group cursor-pointer rounded-2xl border-[#E5E2DC] p-6 shadow-none transition-all hover:border-[#C67A52] hover:shadow-md">
      {/* Header: Avatar + Name + Badge */}
      <div className="mb-3 flex items-start gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white"
          style={{ backgroundColor: avatarColor }}
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-semibold text-[#2C2C2C] group-hover:text-[#C67A52]">
              {project.name}
            </h3>
            <Badge
              variant="success"
              className="gap-1 border-0 bg-[#5A9E6F15] text-[10px] text-[#5A9E6F]"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[#5A9E6F]" />
              {t("status.active")}
            </Badge>
          </div>
          {project.description && (
            <p className="mt-0.5 line-clamp-1 text-xs text-[#6B6B6B]">
              {project.description}
            </p>
          )}
        </div>
      </div>

      {/* Progress Bar */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] text-[#9A9A9A]">
            {t("projects.taskProgress")}
          </span>
          <span className="text-[11px] font-medium text-[#2C2C2C]">
            {progress}%
          </span>
        </div>
        <Progress value={progress} />
      </div>

      {/* Stats Row */}
      <div className="flex items-center justify-between text-[11px] text-[#9A9A9A]">
        <div className="flex flex-wrap gap-3">
          <span className="flex items-center gap-1">
            <ClipboardList className="h-3 w-3" />
            {project.counts.tasks} {t("projects.tasks")}
          </span>
          <span className="flex items-center gap-1">
            <Lightbulb className="h-3 w-3" />
            {project.counts.ideas} {t("projects.ideas")}
          </span>
          <span className="flex items-center gap-1">
            <FileText className="h-3 w-3" />
            {project.counts.documents} {t("projects.docs")}
          </span>
        </div>
        <span>
          {t("projects.updated")} {formatRelative(project.updatedAt)}
        </span>
      </div>
    </Card>
  );
}

function GroupSection({
  group,
  projects,
  stats,
  onNewProject,
}: {
  group: ProjectGroupData;
  projects: ProjectData[];
  stats: { totalTasks: number; completedTasks: number; openIdeas: number };
  onNewProject: () => void;
}) {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(false);
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
              className={`rounded-2xl border-[#E5E2DC] p-0 shadow-none transition-colors hover:border-[#C67A52]/40 ${
                snapshot.isDraggingOver
                  ? "border-[#C67A52] bg-[#C67A5208]"
                  : ""
              }`}
            >
              {/* Group Header */}
              <div className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:justify-between md:px-6 md:py-4">
                <CollapsibleTrigger className="flex flex-1 cursor-pointer items-center gap-3 text-left">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#C67A5215]">
                    <Folder className="h-4 w-4 text-[#C67A52]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-base font-semibold text-[#2C2C2C]">
                        {group.name}
                      </h2>
                      <Badge
                        variant="secondary"
                        className="shrink-0 border-0 bg-[#F0EDE8] text-[11px] font-medium text-[#6B6B6B]"
                      >
                        {projects.length} {t("projectGroups.projectCount")}
                      </Badge>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[#9A9A9A]">
                      <span>
                        {stats.totalTasks} {t("projects.tasks")} &middot;{" "}
                        {completionRate}% {t("projectGroups.complete")}
                      </span>
                      <span>
                        {stats.openIdeas} {t("projectGroups.openIdeas")}
                      </span>
                    </div>
                  </div>
                  {isOpen ? (
                    <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-[#9A9A9A]" />
                  ) : (
                    <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-[#9A9A9A]" />
                  )}
                </CollapsibleTrigger>
                <div className={`grid grid-cols-2 gap-2 md:flex md:items-center ${isOpen ? "grid" : "hidden md:flex"}`}>
                  <Link href={`/project-groups/${group.uuid}`} className="md:w-auto">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full text-xs text-[#C67A52] hover:text-[#B56A42]"
                    >
                      {t("projectGroups.viewDashboard")}
                      <ArrowRight className="ml-1 h-3 w-3" />
                    </Button>
                  </Link>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full border-[#E5E2DC] text-xs md:w-auto"
                    onClick={onNewProject}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    {t("projects.newProject")}
                  </Button>
                </div>
              </div>

              {/* Projects Grid */}
              <CollapsibleContent>
                <div className="border-t border-[#E5E2DC] px-4 pb-4 pt-3 md:px-6 md:pb-5 md:pt-4">
                  {projects.length === 0 && !snapshot.isDraggingOver ? (
                    <p className="py-4 text-center text-sm text-[#9A9A9A]">
                      {t("projectGroups.noProjectsInGroup")}
                    </p>
                  ) : (
                    <StaggerList className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {projects.map((project, index) => (
                        <StaggerItem key={project.uuid}>
                        <Draggable
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
                                <div
                                  className={
                                    snapshot.isDragging
                                      ? "rotate-2 opacity-90 shadow-lg"
                                      : ""
                                  }
                                >
                                  <ProjectCardContent project={project} />
                                </div>
                              </Link>
                            </div>
                          )}
                        </Draggable>
                        </StaggerItem>
                      ))}
                    </StaggerList>
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

function UngroupedSection({ projects, onNewProject }: { projects: ProjectData[]; onNewProject: () => void }) {
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
                className={`rounded-2xl border-[#E5E2DC] p-0 shadow-none transition-colors hover:border-[#C67A52]/40 ${
                  snapshot.isDraggingOver
                    ? "border-[#C67A52] bg-[#C67A5208]"
                    : ""
                }`}
              >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 md:px-6 md:py-4">
                  <CollapsibleTrigger className="flex flex-1 cursor-pointer items-center gap-3 text-left">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#F0EDE8]">
                      <FolderOpen className="h-4 w-4 text-[#9A9A9A]" />
                    </div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-semibold text-[#6B6B6B]">
                        {t("projectGroups.ungrouped")}
                      </h2>
                      <Badge
                        variant="secondary"
                        className="shrink-0 border-0 bg-[#F0EDE8] text-[11px] font-medium text-[#6B6B6B]"
                      >
                        {projects.length} {t("projectGroups.projectCount")}
                      </Badge>
                    </div>
                    {isOpen ? (
                      <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-[#9A9A9A]" />
                    ) : (
                      <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-[#9A9A9A]" />
                    )}
                  </CollapsibleTrigger>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`ml-2 shrink-0 border-[#E5E2DC] text-xs md:inline-flex ${isOpen ? "inline-flex" : "hidden"}`}
                    onClick={onNewProject}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    {t("projects.newProject")}
                  </Button>
                </div>

                {/* Projects Grid */}
                <CollapsibleContent>
                  <div className="border-t border-[#E5E2DC] px-4 pb-4 pt-3 md:px-6 md:pb-5 md:pt-4">
                    {projects.length === 0 ? (
                      <p className="py-4 text-center text-sm text-[#9A9A9A]">
                        {t("projectGroups.noProjectsInGroup")}
                      </p>
                    ) : (
                      <StaggerList className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {projects.map((project, index) => (
                          <StaggerItem key={project.uuid}>
                          <Draggable
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
                                  <div
                                    className={
                                      snapshot.isDragging
                                        ? "rotate-2 opacity-90 shadow-lg"
                                        : ""
                                    }
                                  >
                                    <ProjectCardContent project={project} />
                                  </div>
                                </Link>
                              </div>
                            )}
                          </Draggable>
                          </StaggerItem>
                        ))}
                      </StaggerList>
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
      <div className="min-h-full bg-[#FAF8F4] p-4 md:p-8">
        <p className="text-sm text-[#6B6B6B]">
          {t("projects.loadingProjects")}
        </p>
      </div>
    );
  }

  return (
    <>
      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="min-h-full bg-[#FAF8F4] p-4 md:p-8">
          {/* Header */}
          <div className="mb-6 flex flex-col gap-3 md:mb-8 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-[#2C2C2C]">
                {t("projects.title")}
              </h1>
              <p className="mt-1 text-sm text-[#6B6B6B]">
                {t("projects.subtitle")}
              </p>
            </div>
            <Button
              className="rounded-xl bg-[#C67A52] px-5 text-white hover:bg-[#B56A42]"
              onClick={() => setShowCreateGroup(true)}
            >
              <Plus className="mr-2 h-4 w-4" />
              {t("projectGroups.newProjectGroup")}
            </Button>
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
            <div className="space-y-5">
              {/* Groups */}
              {groups.map((group) => {
                const groupProjects = projectsByGroup.get(group.uuid) || [];
                const stats = getGroupStats(groupProjects);
                return (
                  <GroupSection
                    key={group.uuid}
                    group={group}
                    projects={groupProjects}
                    stats={stats}
                    onNewProject={() => setCreateProjectTarget({ groupUuid: group.uuid, groupName: group.name })}
                  />
                );
              })}

              {/* Ungrouped */}
              <UngroupedSection
                projects={ungroupedProjects}
                onNewProject={() => setCreateProjectTarget({ groupUuid: null, groupName: t("projectGroups.ungrouped") })}
              />
            </div>
          )}
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
