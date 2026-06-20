"use client";

// New-conversation pane — the DEFAULT right-pane content of the chat-style daemon
// UI when no existing conversation is selected (子3 follow-up: empty/no-selection
// state must be a composer, not a dead-end).
//
// Chat-app convention: a blank selection means "start a new conversation", so this
// pane hosts the reused ad-hoc composer (start a fresh session on one of the
// selected agent's ONLINE connections) instead of a passive "select a conversation"
// prompt. It is shown:
//   - as the desktop right pane whenever nothing is selected,
//   - as the mobile drill-down body when "New conversation" is tapped, and
//   - in place of the old dead-end empty card when an agent is connected but has no
//     history yet (the most common first-run case).
//
// Gating lives in ONE place here: when the selected agent has no online connection,
// the pane shows a localized reason (start the daemon first) rather than a disabled
// composer — never a silent empty. When online connections exist, the composer is
// live and `onStarted` hands the freshly-created session back so the container can
// auto-select it (the new conversation slides into the transcript view).

import { useTranslations } from "next-intl";
import { MessageCirclePlus, WifiOff } from "lucide-react";
import { AdHocSendForm } from "../send-instruction-box";
import type { ConnectionView } from "../types";
import type { SessionView } from "@/services/daemon-session.service";

export function NewConversationPane({
  agentUuid,
  agentName,
  onlineConnections,
  onStarted,
}: {
  // The selected agent the new conversation will target. Null only in the
  // degenerate no-agent case (the container shows its own card then), so the
  // composer is gated behind a non-null uuid.
  agentUuid: string | null;
  agentName: string;
  // The selected agent's ONLINE connections — the ad-hoc picker candidates.
  onlineConnections: ConnectionView[];
  onStarted: (session: SessionView) => void;
}) {
  const t = useTranslations("daemonChat");
  const hasOnline = agentUuid !== null && onlineConnections.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header — mirrors the transcript header's geometry so the panes feel like
          one surface. */}
      <div className="flex flex-col gap-1.5 px-6 py-4">
        <h3 className="flex items-center gap-2 text-[17px] font-semibold text-[#2C2C2C]">
          <MessageCirclePlus className="h-[18px] w-[18px] text-[#C67A52]" aria-hidden />
          {t("newConversationTitle")}
        </h3>
        <p className="text-[13px] leading-relaxed text-[#6B6B6B]">
          {agentUuid
            ? t("newConversationBody", { agent: agentName })
            : t("newConversationNoAgent")}
        </p>
      </div>
      <div className="h-px w-full bg-[#EFEBE4]" />

      {/* Body — the live composer, or a localized "start the daemon" reason. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5">
        {hasOnline ? (
          <AdHocSendForm
            agentUuid={agentUuid}
            onlineConnections={onlineConnections}
            layout="inline"
            hideHeader
            onStarted={onStarted}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed border-[#E7D9C9] bg-[#FFF9F3] p-8 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#D9770615]">
              <WifiOff className="h-5 w-5 text-[#B45309]" aria-hidden />
            </div>
            <p className="text-[13px] font-medium text-[#92400E]">
              {t("newConversationNoOnlineTitle")}
            </p>
            <p className="max-w-[300px] text-[12px] leading-relaxed text-[#6B6B6B]">
              {t("newConversationNoOnlineBody")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
