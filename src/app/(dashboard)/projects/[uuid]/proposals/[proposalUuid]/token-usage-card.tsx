// Server component: renders in the Proposal detail sidebar when observability
// data exists for the proposal. Shows drafting breakdown bar + review rounds.

import { getTranslations } from "next-intl/server";
import { Coins } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  getEntityTokens,
  getProposalTokens,
  classifyPhase,
  type TokenUsage,
} from "@/services/observability.service";
import { prisma } from "@/lib/prisma";
import { formatTokens } from "@/lib/format-tokens";

interface TokenUsageCardProps {
  companyUuid: string;
  proposalUuid: string;
}

function tokensSum(t: TokenUsage): number {
  return t.input_tokens + t.output_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
}

// Review rounds = individual admin review tool calls (approve/reject/close).
// We fetch them separately so we can render each round chronologically.
interface ReviewRound {
  action: "pass" | "fail";
  createdAt: Date;
  inputSize: number;
  outputSize: number;
}

async function getReviewRounds(
  companyUuid: string,
  proposalUuid: string
): Promise<ReviewRound[]> {
  const events = await prisma.toolUsageEvent.findMany({
    where: { companyUuid, entityType: "proposal", entityUuid: proposalUuid },
    select: {
      toolName: true,
      createdAt: true,
      inputSize: true,
      outputSize: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const rounds: ReviewRound[] = [];
  for (const ev of events) {
    if (classifyPhase(ev.toolName) !== "review") continue;
    const action: "pass" | "fail" =
      ev.toolName === "chorus_admin_approve_proposal" ? "pass" : "fail";
    rounds.push({
      action,
      createdAt: ev.createdAt,
      inputSize: ev.inputSize,
      outputSize: ev.outputSize,
    });
  }
  return rounds;
}

// Classify draft tool calls into doc/task/validate buckets for a stacked bar.
function draftingSplit(breakdown: { toolName: string; callCount: number }[]): {
  docs: number;
  tasks: number;
  validate: number;
  other: number;
} {
  let docs = 0;
  let tasks = 0;
  let validate = 0;
  let other = 0;
  for (const b of breakdown) {
    if (b.toolName.includes("document_draft")) {
      docs += b.callCount;
    } else if (b.toolName.includes("task_draft")) {
      tasks += b.callCount;
    } else if (b.toolName.includes("validate")) {
      validate += b.callCount;
    } else {
      other += b.callCount;
    }
  }
  return { docs, tasks, validate, other };
}

export async function TokenUsageCard({
  companyUuid,
  proposalUuid,
}: TokenUsageCardProps) {
  const [entity, proposal, reviewRounds, t] = await Promise.all([
    getEntityTokens(companyUuid, "proposal", proposalUuid),
    getProposalTokens(companyUuid, proposalUuid),
    getReviewRounds(companyUuid, proposalUuid),
    getTranslations(),
  ]);

  const total = tokensSum(entity.sessionTokens);

  // Progressive rendering: if no data at all, skip the card entirely.
  if (total === 0 && entity.toolCallCount === 0 && reviewRounds.length === 0) {
    return null;
  }

  const split = draftingSplit(proposal.drafting.toolBreakdown);
  const draftTotal =
    split.docs + split.tasks + split.validate + split.other;

  return (
    <Card className="border-[#E5E2DC] shadow-none rounded-2xl gap-0 py-0 overflow-hidden">
      <CardHeader className="border-b border-[#F5F2EC] px-5 py-4">
        <CardTitle className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
          <Coins className="h-3.5 w-3.5 text-[#C67A52]" />
          {t("observability.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 px-5 py-4">
        {/* Total */}
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-muted-foreground">
              {t("observability.totalTokens")}
            </span>
            <span className="text-lg font-semibold text-[#2C2C2C] tabular-nums">
              {formatTokens(total)}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-[#9A9A9A]">
            <span>{t("observability.toolCalls")}</span>
            <span className="tabular-nums">{entity.toolCallCount}</span>
          </div>
        </div>

        {/* Drafting breakdown */}
        {draftTotal > 0 && (
          <>
            <Separator className="bg-[#F5F2EC]" />
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {t("observability.draftingBreakdown")}
                </span>
                <span className="text-[11px] text-[#9A9A9A] tabular-nums">
                  {t("observability.toolCall", { count: draftTotal })}
                </span>
              </div>
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-[#F5F2EC]">
                {split.docs > 0 && (
                  <div
                    className="h-full bg-[#C67A52]"
                    style={{ width: `${(split.docs / draftTotal) * 100}%` }}
                  />
                )}
                {split.tasks > 0 && (
                  <div
                    className="h-full bg-[#1976D2]"
                    style={{ width: `${(split.tasks / draftTotal) * 100}%` }}
                  />
                )}
                {split.validate > 0 && (
                  <div
                    className="h-full bg-[#5A9E6F]"
                    style={{ width: `${(split.validate / draftTotal) * 100}%` }}
                  />
                )}
              </div>
              <div className="mt-2 space-y-1 text-[11px]">
                {split.docs > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[#6B6B6B]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#C67A52]" />
                      {t("observability.draftingDocs")}
                    </span>
                    <span className="tabular-nums text-[#2C2C2C]">{split.docs}</span>
                  </div>
                )}
                {split.tasks > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[#6B6B6B]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#1976D2]" />
                      {t("observability.draftingTasks")}
                    </span>
                    <span className="tabular-nums text-[#2C2C2C]">{split.tasks}</span>
                  </div>
                )}
                {split.validate > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[#6B6B6B]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#5A9E6F]" />
                      {t("observability.draftingValidate")}
                    </span>
                    <span className="tabular-nums text-[#2C2C2C]">
                      {split.validate}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* Review rounds */}
        {reviewRounds.length > 0 && (
          <>
            <Separator className="bg-[#F5F2EC]" />
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {t("observability.reviewRounds")}
                </span>
                <span className="text-[11px] text-[#9A9A9A] tabular-nums">
                  {reviewRounds.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {reviewRounds.map((round, idx) => (
                  <div
                    key={`${round.createdAt.toISOString()}-${idx}`}
                    className="flex items-center justify-between rounded-lg bg-[#FAF8F4] p-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-[#9A9A9A]">
                        #{idx + 1}
                      </span>
                      <Badge
                        variant="secondary"
                        className={
                          round.action === "pass"
                            ? "bg-green-50 text-green-700 text-[10px]"
                            : "bg-red-50 text-red-700 text-[10px]"
                        }
                      >
                        {round.action === "pass"
                          ? t("observability.reviewPass")
                          : t("observability.reviewFail")}
                      </Badge>
                    </div>
                    <span className="text-[10px] tabular-nums text-[#6B6B6B]">
                      {formatTokens(round.inputSize + round.outputSize)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
