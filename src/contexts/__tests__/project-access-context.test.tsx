// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  DEFAULT_PROJECT_ACCESS_LEVEL,
  ProjectAccessProvider,
  canEditProjectContent,
  useCanEditProject,
  useProjectAccessLevel,
  type ProjectAccessLevel,
} from "@/contexts/project-access-context";

const wrapperFor = (level: ProjectAccessLevel) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <ProjectAccessProvider accessLevel={level}>{children}</ProjectAccessProvider>;
  };

describe("project-access-context", () => {
  it("defaults to editor when no provider is mounted", () => {
    expect(DEFAULT_PROJECT_ACCESS_LEVEL).toBe("editor");
    expect(renderHook(() => useProjectAccessLevel()).result.current).toBe("editor");
    expect(renderHook(() => useCanEditProject()).result.current).toBe(true);
  });

  it.each([
    ["viewer", false],
    ["editor", true],
    ["admin", true],
  ] as const)("provides %s (canEdit=%s)", (level, canEdit) => {
    const wrapper = wrapperFor(level);
    expect(renderHook(() => useProjectAccessLevel(), { wrapper }).result.current).toBe(level);
    expect(renderHook(() => useCanEditProject(), { wrapper }).result.current).toBe(canEdit);
    expect(canEditProjectContent(level)).toBe(canEdit);
  });
});
