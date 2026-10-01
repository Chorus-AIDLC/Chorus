import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => {
  class ProjectNotFoundError extends Error {
    constructor() {
      super("not found");
      this.name = "ProjectNotFoundError";
    }
  }
  return {
    auth: vi.fn(),
    getProjectAccess: vi.fn(),
    requireEntityAccess: vi.fn(),
    ProjectNotFoundError,
    notFound: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND");
    }),
    redirect: vi.fn((url: string) => {
      throw new Error(`NEXT_REDIRECT:${url}`);
    }),
  };
});

vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/auth-server", () => ({ getServerAuthContext: mocks.auth }));
vi.mock("@/services/project-access.service", () => ({
  getProjectAccess: mocks.getProjectAccess,
  requireEntityAccess: mocks.requireEntityAccess,
  ProjectNotFoundError: mocks.ProjectNotFoundError,
}));

import ProjectLayout from "../layout";
import DashboardIdeaRedirect from "../dashboard/[ideaUuid]/page";
import {
  canViewEntityInProject,
  requireEntityInProject,
  requireProjectPageAccess,
} from "../access-guard";

const AUTH = { type: "user", companyUuid: "company-1", actorUuid: "user-1" };
const PROJECT = { uuid: "project-1", name: "P1", visibility: "private" };

async function renderLayout(uuid = "project-1") {
  const el = await ProjectLayout({
    children: <p>child-content</p>,
    params: Promise.resolve({ uuid }),
  });
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(AUTH);
});

describe("projects/[uuid] layout", () => {
  it("calls notFound() when access level is none", async () => {
    mocks.getProjectAccess.mockResolvedValue({ project: null, level: "none" });
    await expect(renderLayout()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getProjectAccess).toHaveBeenCalledWith(AUTH, "project-1");
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it.each(["editor", "admin"])("renders children unchanged for level %s", async (level) => {
    mocks.getProjectAccess.mockResolvedValue({ project: PROJECT, level });
    const html = await renderLayout();
    expect(html).toBe("<p>child-content</p>");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("renders children plus the read-only banner for viewers", async () => {
    mocks.getProjectAccess.mockResolvedValue({ project: PROJECT, level: "viewer" });
    const html = await renderLayout();
    expect(html).toContain("<p>child-content</p>");
    expect(html).toContain('data-testid="project-read-only-banner"');
    expect(html).toContain("projectAccess.viewerBanner");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("redirects unauthenticated users to /login without resolving access", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(renderLayout()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(mocks.getProjectAccess).not.toHaveBeenCalled();
  });
});

describe("requireProjectPageAccess", () => {
  it("returns auth, project and accessLevel", async () => {
    mocks.getProjectAccess.mockResolvedValue({ project: PROJECT, level: "viewer" });
    await expect(requireProjectPageAccess("project-1")).resolves.toEqual({
      auth: AUTH,
      project: PROJECT,
      accessLevel: "viewer",
    });
  });

  it("calls notFound() when the project row is missing", async () => {
    mocks.getProjectAccess.mockResolvedValue({ project: null, level: "none" });
    await expect(requireProjectPageAccess("missing")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("canViewEntityInProject / requireEntityInProject", () => {
  it("allows an entity in the path project", async () => {
    mocks.requireEntityAccess.mockResolvedValue({ projectUuid: "project-1", accessLevel: "viewer" });
    await expect(canViewEntityInProject(AUTH as never, "task", "task-1", "project-1")).resolves.toBe(true);
    expect(mocks.requireEntityAccess).toHaveBeenCalledWith(AUTH, "task", "task-1", "viewer");
    await expect(requireEntityInProject(AUTH as never, "task", "task-1", "project-1")).resolves.toBeUndefined();
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("rejects an entity that belongs to a different project (e.g. private entity under a public URL)", async () => {
    mocks.requireEntityAccess.mockResolvedValue({ projectUuid: "private-project", accessLevel: "editor" });
    await expect(canViewEntityInProject(AUTH as never, "document", "doc-1", "public-project")).resolves.toBe(false);
    await expect(requireEntityInProject(AUTH as never, "document", "doc-1", "public-project")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("rejects missing / inaccessible entities (ProjectNotFoundError)", async () => {
    mocks.requireEntityAccess.mockRejectedValue(new mocks.ProjectNotFoundError());
    await expect(canViewEntityInProject(AUTH as never, "proposal", "p-1", "project-1")).resolves.toBe(false);
    await expect(requireEntityInProject(AUTH as never, "proposal", "p-1", "project-1")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("rethrows unexpected errors", async () => {
    mocks.requireEntityAccess.mockRejectedValue(new Error("db down"));
    await expect(canViewEntityInProject(AUTH as never, "idea", "i-1", "project-1")).rejects.toThrow("db down");
  });
});

describe("dashboard/[ideaUuid] redirect page", () => {
  const call = () =>
    DashboardIdeaRedirect({
      params: Promise.resolve({ uuid: "project-1", ideaUuid: "idea-1" }),
      searchParams: Promise.resolve({ tab: "proposal" }),
    });

  it("redirects to the panel URL when the idea is in the project", async () => {
    mocks.getProjectAccess.mockResolvedValue({ project: PROJECT, level: "viewer" });
    mocks.requireEntityAccess.mockResolvedValue({ projectUuid: "project-1", accessLevel: "viewer" });
    await expect(call()).rejects.toThrow("NEXT_REDIRECT:/projects/project-1/dashboard?panel=idea-1&tab=proposal");
  });

  it("404s when the idea belongs to another project", async () => {
    mocks.getProjectAccess.mockResolvedValue({ project: PROJECT, level: "editor" });
    mocks.requireEntityAccess.mockResolvedValue({ projectUuid: "other", accessLevel: "editor" });
    await expect(call()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
