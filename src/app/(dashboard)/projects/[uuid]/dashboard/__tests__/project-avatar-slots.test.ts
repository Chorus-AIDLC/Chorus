import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = "src/app/(dashboard)/projects/[uuid]";
const source = (file: string) => readFileSync(resolve(projectRoot, file), "utf8");

describe("audited project avatar slots", () => {
  it.each([
    ["dashboard/panels/assignee-section.tsx", "assignee"],
    ["dashboard/panels/task-list-view.tsx", "task.assignee"],
    ["ideas/idea-detail-panel.tsx", "idea.assignee"],
    ["tasks/task-detail-panel.tsx", "task.assignee"],
    ["tasks/kanban-board.tsx", "task.assignee"],
    ["ideas/assign-idea-modal.tsx", "user"],
    ["tasks/assign-task-modal.tsx", "user"],
    ["proposals/proposal-kanban.tsx", "proposal.createdBy"],
    ["proposals/[proposalUuid]/page.tsx", "proposal.createdBy"],
  ])("forwards resolved identity through the shared wrapper in %s", (file, identity) => {
    const content = source(file);
    expect(content).toContain('import { UserIdentityAvatar as UserAvatar } from "@/components/user-identity-avatar"');
    expect(content).toContain(`userUuid={${identity}.uuid} name={${identity}.name} avatarSeed={${identity}.avatarSeed}`);
    expect(content).not.toContain("charAt(0)");
    expect(content).not.toContain("AvatarFallback");
  });

  it("retains semantic actions, creator categories, project initials, and text-only member/assignee rows", () => {
    expect(source("ideas/idea-detail-panel.tsx")).toContain('<User className="h-4 w-4" />');
    expect(source("tasks/task-detail-panel.tsx")).toContain('<User className="mr-2 h-4 w-4" />');
    expect(source("proposals/[proposalUuid]/page.tsx")).toContain('<><User className="h-3 w-3 text-muted-foreground" />{t("common.user")}</>');
    expect(source("../page.tsx")).toContain("getProjectInitials(project.name)");
    expect(source("dashboard/project-access-tab.tsx")).not.toContain("UserAvatar");
    expect(source("tasks/task-view-toggle.tsx")).not.toContain("UserAvatar");
    expect(source("dashboard/panels/activity-timeline.tsx")).not.toContain("UserAvatar");
  });
});
