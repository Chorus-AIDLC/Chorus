// src/services/alignment.service.ts
// First-principles alignment anchor resolution (openspec change
// add-first-principles-alignment-review, Tech Design → Architecture → Component 1).
//
// `getAlignmentAnchor` is the single consolidated read that every reviewer
// (proposal-, task-, code-reviewer) calls to pin the work it is reviewing back
// to the *original intent*. Given any reviewable entity it returns one bundle
// per directly-attached Idea, each STRUCTURALLY split into a human-authorized
// `baseline` (idea `content` + human-answered elaboration + human-authored
// comments) and an agent-originated `agentContext` (agent-answered elaboration +
// agent-authored comments — audit-only).
//
// The split IS the anti-self-authorization guarantee: the reviewer builds the
// "original intent" from the baseline alone, so a drifting agent can NOT poison
// that baseline by self-answering a YOLO elaboration or posting its own idea
// comment ("X is in scope") — such entries land in `agentContext`, which must
// never expand, shrink, or override the baseline. The escape hatch that
// downgrades a deviation therefore keys off baseline entries only.
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
 * elaboration decision as `"user" | "agent"`. A human author/answerer is `"user"`;
 * a real agent is `"agent"`. Reviewers key their human-originated escape hatch off
 * this value — only `"user"` can authorize a deviation.
 */
export type AnchorActorType = "user" | "agent";

/** One resolved elaboration decision: the question, the chosen answer, and who chose it. */
export interface AlignmentAnchorDecision {
  question: string;
  /** Chosen option label, or the free-text `customText` for an "Other" answer. */
  answer: string;
  /**
   * Answerer kind, normalized to `"user" | "agent"`. Mirrors comment `authorType`
   * so the reviewer's "human-answered elaboration" escape hatch is enforceable: an
   * agent-self-answered (YOLO) decision (`answeredByType: "agent"`) never authorizes
   * drift — only a human-answered one (`"user"`) does.
   */
  answeredByType: AnchorActorType;
}

/**
 * One Idea comment, carrying its author's TYPE so a reviewer can enforce the
 * human-authored escape hatch (an agent-authored comment never authorizes drift).
 */
export interface AlignmentAnchorComment {
  /** `"user"` for a human author; `"agent"` for an agent. */
  authorType: AnchorActorType;
  author: string; // display name
  at: string; // ISO timestamp
  content: string;
}

/**
 * Agent-originated audit context for one Idea — NEVER part of the baseline.
 * Present so the reviewer (and a human auditor) can SEE what the agent added,
 * but the reviewer must not let any of it expand, shrink, or override the
 * human-authorized baseline.
 */
export interface AlignmentAnchorAgentContext {
  /** Elaboration decisions answered by an agent (e.g. self-answered under YOLO). */
  elaboration: AlignmentAnchorDecision[];
  /** Idea comments authored by an agent. */
  comments: AlignmentAnchorComment[];
}

/**
 * The intent bundle for one attached Idea, STRUCTURALLY split so the
 * human-authorized baseline can never be constructed from agent-originated
 * entries. The reviewer's "original intent" = `content` + `baselineElaboration`
 * + `humanComments`; `agentContext` is audit-only.
 */
export interface AlignmentAnchorIdea {
  uuid: string;
  title: string;
  /** The Idea body — the primary human-authored intent statement. */
  content: string | null;
  /** Human-answered elaboration decisions (baseline). Each carries `answeredByType: "user"`. */
  baselineElaboration: AlignmentAnchorDecision[];
  /** Human-authored Idea comments (baseline). Each carries `authorType: "user"`. */
  humanComments: AlignmentAnchorComment[];
  /** Agent-originated elaboration + comments — audit-only, never baseline. */
  agentContext: AlignmentAnchorAgentContext;
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
 * FAIL-CLOSED: this classifier gates an authorization boundary (only a human can
 * authorize scope drift), so it returns the human value `"user"` ONLY for the
 * exact stored type `"user"`; EVERY other value — `"agent"`, the session-scoped
 * `"agent_instance"`, any unknown future type, or `null`/`undefined` — collapses
 * to `"agent"` (non-human). An entry the system cannot positively confirm as
 * human-authored must never be treated as a human authorization. This is the
 * single shared classifier used for BOTH comment `authorType` and elaboration
 * `answeredByType`.
 *
 * The only stored types that actually reach here today are `"user"` and
 * `"agent"`: idea comments are written as `isUser(auth) ? "user" : "agent"` and
 * elaboration answers carry the actor type (MCP → `"agent"`; the dashboard action
 * goes through `getServerAuthContext`, which is always `"user"`).
 *
 * LIMITATION: a super_admin is a human operator, but there is no distinct/reachable
 * super_admin idea-comment or elaboration-answer authoring path today — the write
 * paths above collapse a super_admin to `"agent"` — so super_admin is deliberately
 * NOT special-cased here (special-casing it would be dead code that this normalizer
 * never sees). If such a path is ever added, this human-vs-agent classification AND
 * the write path that feeds it must be revisited together so a genuine human
 * authorization is not over-blocked as if a drifting agent had self-cleared.
 */
function toAnchorActorType(
  storedType: string | null | undefined
): AnchorActorType {
  return storedType === "user" ? "user" : "agent";
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

/**
 * Assemble one Idea's intent bundle and STRUCTURALLY split it into the
 * human-authorized baseline (content + human-answered elaboration +
 * human-authored comments) and the agent-originated audit context
 * (agent-answered elaboration + agent-authored comments). The partition keys
 * strictly off the fail-closed `answeredByType` / `authorType` classification,
 * so the baseline can never absorb an agent-originated entry — this is the
 * anti-self-authorization guarantee, enforced at the data layer rather than left
 * to each reviewer prompt to re-derive.
 */
async function buildIdeaBundle(
  companyUuid: string,
  ideaUuid: string
): Promise<AlignmentAnchorIdea | null> {
  const idea = await getIdeaByUuid(companyUuid, ideaUuid);
  if (!idea) return null;

  const [decisions, comments] = await Promise.all([
    collectResolvedDecisions(companyUuid, ideaUuid),
    collectIdeaComments(companyUuid, ideaUuid),
  ]);

  // Partition by the fail-closed human-vs-agent signal. Only positively
  // human-authored entries ("user") enter the baseline; everything else is
  // audit-only agent context.
  const baselineElaboration = decisions.filter((d) => d.answeredByType === "user");
  const agentElaboration = decisions.filter((d) => d.answeredByType !== "user");
  const humanComments = comments.filter((c) => c.authorType === "user");
  const agentComments = comments.filter((c) => c.authorType !== "user");

  return {
    uuid: idea.uuid,
    title: idea.title,
    content: idea.content ?? null,
    baselineElaboration,
    humanComments,
    agentContext: {
      elaboration: agentElaboration,
      comments: agentComments,
    },
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
    // Classify each author as human ("user") vs agent ("agent") for the escape hatch.
    authorType: toAnchorActorType(c.author.type),
    author: c.author.name,
    at: c.createdAt,
    content: c.content,
  }));
}
