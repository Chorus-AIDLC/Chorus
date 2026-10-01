"use client";

// Project access level for the current /projects/[uuid]/** subtree.
//
// The server layout (src/app/(dashboard)/projects/[uuid]/layout.tsx) resolves
// the caller's level once via requireProjectPageAccess and provides it here, so
// any client component under a project page can read it without prop-drilling.
//
// This is UX only — the server already rejects Viewer writes (403). Components
// use it to hide / disable create & edit affordances that would just fail.
//
// Default (no provider) is "editor": surfaces rendered outside a project layout
// (and existing tests that don't mount a provider) keep their full UI.

import { createContext, useContext, type ReactNode } from "react";

export type ProjectAccessLevel = "viewer" | "editor" | "admin";

export const DEFAULT_PROJECT_ACCESS_LEVEL: ProjectAccessLevel = "editor";

const ProjectAccessContext = createContext<ProjectAccessLevel>(DEFAULT_PROJECT_ACCESS_LEVEL);

export function ProjectAccessProvider({
  accessLevel,
  children,
}: {
  accessLevel: ProjectAccessLevel;
  children: ReactNode;
}) {
  return (
    <ProjectAccessContext.Provider value={accessLevel}>
      {children}
    </ProjectAccessContext.Provider>
  );
}

/** The caller's access level in the current project ("editor" when no provider). */
export function useProjectAccessLevel(): ProjectAccessLevel {
  return useContext(ProjectAccessContext);
}

/** Pure helper: may this level create / edit / comment on project content? */
export function canEditProjectContent(level: ProjectAccessLevel): boolean {
  return level !== "viewer";
}

/** True when the caller may create / edit / comment in the current project. */
export function useCanEditProject(): boolean {
  return canEditProjectContent(useProjectAccessLevel());
}
