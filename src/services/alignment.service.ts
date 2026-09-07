// src/services/alignment.service.ts
// First-principles alignment anchor resolution (openspec change
// add-first-principles-alignment-review, Tech Design → Architecture → Component 1).
//
// `getAlignmentAnchor` is the single consolidated read that every reviewer
// (proposal-, task-, code-reviewer) calls to pin the work it is reviewing back
// to the *original intent*. Given any reviewable entity it returns one bundle:
// the directly-attached Idea(s), their resolved elaboration decisions, and their
// comments (the authorized-scope-change ledger).
//
// CRITICAL — the anchor is the DIRECTLY-ATTACHED idea (`directIdeaUuid`, the
// FIRST idea node on the lineage, e.g. a proposal's `inputUuids[0]`), NEVER the
// ancestor `rootIdeaUuid`. `resolveRootIdea` climbs to the topmost ancestor
// theme/idea, whose intent is the *wrong* anchor — anchoring there would itself
// be the semantic drift this feature exists to catch. `rootIdeaUuid` and
// `lineageTitles` are surfaced only as light secondary context.
//
// This tool ONLY consolidates reads that are already independently available via
// chorus_get_idea (content), chorus_get_elaboration (decisions), and
// chorus_get_comments (the idea ledger) — it introduces no new data exposure and
// reuses those exact service functions so the exposed shape can never drift from
// them. Every read is companyUuid-scoped; a non-idea-rooted entity (e.g. a
// document-input proposal) resolves to `anchorAvailable: false` with an empty
// `ideas` list rather than throwing.

import {
  resolveRootIdea,
  type LineageEntityType,
  type ResolvedVia,
  type ResolveRootIdeaResult,
} from "@/services/lineage.service";
import { getIdeaByUuid } from "@/services/idea.service";
import { getProposalByUuid } from "@/services/proposal.service";
import { getElaboration } from "@/services/elaboration.service";
import { listComments } from "@/services/comment.service";
import type { ElaborationQuestionResponse } from "@/types/elaboration";

/**
 * The anchor's human-vs-agent authorship signal, exposed on every comment and
 * elaboration decision as `"user" | "agent"`. A HUMAN actor — a regular user OR a
 * super_admin — is `"user"`; only a real agent is `"agent"`. Reviewers key their
 * human-originated escape hatch off this value.
 */
export type AnchorActorType = "user" | "agent";

/** One resolved elaboration decision: the question, the chosen answer, and who chose it. */
export interface AlignmentAnchorDecision {
  question: string;
  /** Chosen option label, or the free-text `customText` for an "Other" answer. */
  answer: string;
  /**
   * Answerer kind, normalized to `"user" | "agent"` (a super_admin — a human
   * operator — maps to `"user"`). Mirrors comment `authorType` so the reviewer's
   * "human-answered elaboration" escape hatch is enforceable: an agent-self-answered
   * (YOLO) decision (`answeredByType: "agent"`) never authorizes drift.
   */
  answeredByType: AnchorActorType;
}

/**
 * One Idea comment, carrying its author's TYPE so a reviewer can enforce the
 * human-authored escape hatch (an agent-authored comment never authorizes drift).
 */
export interface AlignmentAnchorComment {
  /** `"user"` for any human author (user OR super_admin); `"agent"` for an agent. */
  authorType: AnchorActorType;
  author: string; // display name
  at: string; // ISO timestamp
  content: string;
}

/** The intent statement for one attached Idea. */
export interface AlignmentAnchorIdea {
  uuid: string;
  title: string;
  content: string | null;
  elaboration: AlignmentAnchorDecision[];
  comments: AlignmentAnchorComment[];
}

/** The consolidated "original intent" bundle for a reviewable entity. */
export interface AlignmentAnchor {
  /** The directly-attached Idea (first idea node on the lineage). The anchor. */
  directIdeaUuid: string | null;
  /** Topmost ancestor idea — secondary context only, NEVER the anchor. */
  rootIdeaUuid: string | null;
  /** Ancestor idea titles, ordered root → direct — light "you are here" context. */
  lineageTitles: string[];
  /** Explains how the anchor was reached (e.g. via_proposal, root_idea). */
  resolvedVia: ResolvedVia;
  /** The attached Idea(s): usually 1; N when a proposal combines several ideas. */
  ideas: AlignmentAnchorIdea[];
  /** False when the entity has no attached idea (nothing to anchor to). */
  anchorAvailable: boolean;
}

/**
 * Normalize a stored actor/author type to the anchor's human-vs-agent signal.
 *
 * Only a real agent (`"agent"`, or the session-scoped `"agent_instance"`) is
 * agent-originated; EVERY human actor — a regular user OR a super_admin — maps to
 * `"user"`. A super_admin is a human operator, NOT an agent, so their Idea comment
 * / elaboration answer must satisfy the reviewer's human-authored escape hatch
 * (`authorType`/`answeredByType == "user"`) rather than be over-blocked as if a
 * drifting agent had self-cleared. This is the same discriminator the rest of the
 * codebase uses to tell agents apart (see `isAgent` in src/lib/auth.ts).
 */
function toAnchorActorType(storedType: string): AnchorActorType {
  return storedType === "agent" || storedType === "agent_instance"
    ? "agent"
    : "user";
}

/**
 * Resolve the alignment anchor for a reviewable entity.
 *
 * @param companyUuid Tenant scope — every read is scoped to this company.
 * @param entityType  "idea" | "proposal" | "task" | "document".
 * @param entityUuid  The entity's uuid.
 */
export async function getAlignmentAnchor(
  companyUuid: string,
  entityType: LineageEntityType,
  entityUuid: string
): Promise<AlignmentAnchor> {
  const root = await resolveRootIdea(companyUuid, entityType, entityUuid);

  // Light ancestor context: the idea-node titles of the lineage, ordered
  // root → direct (lineage itself is child → root, so reverse the idea nodes).
  const lineageTitles = root.lineage
    .filter((n) => n.type === "idea")
    .map((n) => n.title)
    .filter((title): title is string => title !== null)
    .reverse();

  const base = {
    directIdeaUuid: root.directIdeaUuid,
    rootIdeaUuid: root.rootIdeaUuid,
    lineageTitles,
    resolvedVia: root.resolvedVia,
  };

  // No directly-attached idea (quick task, standalone doc, document-input
  // proposal, missing/cross-company entity) → nothing to anchor to.
  if (!root.directIdeaUuid) {
    return { ...base, ideas: [], anchorAvailable: false };
  }

  const anchorIdeaUuids = await collectAnchorIdeaUuids(companyUuid, root);
  const built = await Promise.all(
    anchorIdeaUuids.map((uuid) => buildIdeaBundle(companyUuid, uuid))
  );
  const ideas = built.filter((idea): idea is AlignmentAnchorIdea => idea !== null);

  return { ...base, ideas, anchorAvailable: ideas.length > 0 };
}

/**
 * The direct anchor idea uuid(s). For an idea entity that is the idea itself; for
 * a proposal/task/document it is every idea in the proposal's `inputUuids` (so a
 * proposal that combines several ideas returns them all) — NOT their ancestors.
 * Order preserves `inputUuids`, so `directIdeaUuid` (inputUuids[0]) is first.
 */
async function collectAnchorIdeaUuids(
  companyUuid: string,
  root: ResolveRootIdeaResult
): Promise<string[]> {
  const directIdeaUuid = root.directIdeaUuid as string; // caller guards non-null

  // No proposal node on the lineage ⇒ the entity is an idea (or resolved
  // directly to one); the single direct idea is the anchor.
  const proposalNode = root.lineage.find((n) => n.type === "proposal");
  if (!proposalNode) return [directIdeaUuid];

  const proposal = await getProposalByUuid(companyUuid, proposalNode.uuid);
  // Defensive: the proposal was already idea-typed when directIdeaUuid resolved,
  // so this only guards a proposal deleted mid-request.
  if (proposal?.inputType !== "idea") return [directIdeaUuid];

  const inputUuids = Array.isArray(proposal.inputUuids)
    ? proposal.inputUuids.filter((v): v is string => typeof v === "string")
    : [];

  const existing: string[] = [];
  for (const uuid of inputUuids) {
    const idea = await getIdeaByUuid(companyUuid, uuid);
    if (idea) existing.push(idea.uuid);
  }
  // Fall back to the resolver's direct idea if no input idea is readable (e.g.
  // the referenced ideas were deleted) — keeps the anchor consistent.
  return existing.length > 0 ? existing : [directIdeaUuid];
}

/** Assemble one Idea's intent bundle (content + resolved decisions + comments). */
async function buildIdeaBundle(
  companyUuid: string,
  ideaUuid: string
): Promise<AlignmentAnchorIdea | null> {
  const idea = await getIdeaByUuid(companyUuid, ideaUuid);
  if (!idea) return null;

  const [elaboration, comments] = await Promise.all([
    collectResolvedDecisions(companyUuid, ideaUuid),
    collectIdeaComments(companyUuid, ideaUuid),
  ]);

  return {
    uuid: idea.uuid,
    title: idea.title,
    content: idea.content ?? null,
    elaboration,
    comments,
  };
}

/**
 * Resolved elaboration decisions only (compact): every ANSWERED question as
 * `{ question, answer }`, where `answer` is the chosen option's label (or the
 * free-text `customText` for an "Other" answer). Unanswered questions and the
 * full option lists are omitted to keep the anchor small.
 */
async function collectResolvedDecisions(
  companyUuid: string,
  ideaUuid: string
): Promise<AlignmentAnchorDecision[]> {
  const elaboration = await getElaboration({ companyUuid, ideaUuid });
  const decisions: AlignmentAnchorDecision[] = [];
  for (const round of elaboration.rounds) {
    for (const question of round.questions) {
      if (!question.answer) continue; // resolved decisions only
      decisions.push({
        question: question.text,
        answer: resolveAnswerLabel(question),
        // Who answered — a human-answered decision authorizes drift, an
        // agent-self-answered (YOLO) one does not.
        answeredByType: toAnchorActorType(question.answer.answeredBy.type),
      });
    }
  }
  return decisions;
}

/** The human-readable answer for an answered question. */
function resolveAnswerLabel(question: ElaborationQuestionResponse): string {
  // Caller (collectResolvedDecisions) only invokes this for answered questions.
  const answer = question.answer!;
  if (answer.selectedOptionId !== null) {
    const option = question.options.find((o) => o.id === answer.selectedOptionId);
    // Prefer the chosen option's label; fall back to its id if the option row
    // is gone (defensive — validation normally guarantees a match).
    return option ? option.label : answer.selectedOptionId;
  }
  // selectedOptionId is null ⇒ an "Other" free-text answer.
  return answer.customText ?? "";
}

/**
 * The Idea's comments — the authorized-scope-change ledger. Each comment carries
 * its author's TYPE so a reviewer can tell a human-authored authorization from an
 * agent's own comment. Reuses the SAME read as chorus_get_comments; returns the
 * full ledger (uncapped) so an older human authorization is never hidden behind a
 * newest-N cap, which would produce a false drift blocker.
 */
async function collectIdeaComments(
  companyUuid: string,
  ideaUuid: string
): Promise<AlignmentAnchorComment[]> {
  const { comments } = await listComments({
    companyUuid,
    targetType: "idea",
    targetUuid: ideaUuid,
  });
  return comments.map((c) => ({
    // Normalize so a super_admin (human) reads as "user", not "agent".
    authorType: toAnchorActorType(c.author.type),
    author: c.author.name,
    at: c.createdAt,
    content: c.content,
  }));
}
