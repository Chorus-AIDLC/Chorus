"use client";

// ConversationalEntry — the reusable "describe it to an online agent" surface
// (add-conversational-idea-entry). A consumer embeds this where a static form
// would otherwise collect free text (first consumer: the create-idea modal's
// conversational mode) and owns HOW the text becomes an instruction via
// `buildInstruction`; this component owns everything transport-side:
//
//   detect   — online daemon connections via the shell presence spine
//              (`useAgentPresenceOptional`; a null context or zero online
//              connections renders the offline fallback),
//   pick     — agent (Select) + that agent's (host, cwd) instance (the shared
//              InstancePicker; a sole instance auto-selects, 2+ require an
//              explicit pick before Send enables),
//   compose  — the consumer's `buildInstruction(userText)` wraps the verbatim
//              description into the final dispatched instruction,
//   dispatch — POST /api/daemon-sessions/ad-hoc (the existing ad-hoc endpoint;
//              no new backend), then hand the created SessionView to
//              `onStarted` so the consumer can close itself and land the user
//              on the new conversation (`openChatForSession`).
//
// Char budget: the USER text is capped at USER_TEXT_MAX_CHARS (3000) with a
// visible counter near the limit, reserving template headroom under the server's
// MAX_INSTRUCTION_CHARS (4000) so a composed instruction never 400s on length.
//
// Errors are never silent: a 409 (the picked connection went offline between the
// presence poll and the send) renders an inline retryable error AND re-polls the
// connection list immediately (`refreshConnections`) so the picker re-syncs;
// other failures surface the server reason inline the same way.

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, SendHorizonal, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authFetch } from "@/lib/auth-client";
import { clientLogger } from "@/lib/logger-client";
import { isImeComposing } from "@/lib/ime";
import { useAgentPresenceOptional } from "@/contexts/agent-presence-context";
import type { SessionView } from "@/services/daemon-session.service";
import { DaemonConnectCta } from "./daemon-connect-cta";
import { InstancePicker, type InstanceCandidate } from "./instance-picker";
import {
  connectionsToInstanceCandidates,
  extractInstructionError,
} from "./send-instruction-box";
import type { ConnectionView } from "./types";

// Client cap on the USER's free text. The composed instruction = template + user
// text and must stay under the server's MAX_INSTRUCTION_CHARS (4000); capping the
// user share at 3000 leaves ~1000 chars of template headroom (the create-idea
// template uses ~500). Consumers with a heavier template should keep it inside
// that headroom rather than raising this cap.
export const USER_TEXT_MAX_CHARS = 3000;

// Show the live character counter once the user is within this many chars of the
// cap (a counter from char 0 is noise; near the limit it is the affordance).
const COUNTER_VISIBLE_FROM = USER_TEXT_MAX_CHARS - 500;

export interface ConversationalEntryProps {
  // Composes the final dispatched instruction around the user's verbatim text.
  // The CONSUMER owns the template (what the agent is told to do); this
  // component owns selection + transport.
  buildInstruction: (userText: string) => string;
  // Rendered when no daemon connection is online (or the presence provider is
  // absent). Defaults to the shared DaemonConnectCta guidance.
  offlineFallback?: ReactNode;
  // Called with the created session after a successful dispatch — the consumer
  // typically closes itself and calls `openChatForSession(session)`.
  onStarted: (session: SessionView) => void;
  // Preselect this agent when it has an online connection (e.g. a future
  // idea-detail entry point that already knows the assignee).
  defaultAgentUuid?: string;
}

// Group the online connections by agent for the agent Select. Insertion order
// follows the connection list (server-deterministic ordering).
function groupByAgent(
  online: ConnectionView[],
): Array<{ agentUuid: string; agentName: string; connections: ConnectionView[] }> {
  const groups = new Map<
    string,
    { agentUuid: string; agentName: string; connections: ConnectionView[] }
  >();
  for (const c of online) {
    const existing = groups.get(c.agentUuid);
    if (existing) {
      existing.connections.push(c);
    } else {
      groups.set(c.agentUuid, {
        agentUuid: c.agentUuid,
        agentName: c.agentName?.trim() || c.agentUuid.slice(0, 8),
        connections: [c],
      });
    }
  }
  return [...groups.values()];
}

export function ConversationalEntry({
  buildInstruction,
  offlineFallback,
  onStarted,
  defaultAgentUuid,
}: ConversationalEntryProps) {
  const t = useTranslations("conversationalEntry");
  const presence = useAgentPresenceOptional();

  // Online detection — the server-derived verdict only. An absent provider (a
  // consumer mounted outside the dashboard shell) is treated exactly like zero
  // online connections: the offline fallback renders.
  const onlineConnections = useMemo(
    () =>
      (presence?.connections ?? []).filter(
        (c) => c.effectiveStatus === "online",
      ),
    [presence?.connections],
  );
  const agentGroups = useMemo(
    () => groupByAgent(onlineConnections),
    [onlineConnections],
  );

  // Agent selection: explicit pick wins while it still resolves to an online
  // group; otherwise prefer the consumer's default, then the sole/first group.
  const [pickedAgentUuid, setPickedAgentUuid] = useState<string | null>(null);
  const selectedAgent =
    agentGroups.find((g) => g.agentUuid === pickedAgentUuid) ??
    agentGroups.find((g) => g.agentUuid === defaultAgentUuid) ??
    (agentGroups.length === 1 ? agentGroups[0] : null);

  // Instance selection within the picked agent. The picker auto-selects a sole
  // instance; 2+ instances require an explicit pick (send stays disabled).
  const [pickedConnectionUuid, setPickedConnectionUuid] = useState<string | null>(
    null,
  );
  const instances: InstanceCandidate[] = useMemo(
    () => connectionsToInstanceCandidates(selectedAgent?.connections ?? []),
    [selectedAgent],
  );
  // The selection is valid only while it still points at one of the CURRENT
  // agent's online instances (agent switch / connection drop invalidates it).
  const selectedInstance =
    instances.find((i) => i.connectionUuid === pickedConnectionUuid) ?? null;

  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  // Inline (non-toast) dispatch error — the entry usually lives in a modal where
  // an inline message beats a toast behind the overlay. Cleared on each retry.
  const [sendError, setSendError] = useState<string | null>(null);

  const trimmed = text.trim();
  const overBudget = text.length > USER_TEXT_MAX_CHARS;
  const sendDisabled =
    pending || !selectedAgent || !selectedInstance || trimmed.length === 0 || overBudget;

  const send = async () => {
    if (sendDisabled || !selectedAgent || !selectedInstance) return;
    setPending(true);
    setSendError(null);
    try {
      const res = await authFetch("/api/daemon-sessions/ad-hoc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentUuid: selectedAgent.agentUuid,
          connectionUuid: selectedInstance.connectionUuid,
          instructionText: buildInstruction(trimmed),
        }),
      });
      if (!res.ok) {
        // 409 = the picked connection went offline between the presence poll and
        // this send. Surface the reason inline AND re-poll the connection list so
        // the picker reflects reality for the retry.
        setSendError(
          await extractInstructionError(
            res,
            res.status === 409 ? t("connectionWentOffline") : t("sendError"),
          ),
        );
        if (res.status === 409) presence?.refreshConnections();
        return;
      }
      let created: SessionView | null = null;
      try {
        const json = await res.json();
        if (json?.success && json.data?.session) {
          created = json.data.session as SessionView;
        }
      } catch {
        // Non-JSON success body — fall through to the visible error below.
      }
      if (!created) {
        // A 2xx without a session payload cannot hand off to the chat — treat it
        // as a failed dispatch rather than silently closing the consumer.
        setSendError(t("sendError"));
        return;
      }
      setText("");
      onStarted(created);
    } catch (error) {
      clientLogger.error("Failed to dispatch conversational entry:", error);
      setSendError(t("sendError"));
    } finally {
      setPending(false);
    }
  };

  // Plain Enter sends, Shift+Enter inserts a newline — mirrors the ad-hoc
  // composer's binding. IME composition MUST early-return so a CJK/JP/KR
  // candidate-confirm Enter never fires the send (CLAUDE.md IME rule).
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!sendDisabled) send();
    }
  };

  // ===== Offline fallback =====
  if (onlineConnections.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[12.5px] leading-relaxed text-[#6B6B6B]">
          {t("noOnlineDaemon")}
        </p>
        {offlineFallback ?? <DaemonConnectCta variant="compact" />}
      </div>
    );
  }

  const showCounter = text.length >= COUNTER_VISIBLE_FROM;

  return (
    <div className="flex flex-col gap-3">
      {/* Agent select — hidden when only one agent is online (it is implied). */}
      {agentGroups.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
            {t("agentLabel")}
          </span>
          <Select
            value={selectedAgent?.agentUuid ?? ""}
            onValueChange={(v) => {
              setPickedAgentUuid(v);
              // The instance choice belongs to the previous agent — reset it.
              setPickedConnectionUuid(null);
            }}
          >
            <SelectTrigger aria-label={t("agentLabel")}>
              <SelectValue placeholder={t("agentPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {agentGroups.map((g) => (
                <SelectItem key={g.agentUuid} value={g.agentUuid}>
                  {g.agentName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Instance picker for the selected agent (online instances only; a sole
          instance auto-selects). No agent selected yet → prompt instead. */}
      {selectedAgent ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
            {t("instanceLabel")}
          </span>
          <InstancePicker
            instances={instances}
            selectedConnectionUuid={selectedInstance?.connectionUuid ?? null}
            onSelect={(inst) => setPickedConnectionUuid(inst.connectionUuid)}
            ariaLabel={t("instanceLabel")}
          />
        </div>
      ) : (
        <p className="text-[12px] text-[#9A9A9A]">{t("pickAgentFirst")}</p>
      )}

      {/* Description input — plain Enter sends (IME-guarded), Shift+Enter newline. */}
      <div className="flex flex-col gap-1.5">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={pending}
          placeholder={t("placeholder")}
          rows={5}
          className="min-h-[120px] resize-none rounded-xl border-[#E5E0D8] bg-white text-[14px] text-[#2C2C2C] placeholder:text-[#9A9A9A] focus-visible:border-[#C67A52] focus-visible:ring-[#C67A52]/30"
        />
        {showCounter && (
          <span
            aria-live="polite"
            className={
              overBudget
                ? "self-end text-[11px] font-medium text-[#B3261E]"
                : "self-end text-[11px] text-[#9A9A9A]"
            }
          >
            {t("charCounter", {
              count: text.length,
              max: USER_TEXT_MAX_CHARS,
            })}
          </span>
        )}
      </div>

      {/* Dispatch error — inline and retryable, never silent. */}
      {sendError && (
        <div className="flex items-start gap-1.5 text-[12px] font-medium text-[#B45309]">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{sendError}</span>
        </div>
      )}

      <Button
        type="button"
        onClick={send}
        disabled={sendDisabled}
        className="gap-1.5 self-end rounded-lg bg-[#C67A52] px-4 text-[13px] font-medium text-white hover:bg-[#B56A44] disabled:bg-[#E5E0D8] disabled:text-[#9A9A9A]"
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
        ) : (
          <SendHorizonal className="h-3.5 w-3.5" aria-hidden />
        )}
        {sendError ? t("retry") : t("send")}
      </Button>
    </div>
  );
}
