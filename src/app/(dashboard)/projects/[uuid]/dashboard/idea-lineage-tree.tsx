"use client";

import { useMemo } from "react";
import { PresenceIndicator } from "@/components/ui/presence-indicator";
import { IdeaCard, type IdeaCardItem } from "./idea-card";

interface IdeaLineageTreeProps {
  ideas: IdeaCardItem[];
  onIdeaClick?: (uuid: string) => void;
}

// A flattened tree row: the idea plus its depth and whether to draw a connector.
interface FlatRow {
  idea: IdeaCardItem;
  depth: number;
  showConnector: boolean;
}

/**
 * Flatten the single-parent forest into a depth-first ordered list of rows.
 *
 * - Roots = ideas with no parentUuid, OR whose parentUuid is not present in the
 *   current set (e.g. filtered out / on another page) — those are treated as
 *   roots so nothing is silently dropped.
 * - A `visited` set guards against any cyclic data so rendering always
 *   terminates (the server prevents cycles, but the UI must never hang).
 */
function buildForest(ideas: IdeaCardItem[]): FlatRow[] {
  const byUuid = new Map(ideas.map((i) => [i.uuid, i]));
  const childrenByParent = new Map<string, IdeaCardItem[]>();
  const roots: IdeaCardItem[] = [];

  for (const idea of ideas) {
    const parentUuid = idea.parentUuid ?? null;
    if (parentUuid && byUuid.has(parentUuid)) {
      const siblings = childrenByParent.get(parentUuid) ?? [];
      siblings.push(idea);
      childrenByParent.set(parentUuid, siblings);
    } else {
      roots.push(idea);
    }
  }

  const rows: FlatRow[] = [];
  const visited = new Set<string>();
  const walk = (idea: IdeaCardItem, depth: number) => {
    if (visited.has(idea.uuid)) return;
    visited.add(idea.uuid);
    rows.push({ idea, depth, showConnector: depth > 0 });
    for (const child of childrenByParent.get(idea.uuid) ?? []) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  // Any idea not reached (defensive against cyclic data) is appended as a root.
  for (const idea of ideas) {
    if (!visited.has(idea.uuid)) rows.push({ idea, depth: 0, showConnector: false });
  }
  return rows;
}

export function IdeaLineageTree({ ideas, onIdeaClick }: IdeaLineageTreeProps) {
  const rows = useMemo(() => buildForest(ideas), [ideas]);

  return (
    <div className="overflow-hidden rounded-lg bg-white">
      {rows.map((row, idx) => {
        // A depth-0 row after the first one starts a new top-level tree
        // (buildForest is DFS-ordered, so every depth===0 marks a fresh root).
        // Separate unrelated trees with a larger vertical gap so each lineage
        // tree reads as one group; keep the tight hairline for in-tree rows.
        const isTreeBoundary = idx > 0 && row.depth === 0;
        return (
          <div key={row.idea.uuid}>
            {isTreeBoundary ? (
              <div className="h-2.5" data-testid="lineage-tree-gap" aria-hidden />
            ) : (
              idx > 0 && <div className="mx-0 h-px bg-[#F0EEEA]" />
            )}
            <PresenceIndicator entityType="idea" entityUuid={row.idea.uuid} badgeInside>
              <IdeaCard
                idea={row.idea}
                onClick={onIdeaClick}
                depth={row.depth}
                showConnector={row.showConnector}
              />
            </PresenceIndicator>
          </div>
        );
      })}
    </div>
  );
}
