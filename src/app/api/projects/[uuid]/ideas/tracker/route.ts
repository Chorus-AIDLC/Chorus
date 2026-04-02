// src/app/api/projects/[uuid]/ideas/tracker/route.ts
// Idea Tracker API - Returns ideas grouped by derived status
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { projectExists } from "@/services/project.service";
import {
  getIdeasWithDerivedStatus,
  DerivedIdeaStatus,
  BadgeHint,
} from "@/services/idea.service";
import { batchCommentCounts } from "@/services/comment.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// The 5 tracker columns (closed is excluded from the board view)
const TRACKER_STATUSES: DerivedIdeaStatus[] = [
  "todo",
  "in_progress",
  "human_conduct_required",
  "done",
];

// GET /api/projects/[uuid]/ideas/tracker - Ideas grouped by derived status
export const GET = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    const { uuid: projectUuid } = await context.params;

    // Validate project exists
    if (!(await projectExists(auth.companyUuid, projectUuid))) {
      return errors.notFound("Project");
    }

    // Get ideas with derived statuses (3 batch queries, no N+1)
    const ideas = await getIdeasWithDerivedStatus(
      auth.companyUuid,
      projectUuid
    );

    // Batch fetch comment counts for all ideas
    const ideaUuids = ideas.map((i) => i.uuid);
    const commentCounts = await batchCommentCounts(
      auth.companyUuid,
      "idea",
      ideaUuids
    );

    // Compute project-scoped sequential numbers (IDEA-1, IDEA-2, ...)
    // Ideas sorted by createdAt desc from service; sort asc by createdAt for numbering
    const sortedForNumbering = [...ideas].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );
    const ideaNumberMap = new Map<string, number>();
    sortedForNumbering.forEach((idea, idx) => {
      ideaNumberMap.set(idea.uuid, idx + 1);
    });

    // Group ideas by derivedStatus and attach commentCount + ideaNumber
    const groups: Record<string, Array<{
      uuid: string;
      ideaNumber: number;
      title: string;
      status: string;
      derivedStatus: DerivedIdeaStatus;
      badgeHint: BadgeHint;
      createdAt: string;
      updatedAt: string;
      commentCount: number;
    }>> = {};
    const counts: Record<string, number> = {};

    for (const status of TRACKER_STATUSES) {
      groups[status] = [];
      counts[status] = 0;
    }

    for (const idea of ideas) {
      const ds = idea.derivedStatus;
      // Skip closed ideas — they don't appear on the tracker board
      if (ds === "closed") continue;

      const formatted = {
        uuid: idea.uuid,
        ideaNumber: ideaNumberMap.get(idea.uuid) || 0,
        title: idea.title,
        status: idea.status,
        derivedStatus: ds,
        badgeHint: idea.badgeHint,
        createdAt: idea.createdAt.toISOString(),
        updatedAt: idea.updatedAt.toISOString(),
        commentCount: commentCounts[idea.uuid] || 0,
      };

      if (groups[ds]) {
        groups[ds].push(formatted);
        counts[ds]++;
      }
    }

    return success({ groups, counts });
  }
);
