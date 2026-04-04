// src/app/(dashboard)/projects/[uuid]/proposals/[proposalUuid]/page.tsx
// Server Component - UUID obtained from URL
// Container Model: Proposal contains documentDrafts and taskDrafts

import { redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  ClipboardList,
  ChevronRight,
  Monitor,
  Lightbulb,
  Pencil,
  AlertCircle,
  Bot,
  User,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { MarkdownContent } from "@/components/markdown-content";
import { getServerAuthContext } from "@/lib/auth-server";
import { getProposal, type DocumentDraft, type TaskDraft } from "@/services/proposal.service";
import { getIdea } from "@/services/idea.service";
import { projectExists } from "@/services/project.service";
import { ProposalActions } from "./proposal-actions";
import { ProposalEditor } from "./proposal-editor";
import { SourceIdeasCard } from "./source-ideas-card";
import { ProposalValidationChecklist } from "./proposal-validation-checklist";
import { DiscussionDrawer } from "./discussion-drawer";
import { batchCommentCounts } from "@/services/comment.service";
import { normalizeNewlines } from "../../dashboard/panels/utils";

// Status color configuration
const statusColors: Record<string, string> = {
  draft: "bg-[#F5F5F5] text-[#6B6B6B]",
  pending: "bg-[#FFF3E0] text-[#E65100]",
  approved: "bg-[#E8F5E9] text-[#5A9E6F]",
  rejected: "bg-[#FFEBEE] text-[#C4574C]",
  revised: "bg-[#E3F2FD] text-[#1976D2]",
  closed: "bg-[#F5F5F5] text-[#9A9A9A]",
};

// Review note background per status
const reviewNoteColors: Record<string, string> = {
  approved: "bg-[#E8F5E9] text-[#5A9E6F]",
  rejected: "bg-[#FFEBEE] text-[#C4574C]",
  closed: "bg-[#F5F5F5] text-[#6B6B6B]",
};

// Status to i18n key mapping
const statusI18nKeys: Record<string, string> = {
  draft: "draft",
  pending: "pending",
  approved: "approved",
  rejected: "rejected",
  revised: "revised",
  closed: "closed",
};

// Input type to i18n key mapping
const inputTypeI18nKeys: Record<string, { key: string }> = {
  idea: { key: "ideas.title" },
  document: { key: "documents.title" },
};

interface PageProps {
  params: Promise<{ uuid: string; proposalUuid: string }>;
}

export default async function ProposalDetailPage({ params }: PageProps) {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const { uuid: projectUuid, proposalUuid } = await params;
  const t = await getTranslations();

  // Validate project exists
  const exists = await projectExists(auth.companyUuid, projectUuid);
  if (!exists) {
    redirect("/projects");
  }

  // Get Proposal details
  const proposal = await getProposal(auth.companyUuid, proposalUuid);
  if (!proposal) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <div className="text-muted-foreground">{t("proposals.proposalNotFound")}</div>
        <Link href={`/projects/${projectUuid}/proposals`} className="mt-4 text-[#C67A52] hover:underline">
          {t("proposals.backToProposals")}
        </Link>
      </div>
    );
  }

  const documentDrafts = proposal.documentDrafts as DocumentDraft[] | null;
  const taskDrafts = proposal.taskDrafts as TaskDraft[] | null;

  // Fetch source ideas (when inputType is "idea" and inputUuids exist)
  const sourceIdeas = proposal.inputType === "idea" && proposal.inputUuids?.length
    ? (await Promise.all(
        proposal.inputUuids.map((uuid: string) => getIdea(auth.companyUuid, uuid))
      )).filter(Boolean) as Awaited<ReturnType<typeof getIdea>>[]
    : [];

  // Fetch comment count for the discussion drawer badge
  const commentCounts = await batchCommentCounts(auth.companyUuid, "proposal", [proposalUuid]);
  const commentCount = commentCounts[proposalUuid] || 0;

  return (
    <div className="px-4 py-4 md:px-10 md:py-8">
      {/* Breadcrumb */}
      <div className="mb-7 flex items-center gap-2 text-xs">
        <Link href={`/projects/${projectUuid}/proposals`} className="text-muted-foreground hover:text-foreground transition-colors">
          {t("nav.proposals")}
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-[#D0CCC4]" />
        <span className="font-medium text-[#6B6B6B]">{proposal.title}</span>
      </div>

      {/* Header */}
      <div className="mb-8 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#F5F2EC]">
            <ClipboardList className="h-6 w-6 text-[#C67A52]" />
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2.5">
              <Badge className={`text-[11px] font-semibold border-0 ${statusColors[proposal.status] || ""}`}>
                {t(`status.${statusI18nKeys[proposal.status] || proposal.status}`)}
              </Badge>
              {sourceIdeas.length > 0 ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    {t("proposals.basedOn")}
                  </span>
                  {sourceIdeas.map((idea) => (
                    <span
                      key={idea!.uuid}
                      className="inline-flex items-center gap-1 rounded-md bg-[#C67A5215] px-2 py-0.5 text-[11px] font-medium text-[#C67A52]"
                    >
                      <Lightbulb className="h-3 w-3" />
                      {idea!.title}
                    </span>
                  ))}
                </>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t("proposals.basedOn")} {t(inputTypeI18nKeys[proposal.inputType]?.key || "common.unknown")}
                </span>
              )}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{proposal.title}</h1>
            <div className="mt-2 flex items-center gap-2.5 text-xs text-muted-foreground">
              <span>{t("common.created")} {new Date(proposal.createdAt).toLocaleDateString()}</span>
              {proposal.createdBy && (
                <>
                  <span className="text-[#D0CCC4]">·</span>
                  <span className="flex items-center gap-1">
                    <Monitor className="h-3 w-3" />
                    {proposal.createdBy.name}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <DiscussionDrawer
            proposalUuid={proposalUuid}
            currentUserUuid={auth.actorUuid}
            commentCount={commentCount}
          />
          <ProposalActions
            proposalUuid={proposalUuid}
            projectUuid={projectUuid}
            status={proposal.status}
          />
        </div>
      </div>

      {/* Content — two column layout */}
      <div className="flex flex-col lg:flex-row gap-5 lg:gap-7">
        {/* Main Content */}
        <div className="min-w-0 flex-1 space-y-6">
          {/* Description */}
          {proposal.description && (
            <Card className="border-[#E5E2DC] shadow-none rounded-2xl gap-0 py-0">
              <CardHeader className="border-b border-[#F5F2EC] px-5 py-4">
                <CardTitle className="text-[13px] font-semibold text-foreground">
                  {t("common.description")}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-5 py-4">
                <div className="prose prose-sm max-w-none text-[#6B6B6B]">
                  <MarkdownContent>{normalizeNewlines(proposal.description)}</MarkdownContent>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Validation Checklist (draft only) */}
          {proposal.status === "draft" && (
            <ProposalValidationChecklist
              projectUuid={projectUuid}
              proposalUuid={proposalUuid}
              status={proposal.status}
            />
          )}

          {/* Editable Document and Task Drafts */}
          <ProposalEditor
            proposalUuid={proposalUuid}
            projectUuid={projectUuid}
            status={proposal.status}
            documentDrafts={documentDrafts}
            taskDrafts={taskDrafts}
          />
        </div>

        {/* Sidebar */}
        <div className="w-full lg:w-80 lg:shrink-0 space-y-5">
          {/* Details Card */}
          <Card className="border-[#E5E2DC] shadow-none rounded-2xl gap-0 py-0 overflow-hidden">
            <CardHeader className="border-b border-[#F5F2EC] px-5 py-4">
              <CardTitle className="text-[13px] font-semibold text-foreground">
                {t("common.details")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 px-5 py-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t("common.status")}</span>
                <Badge className={`text-[11px] font-medium border-0 ${statusColors[proposal.status] || ""}`}>
                  {t(`status.${statusI18nKeys[proposal.status] || proposal.status}`)}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t("proposals.inputType")}</span>
                <span className="text-xs font-medium text-foreground">
                  {t(inputTypeI18nKeys[proposal.inputType]?.key || "common.unknown")}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t("proposals.creatorType")}</span>
                <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  {proposal.createdByType === "agent" ? (
                    <><Bot className="h-3 w-3 text-[#C67A52]" />{t("common.agent")}</>
                  ) : (
                    <><User className="h-3 w-3 text-muted-foreground" />{t("common.user")}</>
                  )}
                </span>
              </div>
              <Separator className="bg-[#F5F2EC]" />
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t("common.created")}</span>
                <span className="text-xs font-medium text-[#6B6B6B]">
                  {new Date(proposal.createdAt).toLocaleDateString()}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t("common.updated")}</span>
                <span className="text-xs font-medium text-[#6B6B6B]">
                  {new Date(proposal.updatedAt).toLocaleDateString()}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Source Ideas Card */}
          {sourceIdeas.length > 0 && (
            <SourceIdeasCard
              ideas={sourceIdeas.map((idea) => ({
                uuid: idea!.uuid,
                title: idea!.title,
                content: idea!.content,
                status: idea!.status,
                assignee: idea!.assignee,
                createdAt: idea!.createdAt,
              }))}
              projectUuid={projectUuid}
              currentUserUuid={auth.actorUuid}
            />
          )}

          {/* Review Info */}
          {proposal.review && (
            <Card className="border-[#E5E2DC] shadow-none rounded-2xl gap-0 py-0 overflow-hidden">
              <CardHeader className="border-b border-[#F5F2EC] px-5 py-4">
                <CardTitle className="text-[13px] font-semibold text-foreground">
                  {t("proposals.reviewInfo")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 px-5 py-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t("proposals.reviewedBy")}</span>
                  <span className="text-xs font-medium text-[#6B6B6B]">
                    {proposal.review.reviewedBy?.name || "-"}
                  </span>
                </div>
                {proposal.review.reviewedAt && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{t("proposals.reviewedAt")}</span>
                    <span className="text-xs font-medium text-[#6B6B6B]">
                      {new Date(proposal.review.reviewedAt).toLocaleDateString()}
                    </span>
                  </div>
                )}
                {proposal.review.reviewNote && (
                  <>
                    <Separator className="bg-[#F5F2EC]" />
                    <div>
                      <span className="text-[11px] text-muted-foreground">{t("proposals.reviewNote")}</span>
                      <div className={`mt-1.5 rounded-lg px-3 py-2 text-xs font-medium ${reviewNoteColors[proposal.status] || "bg-[#F5F2EC] text-[#6B6B6B]"}`}>
                        {proposal.review.reviewNote}
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* Rejection / Review Note (shown on draft after reject) */}
          {proposal.status === "draft" && proposal.review?.reviewNote && (
            <Card className="border-[#C4574C] bg-[#FFEBEE] shadow-none rounded-2xl gap-0 py-0">
              <CardContent className="p-4">
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#C4574C]" />
                  <div>
                    <h3 className="text-xs font-semibold text-[#C4574C]">{t("proposals.rejectionReason")}</h3>
                    <p className="mt-1 text-xs text-[#6B6B6B]">{proposal.review.reviewNote}</p>
                    {proposal.review.reviewedBy && (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        — {proposal.review.reviewedBy.name}
                        {proposal.review.reviewedAt && `, ${new Date(proposal.review.reviewedAt).toLocaleDateString()}`}
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Closed Reason */}
          {proposal.status === "closed" && proposal.review?.reviewNote && (
            <Card className="border-[#D0CCC4] bg-[#F5F2EC] shadow-none rounded-2xl gap-0 py-0">
              <CardContent className="p-4">
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <h3 className="text-xs font-semibold text-[#6B6B6B]">{t("proposals.rejectionReason")}</h3>
                    <p className="mt-1 text-xs text-[#6B6B6B]">{proposal.review.reviewNote}</p>
                    {proposal.review.reviewedBy && (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        — {proposal.review.reviewedBy.name}
                        {proposal.review.reviewedAt && `, ${new Date(proposal.review.reviewedAt).toLocaleDateString()}`}
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Draft Notice */}
          {proposal.status === "draft" && (
            <Card className="border-[#D0CCC4] bg-[#F5F2EC] shadow-none rounded-2xl gap-0 py-0">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-xs text-[#6B6B6B]">
                  <Pencil className="h-3.5 w-3.5" />
                  <span className="font-medium">{t("proposals.draftStatus")}</span>
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {t("proposals.draftNotice")}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Pending Review Notice */}
          {proposal.status === "pending" && (
            <Card className="border-[#C67A52] bg-[#FFFBF8] shadow-none rounded-2xl gap-0 py-0">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-xs text-[#E65100]">
                  <AlertCircle className="h-3.5 w-3.5" />
                  <span className="font-medium">{t("proposals.awaitingReview")}</span>
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {t("proposals.reviewInstructions")}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Closed Notice */}
          {proposal.status === "closed" && (
            <Card className="border-[#D0CCC4] bg-[#F5F2EC] shadow-none rounded-2xl gap-0 py-0">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <AlertCircle className="h-3.5 w-3.5" />
                  <span className="font-medium">{t("proposals.closedNotice")}</span>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
