"use client";

// Sidebar project quick-access region — pinned + recently-visited projects.
//
// Rendered inside SidebarContent (src/app/(dashboard)/layout.tsx) in BOTH the
// desktop aside and the mobile Sheet, below the nav block and above the footer.
// It CONSUMES the shared ProjectQuickAccessProvider (no fetch of its own) so a
// pin/unpin/visit from any surface is reflected here immediately, no reload.
//
// Layout: one merged list — pinned rows first (filled pin icon, pin-time order),
// then up to 5 recent rows (outline pin icon revealed on hover/focus). Each row
// links to the project dashboard and shows the group name as a sub-line when the
// project belongs to a group.
//
// Placement rules (driven by `collapsedInProject`):
//   - Global pages (project list / groups / settings): always expanded, a quiet
//     section label, no toggle. Renders nothing when there are no rows.
//   - Inside a project: collapses to a clickable "Projects" header row with a
//     chevron so the current project's nav stays primary. The expand/collapse
//     choice persists per-device (localStorage) and the header always shows for
//     discoverability, even when empty.
//
// Theming: semantic tokens only (bg/secondary/foreground/muted-foreground,
// text-primary for the active pin) so light + dark both work with no hardcoded
// hex. All strings via next-intl.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Pin, MoreHorizontal, ChevronDown, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useProjectQuickAccess,
  type QuickAccessProjectRef,
} from "@/contexts/project-quick-access-context";
import {
  readQuickAccessExpanded,
  writeQuickAccessExpanded,
} from "@/app/(dashboard)/projects/sidebar-quick-access-collapse-preference";
import {
  getProjectInitials,
  getProjectIconColor,
  projectIconStyle,
} from "@/lib/project-colors";

/** Recent rows shown (the service already caps this; we slice defensively). */
const RECENT_LIMIT = 5;

interface SidebarProjectQuickAccessProps {
  mobile?: boolean;
  /** True inside a project — collapses the region to a header row by default. */
  collapsedInProject?: boolean;
}

function QuickAccessRow({
  project,
  pinnedRow,
  mobile,
  onPin,
  onUnpin,
  onRemove,
}: {
  project: QuickAccessProjectRef;
  /** True when this row is a pinned project (filled marker + direct unpin). */
  pinnedRow: boolean;
  mobile: boolean;
  onPin: (uuid: string) => void;
  onUnpin: (uuid: string) => void;
  onRemove: (uuid: string) => void;
}) {
  const t = useTranslations();
  const nameSize = mobile ? "text-[14px]" : "text-[13px]";
  // Sidebar-sized project icon — same hash color + initials as the /projects
  // list, but scaled down to fit the 220px sidebar row (20px desktop / 24px
  // mobile) vs. the list's 32-36px badge.
  const initials = getProjectInitials(project.name);
  const iconColor = getProjectIconColor(project.name);
  const iconSize = mobile
    ? "h-6 w-6 rounded-md text-[9px]"
    : "h-5 w-5 rounded text-[8px]";

  // The action control lives OUTSIDE the <Link> (sibling), so activating it
  // never navigates. Pinned rows keep a one-tap unpin button; recent rows get
  // a ⋯ overflow menu ({ Pin to sidebar, Remove from recent }).
  //
  // Reveal rules: mobile has no hover, so the trigger is always visible there;
  // on desktop it fades in on row hover / keyboard focus (matching the prior
  // pin button's affordance).
  const revealClass = mobile
    ? ""
    : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100";

  return (
    <div className="group relative flex items-center rounded-md transition-colors hover:bg-secondary">
      <Link
        href={`/projects/${project.uuid}/dashboard`}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 leading-tight"
      >
        <span
          className={`project-icon flex shrink-0 items-center justify-center font-bold ${iconSize}`}
          style={projectIconStyle(iconColor)}
          aria-hidden="true"
        >
          {initials}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className={`truncate text-foreground ${nameSize}`}>
            {project.name}
          </span>
          {project.groupName && (
            <span className="truncate text-[11px] text-muted-foreground">
              {project.groupName}
            </span>
          )}
        </span>
      </Link>

      {pinnedRow ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onUnpin(project.uuid)}
          aria-label={t("quickAccess.unpinProject", { name: project.name })}
          title={t("quickAccess.unpin")}
          className="mr-1 h-6 w-6 shrink-0 text-primary hover:text-primary"
        >
          <Pin className="h-3.5 w-3.5 fill-current" />
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("quickAccess.moreActions", { name: project.name })}
              className={`mr-1 h-6 w-6 shrink-0 text-muted-foreground hover:text-primary data-[state=open]:opacity-100 ${revealClass}`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[10rem]">
            <DropdownMenuItem onClick={() => onPin(project.uuid)}>
              <Pin className="h-4 w-4" />
              {t("quickAccess.pinToSidebar")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onRemove(project.uuid)}>
              <X className="h-4 w-4" />
              {t("quickAccess.removeFromRecent")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function SidebarProjectQuickAccess({
  mobile = false,
  collapsedInProject = false,
}: SidebarProjectQuickAccessProps) {
  const t = useTranslations();
  const { pinned, recent, pin, unpin, remove } = useProjectQuickAccess();

  // In-project: seed collapsed (the SSR-safe default so server/first-client
  // markup agree), then hydrate the persisted choice after mount. Global pages
  // are always expanded — the toggle state is ignored there.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (collapsedInProject) {
      setExpanded(readQuickAccessExpanded());
    }
  }, [collapsedInProject]);

  const toggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev;
      writeQuickAccessExpanded(next);
      return next;
    });
  };

  const recentCapped = recent.slice(0, RECENT_LIMIT);
  const hasRows = pinned.length + recentCapped.length > 0;
  const isExpanded = collapsedInProject ? expanded : true;

  // Global pages with no rows: render nothing (no empty-header noise). Inside a
  // project the header still shows for discoverability, so only bail here.
  if (!collapsedInProject && !hasRows) return null;

  const headerTextSize = mobile ? "text-[13px]" : "text-[11px]";

  return (
    <div className="flex flex-col gap-0.5 px-4">
      {collapsedInProject ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleExpanded}
          aria-expanded={isExpanded}
          className={`w-full justify-start gap-2 px-2 font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground ${headerTextSize}`}
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate">{t("quickAccess.title")}</span>
        </Button>
      ) : (
        <div
          className={`px-2 pb-1 font-medium uppercase tracking-wider text-muted-foreground ${headerTextSize}`}
        >
          {t("quickAccess.title")}
        </div>
      )}

      {isExpanded && hasRows && (
        <div className="flex flex-col gap-0.5">
          {pinned.map((project) => (
            <QuickAccessRow
              key={project.uuid}
              project={project}
              pinnedRow
              mobile={mobile}
              onPin={pin}
              onUnpin={unpin}
              onRemove={remove}
            />
          ))}
          {recentCapped.map((project) => (
            <QuickAccessRow
              key={project.uuid}
              project={project}
              pinnedRow={false}
              mobile={mobile}
              onPin={pin}
              onUnpin={unpin}
              onRemove={remove}
            />
          ))}
        </div>
      )}
    </div>
  );
}
