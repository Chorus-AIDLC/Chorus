"use client";

// Execution-row rendering vocabulary for the agent-presence module.
//
// Presentational + prop-driven: every renderer here takes an already-fetched
// `ExecutionView` (and a shared `nowMs` tick) as props — none of them fetch the
// dataset. The Interrupt / Resume controls POST a single command on user action
// (a row affordance, not dataset fetching). Shared by the popover, modal, and
// the (soon-relocated) Agent Connections page so running/queued/interrupted rows
// render byte-identically across surfaces.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import Link from "next/link";
import {
  Clock3,
  ExternalLink,
  Loader2,
  MessageSquare,
  OctagonX,
  PauseCircle,
  Play,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { authFetch } from "@/lib/auth-client";
import { clientLogger } from "@/lib/logger-client";
import type { ExecutionView } from "@/contexts/realtime-context";
import { execHref, useElapsedMono, useEntityTypeLabel } from "./hooks";

// Interrupt control for a RUNNING execution row (子3 — daemon-interrupt-resume).
//
// Visibility: the Agent Connections page is already viewer-scoped — a user only
// ever sees connections of agents they OWN, and an agent only sees its own (see
// GET /api/agent-connections). So every row rendered here belongs to a
// connection the viewer is authorized to control; the server re-checks
// owner-or-`task:admin` on POST /api/daemon/control as defense in depth. We
// therefore show Interrupt on every running row without a separate client-side
// authz probe.
//
// Confirmation: a destructive stop, so it routes through a shadcn AlertDialog
// (never a raw window.confirm / <dialog>). On confirm it fires ONE
// POST /api/daemon/control { command:"interrupt", targetConnectionUuid,
// entityType, entityUuid } — all already known from the 子2 execution row — and
// returns without waiting for the kill (the daemon reports the resulting
// `interrupted` task state asynchronously; the row simply drops out of the next
// execution snapshot). Errors surface via a toast with a localized fallback.
//
// Exported (alongside ResumeButton) so the daemon-chat reply composer can mount
// the SAME control byte-identically — same AlertDialog confirm, same endpoint,
// same toasts/entityType/entityUuid wiring (see send-instruction-box.tsx). Its
// internals are prop-driven and surface-agnostic; the standalone ExecutionRow
// and its other call sites (sidebar popover, Agent Connections deck) keep using
// it unchanged.
export function InterruptButton({ exec }: { exec: ExecutionView }) {
  const t = useTranslations("agentConnections");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const title = exec.entityTitle?.trim() || t("execEntityUnknown");

  const handleInterrupt = async () => {
    setPending(true);
    try {
      const res = await authFetch("/api/daemon/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "interrupt",
          targetConnectionUuid: exec.connectionUuid,
          entityType: exec.entityType,
          entityUuid: exec.entityUuid,
        }),
      });
      if (!res.ok) {
        let message = t("interruptError");
        try {
          const json = await res.json();
          if (json && typeof json.error === "string" && json.error) {
            message = json.error;
          }
        } catch {
          // Non-JSON error body — keep the localized fallback.
        }
        toast.error(message);
        return;
      }
      toast.success(t("interruptSuccess", { title }));
      setOpen(false);
    } catch (error) {
      clientLogger.error("Failed to request daemon interrupt:", error);
      toast.error(t("interruptError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("interruptAria")}
          className="h-7 shrink-0 gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-[#B45309] hover:bg-[#FEF3C7] hover:text-[#92400E]"
        >
          <OctagonX className="h-3.5 w-3.5" aria-hidden />
          {t("interrupt")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("interruptConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("interruptConfirmBody", { title })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{tc("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(e) => {
              // Keep the dialog mounted while the request is in flight so the
              // pending spinner shows; close happens on success above.
              e.preventDefault();
              void handleInterrupt();
            }}
          >
            {pending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" aria-hidden />
                {t("interrupting")}
              </>
            ) : (
              t("interruptConfirmAction")
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Resume control for a USER-interrupted execution row (子3 — daemon-interrupt-resume).
// Shown ONLY when status === "interrupted" AND interruptedReason === "user": a crash
// (reason === "crash") auto-recovers via the daemon's reconnect-backfill and is NOT
// manually resumable (q7=a), so it shows a static "auto-recovers" hint instead (see
// ExecutionRow). On click it POSTs /api/daemon/resume { targetConnectionUuid... };
// the server records the transition + dispatches a `resume` control command, and the
// row re-appears as running via the next execution snapshot. No confirm dialog —
// resume is non-destructive, unlike interrupt.
//
// Exported (alongside InterruptButton) so the daemon-chat reply composer can mount
// the SAME control byte-identically — same /api/daemon/resume endpoint, same
// toasts/entityType/entityUuid wiring. Internals unchanged.
export function ResumeButton({ exec }: { exec: ExecutionView }) {
  const t = useTranslations("agentConnections");
  const [pending, setPending] = useState(false);

  const title = exec.entityTitle?.trim() || t("execEntityUnknown");

  const handleResume = async () => {
    setPending(true);
    try {
      const res = await authFetch("/api/daemon/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionUuid: exec.connectionUuid,
          entityType: exec.entityType,
          entityUuid: exec.entityUuid,
        }),
      });
      if (!res.ok) {
        let message = t("resumeError");
        try {
          const json = await res.json();
          if (json && typeof json.error === "string" && json.error) {
            message = json.error;
          }
        } catch {
          // Non-JSON error body — keep the localized fallback.
        }
        toast.error(message);
        return;
      }
      toast.success(t("resumeSuccess", { title }));
    } catch (error) {
      clientLogger.error("Failed to request daemon resume:", error);
      toast.error(t("resumeError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      aria-label={t("resumeAria")}
      onClick={() => void handleResume()}
      className="h-7 shrink-0 gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-[#15803D] hover:bg-[#DCFCE7] hover:text-[#166534]"
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
      ) : (
        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
      )}
      {pending ? t("resuming") : t("resume")}
    </Button>
  );
}

// One execution row: the target resource's title (deep-linked per resource kind),
// a small resource-kind badge, an optional root-idea session badge, and a
// status-dependent trailing control:
//  - running     → a live HH:MM:SS elapsed indicator + an Interrupt control,
//  - queued      → a static "waiting" hint,
//  - interrupted → an "interrupted" badge + either a Resume control (reason=user)
//                  or a static "auto-recovers" hint (reason=crash).
// A row whose resource no longer resolves (deleted) falls back to a localized
// placeholder title and renders as plain text (no link).
//
// `layout` controls the geometry only — the status/controls logic is identical:
//  - "inline" (default): the title and the trailing controls share one flex row.
//    Used by the wide "View all" modal + connection view, where the row has room.
//  - "stacked": the title gets the full row width (relaxed from a hard truncate to
//    a two-line clamp) and the controls drop to a second line beneath it, so they
//    never squeeze the title. Used by the narrow sidebar popover.
export function ExecutionRow({
  exec,
  nowMs,
  layout = "inline",
}: {
  exec: ExecutionView;
  nowMs: number;
  layout?: "inline" | "stacked";
}) {
  const t = useTranslations("agentConnections");
  const formatElapsed = useElapsedMono();
  const entityTypeLabel = useEntityTypeLabel();
  const running = exec.status === "running";
  const interrupted = exec.status === "interrupted";
  const interruptedByUser = interrupted && exec.interruptedReason === "user";
  const stacked = layout === "stacked";

  // An ad-hoc conversation (`daemon_session`) has NO backing resource — it IS the
  // work. So it does NOT get a resource badge + a (necessarily absent) resource title
  // that degrades to "Unknown resource"; it reads as a single "Conversation" label,
  // using the session's own title when it has one. Every OTHER kind (task/idea/…) keeps
  // the badge + resource-title treatment, falling back to "Unknown" only for a genuinely
  // deleted resource.
  const isConversation = exec.entityType === "daemon_session";
  const title = isConversation
    ? exec.entityTitle?.trim() || t("execConversation")
    : exec.entityTitle?.trim() || t("execEntityUnknown");
  const href = execHref(exec);

  // Title clamp differs by layout: inline hard-truncates to one line (the modal has
  // width to spare and wants uniform row height); stacked relaxes to two lines so a
  // long title is readable in the narrow popover.
  const titleClamp = stacked ? "line-clamp-2" : "truncate";

  const iconTile = (
    <span
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
        running ? "bg-[#C67A5214]" : interrupted ? "bg-[#FEF3C7]" : "bg-[#F0EDE8]"
      }`}
      aria-hidden
    >
      {running ? (
        // Decorative spin gated behind motion-safe so reduced-motion users see
        // a static icon (same reduced-motion regime as the online pulse dot).
        <Loader2 className="h-4 w-4 text-[#C67A52] motion-safe:animate-spin" />
      ) : interrupted ? (
        <PauseCircle className="h-4 w-4 text-[#B45309]" />
      ) : (
        <Clock3 className="h-4 w-4 text-[#9A9A9A]" />
      )}
    </span>
  );

  const body = (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5">
        {/* A conversation carries no resource badge (it has no backing resource); a
            small chat glyph leads its title instead. Every other kind keeps its
            resource-type badge. */}
        {isConversation ? (
          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-[#C67A52]" aria-hidden />
        ) : (
          <Badge
            variant="secondary"
            className="shrink-0 border-0 bg-[#F0EDE8] px-1.5 py-0 text-[10px] font-medium text-[#6B6B6B]"
          >
            {entityTypeLabel(exec.entityType)}
          </Badge>
        )}
        {href ? (
          <Link
            href={href}
            className={`group inline-flex min-w-0 items-center gap-1.5 ${titleClamp} text-[14px] font-medium text-[#2C2C2C] hover:text-[#C67A52]`}
          >
            <span className={titleClamp}>{title}</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-[#C8C3BA] group-hover:text-[#C67A52]" />
          </Link>
        ) : (
          <span
            className={`block ${titleClamp} text-[14px] font-medium ${
              isConversation ? "text-[#2C2C2C]" : "text-[#9A9A9A]"
            }`}
          >
            {title}
          </span>
        )}
      </div>
      {exec.rootIdeaTitle && (
        <div className="mt-1 flex items-center gap-1.5">
          <Sparkles className="h-3 w-3 shrink-0 text-[#9A8C7E]" aria-hidden />
          <span className={`${stacked ? "" : "truncate"} text-[11px] text-[#9A8C7E]`}>
            {t("execSession", { idea: exec.rootIdeaTitle })}
          </span>
        </div>
      )}
    </div>
  );

  // Status/controls content — IDENTICAL across layouts; only its position changes.
  // running → elapsed + Interrupt; interrupted → badge + Resume/auto-recovers;
  // queued → "waiting". Kept as a fragment so both the inline trailing wrapper and
  // the stacked second row reuse the exact same control nodes.
  const controls = running ? (
    <>
      {exec.startedAt && (
        <span
          className="font-mono text-[12px] font-medium tabular-nums text-[#15803D]"
          title={t("execElapsedLabel")}
        >
          {formatElapsed(exec.startedAt, nowMs)}
        </span>
      )}
      <InterruptButton exec={exec} />
    </>
  ) : interrupted ? (
    <>
      <Badge
        variant="secondary"
        className="shrink-0 gap-1 border-0 bg-[#FEF3C7] px-2 py-0.5 text-[10px] font-medium text-[#B45309]"
      >
        <PauseCircle className="h-3 w-3" aria-hidden />
        {interruptedByUser ? t("execInterruptedUser") : t("execInterruptedCrash")}
      </Badge>
      {interruptedByUser ? (
        <ResumeButton exec={exec} />
      ) : (
        <span className="text-[11px] font-medium text-[#9A8C7E]">
          {t("execCrashAutoRecovers")}
        </span>
      )}
    </>
  ) : (
    <span className="text-[11px] font-medium text-[#9A9A9A]">
      {t("execWaiting")}
    </span>
  );

  // Stacked: icon + body on row 1 (top-aligned so a 2-line title doesn't shift the
  // icon), controls on row 2 indented to align under the body (pl-11 = 32px icon +
  // 12px gap). No shrink-0 on the controls row — they have the full width.
  if (stacked) {
    return (
      <li className="flex flex-col gap-2 rounded-xl border border-[#E5E0D8] bg-white px-3.5 py-3">
        <div className="flex items-start gap-3">
          {iconTile}
          {body}
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-11">{controls}</div>
      </li>
    );
  }

  // Inline (default): icon + body + trailing controls on one row. running/interrupted
  // wrap the controls in a shrink-0 flex group; queued is a single shrink-0 hint.
  return (
    <li className="flex items-center gap-3 rounded-xl border border-[#E5E0D8] bg-white px-3.5 py-3">
      {iconTile}
      {body}
      {running || interrupted ? (
        <div className="flex shrink-0 items-center gap-2">{controls}</div>
      ) : (
        <span className="shrink-0 text-[11px] font-medium text-[#9A9A9A]">
          {t("execWaiting")}
        </span>
      )}
    </li>
  );
}

// A labeled section (running / queued) with a count badge and its rows.
export function ExecutionSection({
  icon: Icon,
  label,
  count,
  children,
}: {
  icon: typeof Play;
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-[#C67A52]" aria-hidden />
        <span className="text-[12px] font-semibold uppercase tracking-wide text-[#6B6B6B]">
          {label}
        </span>
        <Badge
          variant="secondary"
          className="border-0 bg-[#F0EDE8] px-1.5 py-0 font-mono text-[10px] font-medium text-[#9A8C7E]"
        >
          {count}
        </Badge>
      </div>
      <ul className="flex flex-col gap-2">{children}</ul>
    </div>
  );
}
