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
function buildForest(ideas: IdeaCardItem[]): FlatRow[][] {
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

  // Each top-level root becomes its own group (a list of DFS-ordered rows). A
  // `visited` set guards against cyclic data so rendering always terminates.
  const groups: FlatRow[][] = [];
  const visited = new Set<string>();
  const walk = (idea: IdeaCardItem, depth: number, into: FlatRow[]) => {
    if (visited.has(idea.uuid)) return;
    visited.add(idea.uuid);
    into.push({ idea, depth, showConnector: depth > 0 });
    for (const child of childrenByParent.get(idea.uuid) ?? []) {
      walk(child, depth + 1, into);
    }
  };
  for (const root of roots) {
    const group: FlatRow[] = [];
    walk(root, 0, group);
    if (group.length > 0) groups.push(group);
  }
  // Any idea not reached (defensive against cyclic data) becomes its own group.
  for (const idea of ideas) {
    if (!visited.has(idea.uuid)) {
      visited.add(idea.uuid);
      groups.push([{ idea, depth: 0, showConnector: false }]);
    }
  }
  return groups;
}

export function IdeaLineageTree({ ideas, onIdeaClick }: IdeaLineageTreeProps) {
  const groups = useMemo(() => buildForest(ideas), [ideas]);

  // Each top-level lineage tree is its own white block; the space-y gaps between
  // blocks reveal the page background (#FAF8F4), so groups read as distinct
  // cards rather than one continuous white list.
  return (
    <div className="space-y-2.5">
      {groups.map((group) => (
        <div
          key={group[0].idea.uuid}
          data-testid="lineage-tree-group"
          className="overflow-hidden rounded-lg bg-white"
        >
          {group.map((row, idx) => (
            <div key={row.idea.uuid}>
              {/* Tight hairline between rows inside the same tree. */}
              {idx > 0 && <div className="mx-0 h-px bg-[#F0EEEA]" />}
              <PresenceIndicator entityType="idea" entityUuid={row.idea.uuid} badgeInside>
                <IdeaCard
                  idea={row.idea}
                  onClick={onIdeaClick}
                  depth={row.depth}
                  showConnector={row.showConnector}
                />
              </PresenceIndicator>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
