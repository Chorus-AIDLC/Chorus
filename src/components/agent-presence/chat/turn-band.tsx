"use client";

// Turn band — the SIGNATURE element of the chat-style daemon UI (子3).
//
// The right pane is deliberately NOT a generic two-color chat-bubble stream. It is
// a session TRANSCRIPT whose structural unit is the *turn band*: one band per wake.
// Each band's eyebrow encodes real provenance — WHY the agent woke (its trigger) —
// with a glyph + label (task_assigned→Task/ListChecks, mentioned→Mention/AtSign,
// elaboration→Elaboration/HelpCircle, human_instruction→Instruction/PenLine,
// resume→Resume/RotateCw). This is "structure is information": turns are a real
// `seq` sequence carrying genuine trigger provenance, not decorative 01/02 markers.
//
// The single bold moment: the RUNNING turn's left spine is terracotta with a
// motion-safe pulse (reduced-motion shows a static terracotta spine). Everything
// else stays quiet — non-running bands have a flat hairline spine, the eyebrow is
// small, and the messages inside are a calm top-to-bottom log (see message.tsx).
//
// Entity-bearing turns (those whose live execution resolves a deep link via the
// reused `execHref`) show a link to the related task/idea, making "this chat = one
// task execution" literal. The link is sourced from the provider's live execution
// slice matched by `turn.executionUuid`, reusing the canonical href builder rather
// than re-resolving a project-scoped URL here.

import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  AtSign,
  ExternalLink,
  HelpCircle,
  ListChecks,
  Loader2,
  PenLine,
  RotateCw,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { execHref } from "../hooks";
import type { ExecutionView } from "../types";
import type { TurnWithMessagesView } from "@/services/daemon-session.service";
import { Message } from "./message";

// Trigger → glyph + i18n label-key, the eyebrow vocabulary. A trigger outside the
// known set falls back to a neutral glyph + "Turn" so an unrecognized value never
// renders blank (no silent gap).
const TRIGGER_META: Record<string, { icon: LucideIcon; labelKey: string }> = {
  task_assigned: { icon: ListChecks, labelKey: "triggerTask" },
  mentioned: { icon: AtSign, labelKey: "triggerMention" },
  elaboration: { icon: HelpCircle, labelKey: "triggerElaboration" },
  human_instruction: { icon: PenLine, labelKey: "triggerInstruction" },
  resume: { icon: RotateCw, labelKey: "triggerResume" },
};

export function TurnBand({
  turn,
  agentName,
  // The live execution this turn is linked to (matched by `turn.executionUuid` in
  // the provider's by-connection slice), or null when the execution has ended /
  // isn't in the live snapshot. When present AND it resolves an href, the band
  // shows a deep link to the related task/idea.
  linkedExecution,
}: {
  turn: TurnWithMessagesView;
  agentName: string;
  linkedExecution: ExecutionView | null;
}) {
  const t = useTranslations("daemonChat");

  const meta = TRIGGER_META[turn.trigger];
  const Icon = meta?.icon ?? ListChecks;
  const triggerLabel = meta ? t(meta.labelKey) : t("triggerUnknown");

  const running = turn.status === "running";
  const pending = turn.status === "pending";

  // Live status label (pending → Queued, running → Running, ended → Ended).
  const statusLabel =
    turn.status === "running"
      ? t("turnStatusRunning")
      : turn.status === "pending"
        ? t("turnStatusPending")
        : t("turnStatusEnded");

  // Deep link for an entity-bearing turn, via the reused canonical href builder.
  const href = linkedExecution ? execHref(linkedExecution) : null;
  // Idea-anchored executions get an "Open idea" affordance; the rest "Open task"
  // (proposal/document also route through execHref but read as task-shaped work).
  const linkLabel =
    linkedExecution?.entityType === "idea" ? t("openIdea") : t("openTask");

  return (
    <div className="flex gap-3">
      {/* Left spine — the one bold moment. Running = terracotta with a
          motion-safe pulse; reduced-motion (and every non-running turn) shows a
          flat spine. Pending uses the terracotta tint without the pulse; ended
          uses a quiet hairline. */}
      <div
        aria-hidden
        className={`relative w-[3px] shrink-0 rounded-full ${
          running || pending ? "bg-[#C67A52]" : "bg-[#EFEBE4]"
        }`}
      >
        {running && (
          <span className="absolute inset-0 rounded-full bg-[#C67A52] opacity-40 motion-safe:animate-pulse" />
        )}
      </div>

      <div className="min-w-0 flex-1 pb-2">
        {/* Eyebrow: trigger glyph + label, the turn seq, the live status, and the
            optional entity deep link. */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <Icon className="h-3.5 w-3.5 text-[#C67A52]" aria-hidden />
            <span className="text-[12px] font-semibold uppercase tracking-wide text-[#2C2C2C]">
              {triggerLabel}
            </span>
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wide text-[#9A9A9A]">
            {t("turnLabel", { seq: turn.seq })}
          </span>
          <Badge
            variant="secondary"
            className={`gap-1 border-0 px-1.5 py-0 text-[10px] font-medium ${
              running
                ? "bg-[#FBF0E8] text-[#C67A52]"
                : pending
                  ? "bg-[#F0EDE8] text-[#9A8C7E]"
                  : "bg-[#F0EDE8] text-[#6B6B6B]"
            }`}
          >
            {running && (
              <Loader2
                className="h-2.5 w-2.5 motion-safe:animate-spin"
                aria-hidden
              />
            )}
            {statusLabel}
          </Badge>
          {href && (
            <Link
              href={href}
              className="group inline-flex items-center gap-1 text-[11px] font-medium text-[#C67A52] hover:text-[#B56A44]"
            >
              {linkLabel}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </Link>
          )}
        </div>

        {/* The human-instruction prompt text (the canonical instruction body) reads
            as the first thing in the band when present — it's what the human said
            to start this turn. Autonomous triggers carry no promptText. */}
        {turn.promptText && turn.promptText.trim().length > 0 && (
          <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-[#FCFBF8] px-3 py-2 text-[13px] leading-relaxed text-[#6B6B6B]">
            {turn.promptText}
          </p>
        )}

        {/* Messages — a quiet top-to-bottom transcript. A turn whose messages were
            trimmed by the rolling window (or that hasn't produced any yet) shows a
            calm placeholder rather than an empty gap (no silent empty). */}
        <div className="mt-3 flex min-w-0 flex-col gap-3">
          {turn.messages.length > 0 ? (
            turn.messages.map((m) => (
              <Message key={m.uuid} message={m} agentName={agentName} />
            ))
          ) : (
            <p className="text-[12px] italic text-[#9A9A9A]">
              {t("turnNoMessages")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
