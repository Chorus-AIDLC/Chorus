"use client";

// Send-instruction dock for the agent-presence module (子2 — UI send side).
//
// The human-facing half of "send an instruction to the agent under a daemon": a
// free-text Textarea + a Send control that appends a `human_instruction` turn to
// a daemon session, plus an ad-hoc fallback that starts a NEW session on a chosen
// online connection. It slots into the Agent Connections detail pane as a sibling
// section beneath the ExecutionPane, reusing the same warm-deck vocabulary (the
// `#FCFBF8` framed card, terracotta accent, monospace data) so it reads as the
// deck's "transmit dock", not a foreign chat widget.
//
// This component does NOT render the turn-by-turn transcript / agent output — that
// consumption view is 子3. Here we only compose + dispatch + gate.
//
// Targeting + gating (all server-authoritative; the UI mirrors the same verdicts
// for instant feedback, the server re-checks on every POST):
//   - The selected connection's idea-anchored session is the default send target,
//     resolved from GET /api/daemon-sessions (each row carries `originOnline`).
//   - When the target session's origin is offline → the direct-send path is
//     disabled with a visible localized reason, and the ad-hoc path is offered so
//     the user can start a fresh session on a still-online connection.
//   - When the agent has NO online connection at all → both paths are disabled
//     with a visible localized reason (nothing to dispatch to).
//
// Errors surface their server reason, not a generic failure: 409 (origin went
// read-only between render and send) and 400 (empty / over-length, defensively —
// the client also gates these before the POST) both toast the localized reason.

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, MessageCirclePlus, Radio, SendHorizonal, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { useClientTypeLabel } from "./hooks";
import type { ConnectionView } from "./types";

// Mirror of the server-side `MAX_INSTRUCTION_CHARS` (daemon-instruction.service.ts)
// so the UI can gate over-length text and render a truthful char counter without a
// round-trip. The server remains authoritative; this only avoids a doomed POST.
export const MAX_INSTRUCTION_CHARS = 4000;

// The session-targeting row shape from GET /api/daemon-sessions (the subset the
// send box needs). Mirrors `SessionTargetView` (daemon-instruction.service.ts).
export interface SessionTarget {
  uuid: string;
  agentUuid: string;
  sessionId: string;
  directIdeaUuid: string | null;
  originConnectionUuid: string;
  status: string;
  title: string | null;
  lastTurnAt: string;
  originOnline: boolean;
}

// =====================================================================
// Shared compose surface — a Textarea + a labeled footer (char counter +
// disabled-reason + trailing Send button). Geometry is layout-aware so the
// narrow mobile drill-down stacks the footer while the wide desktop pane keeps
// it inline, matching the ExecutionRow inline/stacked convention.
// =====================================================================

function ComposeField({
  value,
  onChange,
  onSend,
  pending,
  disabled,
  disabledReason,
  placeholder,
  sendLabel,
  layout,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  pending: boolean;
  // Hard-disabled (no online origin): the textarea + send are both inert.
  disabled: boolean;
  // The localized reason shown when `disabled` — required to be visible (not just
  // a tooltip) so the gate is never silent.
  disabledReason: string | null;
  placeholder: string;
  sendLabel: string;
  layout: "inline" | "stacked";
}) {
  const t = useTranslations("agentConnections");
  const trimmedLength = value.trim().length;
  const overLimit = trimmedLength > MAX_INSTRUCTION_CHARS;
  const empty = trimmedLength === 0;
  // The Send control is inert when hard-disabled, mid-flight, empty, or over the
  // cap. Empty/over-length are the client mirror of the server's 400 guard.
  const sendDisabled = disabled || pending || empty || overLimit;

  // Cmd/Ctrl+Enter sends (plain Enter inserts a newline so multi-line
  // instructions are natural). IME composition MUST early-return so a CJK/JP/KR
  // candidate-confirm Enter never fires the send (CLAUDE.md IME rule).
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!sendDisabled) onSend();
    }
  };

  const counter = (
    <span
      className={`font-mono text-[11px] tabular-nums ${
        overLimit ? "font-semibold text-[#B45309]" : "text-[#9A9A9A]"
      }`}
      aria-live="polite"
    >
      {t("instructionCounter", { count: trimmedLength, max: MAX_INSTRUCTION_CHARS })}
    </span>
  );

  const sendButton = (
    <Button
      type="button"
      size="sm"
      onClick={onSend}
      disabled={sendDisabled}
      aria-label={sendLabel}
      className="h-8 shrink-0 gap-1.5 rounded-lg bg-[#C67A52] px-3.5 text-[13px] font-medium text-white hover:bg-[#B56A44] disabled:bg-[#E5E0D8] disabled:text-[#9A9A9A]"
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
      ) : (
        <SendHorizonal className="h-3.5 w-3.5" aria-hidden />
      )}
      {sendLabel}
    </Button>
  );

  // The disabled reason (hard gate) takes precedence; otherwise show the
  // over-length warning inline so the user knows why Send is inert.
  const reason = disabled
    ? disabledReason
    : overLimit
      ? t("instructionTooLong")
      : null;

  const footerLeft = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {reason ? (
        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[#B45309]">
          <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{reason}</span>
        </span>
      ) : (
        <span className="text-[12px] text-[#9A9A9A]">{t("instructionHint")}</span>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-2.5">
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled || pending}
        placeholder={placeholder}
        rows={3}
        aria-invalid={overLimit || undefined}
        className="min-h-[76px] resize-none rounded-xl border-[#E5E0D8] bg-white text-[14px] text-[#2C2C2C] placeholder:text-[#9A9A9A] focus-visible:border-[#C67A52] focus-visible:ring-[#C67A52]/30"
      />
      {layout === "stacked" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            {footerLeft}
            {counter}
          </div>
          {sendButton}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          {footerLeft}
          <div className="flex shrink-0 items-center gap-3">
            {counter}
            {sendButton}
          </div>
        </div>
      )}
    </div>
  );
}

// =====================================================================
// Ad-hoc path — a connection picker + compose surface that starts a NEW session
// on the chosen ONLINE connection. Offered when the selected connection has no
// continuable idea-anchored session (or its origin went offline) but the agent
// still has at least one online connection to dispatch to.
// =====================================================================

function AdHocSendForm({
  agentUuid,
  onlineConnections,
  layout,
}: {
  agentUuid: string;
  // Online connections of the SELECTED agent only (the picker never lists another
  // agent's connections — the server re-verifies ownership + online on POST).
  onlineConnections: ConnectionView[];
  layout: "inline" | "stacked";
}) {
  const t = useTranslations("agentConnections");
  const clientTypeLabel = useClientTypeLabel();
  // Default to the first online connection so the common single-daemon case needs
  // no extra click; the user can re-pick when several are online.
  const [connectionUuid, setConnectionUuid] = useState<string>(
    onlineConnections[0]?.uuid ?? "",
  );
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);

  const send = async () => {
    const trimmed = value.trim();
    if (!connectionUuid || trimmed.length === 0 || trimmed.length > MAX_INSTRUCTION_CHARS) {
      return;
    }
    setPending(true);
    try {
      const res = await authFetch("/api/daemon-sessions/ad-hoc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentUuid, connectionUuid, instructionText: trimmed }),
      });
      if (!res.ok) {
        toast.error(await extractError(res, t("instructionError")));
        return;
      }
      toast.success(t("adHocSessionStarted"));
      setValue("");
    } catch (error) {
      clientLogger.error("Failed to start ad-hoc daemon session:", error);
      toast.error(t("instructionError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-dashed border-[#E5E0D8] bg-white p-4">
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-semibold text-[#2C2C2C]">
          {t("adHocTitle")}
        </span>
        <span className="text-[12px] leading-relaxed text-[#9A9A9A]">
          {t("adHocBody")}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
          {t("pickConnection")}
        </span>
        <Select value={connectionUuid} onValueChange={setConnectionUuid}>
          <SelectTrigger
            aria-label={t("pickConnection")}
            className="w-full rounded-lg border-[#E5E0D8] bg-white text-[13px] text-[#2C2C2C]"
          >
            <SelectValue placeholder={t("pickConnectionPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {onlineConnections.map((conn) => (
              <SelectItem key={conn.uuid} value={conn.uuid}>
                {(conn.agentName?.trim() || t("unknownAgent")) +
                  " · " +
                  clientTypeLabel(conn.clientType) +
                  (conn.host ? " · " + conn.host : "")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ComposeField
        value={value}
        onChange={setValue}
        onSend={send}
        pending={pending}
        disabled={false}
        disabledReason={null}
        placeholder={t("sendInstructionPlaceholder")}
        sendLabel={t("startSession")}
        layout={layout}
      />
    </div>
  );
}

// =====================================================================
// SendInstructionBox — the public dock. Composes the header, the direct-send
// path (gated on the target session's origin being online), and the ad-hoc
// fallback path. Mounted by the detail pane for the selected connection.
// =====================================================================

// The sentinel Select value for "start a NEW ad-hoc conversation" (vs. continuing an
// existing session whose value is its uuid). Not a real session uuid, so it can never
// collide with one.
const NEW_CONVERSATION = "__new__";

export function SendInstructionBox({
  connection,
  sessions,
  onlineConnections,
  layout = "inline",
}: {
  // The currently-selected connection in the detail pane — its agent is the send target.
  connection: ConnectionView;
  // The caller's visible daemon sessions (GET /api/daemon-sessions). Filtered here to the
  // selected connection's agent; the user may pick one to CONTINUE, or start a new one.
  sessions: SessionTarget[];
  // The agent's currently-online connections, for the ad-hoc picker.
  onlineConnections: ConnectionView[];
  layout?: "inline" | "stacked";
}) {
  const t = useTranslations("agentConnections");
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);

  // Sessions of THIS connection's agent, most-recent first — the "continue an existing
  // conversation" choices (includes idea sessions woken by other channels, per the
  // chat-like model). The DEFAULT is always a NEW ad-hoc conversation, NOT auto-continuing
  // one of these: a free-text instruction typed into the generic agent dock means "talk to
  // the agent", not "resume whatever business idea this connection last worked on".
  const agentSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.agentUuid === connection.agentUuid)
        .sort((a, b) => (a.lastTurnAt < b.lastTurnAt ? 1 : -1)),
    [sessions, connection.agentUuid],
  );

  // Target selection: New conversation (default) or a specific existing session uuid.
  const [target, setTarget] = useState<string>(NEW_CONVERSATION);
  const selectedSession =
    target === NEW_CONVERSATION
      ? null
      : agentSessions.find((s) => s.uuid === target) ?? null;

  const hasOnlineConnection = onlineConnections.length > 0;

  const sendToSession = async (session: SessionTarget) => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_INSTRUCTION_CHARS) return;
    setPending(true);
    try {
      const res = await authFetch(`/api/daemon-sessions/${session.uuid}/instruction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructionText: trimmed }),
      });
      if (!res.ok) {
        // 409 read-only (origin went offline) / 400 (empty/over-length) / other —
        // surface the server's localized reason, not a generic failure.
        toast.error(await extractError(res, t("instructionError")));
        return;
      }
      toast.success(t("instructionSent"));
      setValue("");
    } catch (error) {
      clientLogger.error("Failed to send daemon instruction:", error);
      toast.error(t("instructionError"));
    } finally {
      setPending(false);
    }
  };

  // A continued session is sendable only when its origin is online right now (the server
  // re-checks; this mirrors it for the gate).
  const continueDisabledReason =
    selectedSession && !selectedSession.originOnline ? t("originOffline") : null;

  const sessionLabel = (s: SessionTarget) =>
    (s.title?.trim() ||
      (s.directIdeaUuid
        ? t("sessionIdeaLabel", { id: s.directIdeaUuid.slice(0, 8) })
        : t("sessionAdHocLabel", { id: s.sessionId.slice(0, 8) }))) +
    (s.originOnline ? "" : " · " + t("originOfflineTag"));

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-[#EFEBE4] bg-[#FCFBF8] p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-[#C67A52]" aria-hidden />
          <span className="text-[14px] font-semibold text-[#2C2C2C]">
            {t("sendInstruction")}
          </span>
        </div>
      </div>

      {/* Target selector: NEW conversation (default) or continue an existing session.
          When the agent has existing sessions we show the picker; otherwise the dock is
          purely a new-conversation composer. */}
      {agentSessions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
            {t("targetConversation")}
          </span>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger
              aria-label={t("targetConversation")}
              className="w-full rounded-lg border-[#E5E0D8] bg-white text-[13px] text-[#2C2C2C]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW_CONVERSATION}>
                <span className="inline-flex items-center gap-2">
                  <MessageCirclePlus className="h-3.5 w-3.5 text-[#C67A52]" aria-hidden />
                  {t("newConversation")}
                </span>
              </SelectItem>
              {agentSessions.map((s) => (
                <SelectItem key={s.uuid} value={s.uuid}>
                  {sessionLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* NEW conversation (default): ad-hoc start on a chosen online connection. */}
      {target === NEW_CONVERSATION &&
        (hasOnlineConnection ? (
          <AdHocSendForm
            agentUuid={connection.agentUuid}
            onlineConnections={onlineConnections}
            layout={layout}
          />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[#B45309]">
            <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t("noOnlineConnection")}
          </span>
        ))}

      {/* CONTINUE an existing session: gated on its origin being online. */}
      {selectedSession && (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-end">
            <Badge
              variant="secondary"
              className={`shrink-0 gap-1 border-0 px-2 py-0.5 text-[10px] font-medium ${
                selectedSession.originOnline
                  ? "bg-[#DCFCE7] text-[#15803D]"
                  : "bg-[#F0EDE8] text-[#9A8C7E]"
              }`}
            >
              {selectedSession.originOnline
                ? t("originOnlineTag")
                : t("originOfflineTag")}
            </Badge>
          </div>
          <ComposeField
            value={value}
            onChange={setValue}
            onSend={() => sendToSession(selectedSession)}
            pending={pending}
            disabled={!selectedSession.originOnline}
            disabledReason={continueDisabledReason}
            placeholder={t("sendInstructionPlaceholder")}
            sendLabel={t("send")}
            layout={layout}
          />
        </div>
      )}
    </div>
  );
}

// Pull the server's localized `error` string off a failed response, falling back
// to the provided localized default for a non-JSON / fieldless body (mirrors the
// ExecutionRow interrupt/resume error handling — never a silent generic).
async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const json = await res.json();
    if (json && typeof json.error === "string" && json.error) {
      return json.error;
    }
  } catch {
    // Non-JSON error body — keep the localized fallback.
  }
  return fallback;
}
