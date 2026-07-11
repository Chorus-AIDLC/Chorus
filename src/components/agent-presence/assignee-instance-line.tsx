"use client";

// A compact, presentational (host, cwd) line for an `agent_instance` assignee —
// the pinned daemon place an Idea/Task is assigned to. Reuses the shared
// daemon-instance-format helpers (formatCwd / formatHost) so truncation and the
// "unknown path / host" sentinels match every other instance surface. Rendered
// UNDER the assignee's agent name (the name resolves to the owning agent via
// getActorName on the server), so this line answers "which place" not "who".
//
// Path-first: the cwd is primary (a monospace folder chip); the host is a
// de-emphasized suffix shown only when `showHost` is set (the caller decides via
// the same "2+ distinct hosts" rule the picker uses, or always-on in a single
// detail view where the host is useful context).

import { useTranslations } from "next-intl";
import { Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCwd, formatHost } from "@/lib/daemon-instance-format";

export interface AssigneeInstanceLineProps {
  /** Working directory of the pinned instance (null = legacy unknown-path). */
  cwd: string | null;
  /** Host of the pinned instance ("" = unknown host). */
  host: string;
  /** Whether to render the de-emphasized host suffix. Default true. */
  showHost?: boolean;
  className?: string;
}

export function AssigneeInstanceLine({
  cwd,
  host,
  showHost = true,
  className,
}: AssigneeInstanceLineProps) {
  const t = useTranslations();
  const formattedCwd = formatCwd(cwd);
  const cwdLabel = formattedCwd.isUnknown ? t(formattedCwd.label) : formattedCwd.label;
  const cwdTitle = formattedCwd.isUnknown ? t(formattedCwd.title) : formattedCwd.title;

  const formattedHost = formatHost(host);
  const hostLabel = formattedHost.isUnknown ? t(formattedHost.label) : formattedHost.label;
  const hostTitle = formattedHost.isUnknown ? t(formattedHost.title) : formattedHost.title;

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span
        title={cwdTitle}
        className={cn(
          "inline-flex min-w-0 items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5",
          "font-mono text-[10px]",
          formattedCwd.isUnknown ? "italic text-muted-foreground" : "text-muted-foreground",
        )}
      >
        <Folder className="size-2.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{cwdLabel}</span>
      </span>
      {showHost && (
        <span
          title={hostTitle}
          className="shrink-0 truncate font-mono text-[10px] text-muted-foreground"
        >
          {hostLabel}
        </span>
      )}
    </span>
  );
}
