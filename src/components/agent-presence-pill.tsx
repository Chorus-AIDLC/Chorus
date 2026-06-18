"use client";

// Sidebar agent-presence pill + its click popover.
//
// The resident, always-visible rail affordance for "how many of my agents are
// online right now, and what are they doing". It reads ONLY from the shell-level
// `useAgentPresence()` spine (single poll + single SSE for the whole shell — see
// agent-presence-context.tsx); it never fetches anything itself. The pill body
// renders the three non-silent presence states, and clicking it opens a shadcn
// Popover (NOT a hover tooltip) that lists the online connections with their
// running/queued executions via the shared agent-presence rendering vocabulary.
//
// Why the pill is permanently visible (even at 0 online): presence is standing
// information. A pill that vanishes when nobody is online is indistinguishable
// from a broken/absent feature, and a failed poll that silently shows "0 online"
// hides an error. So idle (0 online), loading, and error are three visually
// distinct states and none of them is blank.

import { useTranslations } from "next-intl";
import { ListChecks, Play } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useAgentPresence } from "@/contexts/agent-presence-context";
import {
  ExecutionRow,
  ExecutionSection,
  IdentityBlock,
  StatusDot,
  useNowTick,
  type ConnectionView,
  type ExecutionView,
} from "@/components/agent-presence";

// The status dot rendered in the trigger pill. Four states:
//  - online (count > 0) → the shared pulsing-green StatusDot (halo gated behind
//    motion-safe so reduced-motion degrades to a static dot),
//  - idle (0 online) / loading → the shared flat grey StatusDot (offline form),
//  - error   → an amber/“unavailable” dot, never green and never a count.
// The online + idle branches REUSE the shared StatusDot so the pulse/grey
// vocabulary can never drift from the modal/page; only the amber error dot is
// pill-local (StatusDot has no error state).
function PillDot({
  state,
}: {
  state: "loading" | "error" | "idle" | "online";
}) {
  if (state === "error") {
    return (
      <span
        aria-hidden
        className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-[#D97706] opacity-90"
      />
    );
  }
  // online → pulsing green; idle + loading → flat grey (loading additionally
  // mutes the surrounding text so the two stay distinguishable). `md` matches the
  // capsule's larger scale and the modal/rail dot vocabulary.
  return (
    <span className="shrink-0">
      <StatusDot online={state === "online"} size="md" />
    </span>
  );
}

// The list of online connections + their running/queued executions, rendered
// inside the popover. Interrupted rows are deliberately dropped here — the
// popover is glanceable and has no resume control (that is the modal's job).
function PopoverBody({
  onlineConnections,
  executionsByConnection,
  nowMs,
}: {
  onlineConnections: ConnectionView[];
  executionsByConnection: Record<string, ExecutionView[]>;
  nowMs: number;
}) {
  const t = useTranslations("agentPresence");
  const ta = useTranslations("agentConnections");

  if (onlineConnections.length === 0) {
    return (
      <p className="px-1 py-2 text-[13px] text-[#9A9A9A]">{t("popoverEmpty")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {onlineConnections.map((connection) => {
        const execs = executionsByConnection[connection.uuid] ?? [];
        // Glanceable surface: only running + queued. Interrupted rows are the
        // modal's concern (they carry a resume affordance this popover lacks).
        const running = execs.filter((e) => e.status === "running");
        const queued = execs.filter((e) => e.status === "queued");
        const hasActive = running.length > 0 || queued.length > 0;

        return (
          <div key={connection.uuid} className="flex flex-col gap-2.5">
            <IdentityBlock connection={connection} size="sm" />
            {hasActive ? (
              <div className="flex flex-col gap-4 pl-1">
                {running.length > 0 && (
                  <ExecutionSection
                    icon={Play}
                    label={ta("execRunning")}
                    count={running.length}
                  >
                    {running.map((exec) => (
                      <ExecutionRow key={exec.uuid} exec={exec} nowMs={nowMs} />
                    ))}
                  </ExecutionSection>
                )}
                {queued.length > 0 && (
                  <ExecutionSection
                    icon={ListChecks}
                    label={ta("execQueued")}
                    count={queued.length}
                  >
                    {queued.map((exec) => (
                      <ExecutionRow key={exec.uuid} exec={exec} nowMs={nowMs} />
                    ))}
                  </ExecutionSection>
                )}
              </div>
            ) : (
              // Quiet idle line — never blank — when an online connection has no
              // running or queued work.
              <p className="pl-1 text-[12px] text-[#9A9A9A]">
                {t("connectionIdle")}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Per-state capsule skin. The presence pill is a full-width warm "capsule" that
// coheres with the rail (not a bare ghost button). Boldness lives in exactly one
// place — the count glyph — so the surface around it stays quiet. Each state is
// visually distinct (no silent error): online tints the count green, error
// shifts the whole capsule amber, loading/idle stay neutral-muted.
const CAPSULE_SKIN: Record<
  "loading" | "error" | "idle" | "online",
  string
> = {
  // Warm neutral surface + hairline border; subtle hover lift toward the brand
  // terracotta wash used elsewhere in the rail.
  online:
    "border-[#E7E1D7] bg-[#FCFBF8] hover:bg-[#FBF4EF] hover:border-[#E2D6C9]",
  idle: "border-[#EAE5DC] bg-[#FAF8F4] hover:bg-[#F6F2EC]",
  loading: "border-[#EAE5DC] bg-[#FAF8F4]",
  // Error reskins the capsule amber so a failed poll can never read as "0 online".
  error: "border-[#EBD9C4] bg-[#FFF9F2] hover:bg-[#FEF3E4]",
};

// The presence pill. `mobile` widens the type scale a touch to match the
// profile block's mobile-drawer sizing (the only other resident rail element
// that tunes by `mobile`).
export function AgentPresencePill({ mobile = false }: { mobile?: boolean }) {
  const t = useTranslations("agentPresence");
  const { status, onlineCount, connections, executionsByConnection, setModalOpen } =
    useAgentPresence();

  const countSize = mobile ? "text-[17px]" : "text-[15px]";
  const unitSize = mobile ? "text-[12.5px]" : "text-[11.5px]";

  // Derive the single rendered state from (status, onlineCount). Loading and
  // error are owned by the provider's poll lifecycle; idle vs online is purely
  // the count once the poll has settled to "ok".
  const dotState: "loading" | "error" | "idle" | "online" =
    status === "loading"
      ? "loading"
      : status === "error"
        ? "error"
        : onlineCount > 0
          ? "online"
          : "idle";

  // The capsule body. Error must NEVER read as "0 online" (no silent error);
  // loading is a muted placeholder with no count flash; idle and online show the
  // emphasized count glyph + a pluralized "agent(s) online" unit.
  let body: React.ReactNode;
  if (status === "error") {
    body = (
      <span className={`truncate font-medium text-[#B45309] ${unitSize}`}>
        {t("unavailable")}
      </span>
    );
  } else if (status === "loading") {
    body = (
      <span className={`truncate text-muted-foreground/70 ${unitSize}`}>
        {t("loading")}
      </span>
    );
  } else {
    const onlineTint = onlineCount > 0 ? "text-[#15803D]" : "text-foreground/80";
    body = (
      <span className={`flex min-w-0 items-baseline gap-1.5 truncate ${unitSize}`}>
        <span
          className={`font-semibold leading-none tabular-nums ${onlineTint} ${countSize}`}
        >
          {onlineCount}
        </span>
        <span className="truncate text-muted-foreground">
          {t("onlineUnit", { count: onlineCount })}
        </span>
      </span>
    );
  }

  const onlineConnections = connections.filter(
    (c) => c.effectiveStatus === "online",
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          aria-label={t("pillAria")}
          className={`group h-auto w-full justify-start gap-2.5 rounded-xl border px-3 ${mobile ? "py-2.5" : "py-2"} shadow-[0_1px_2px_rgba(44,44,44,0.03)] transition-colors ${CAPSULE_SKIN[dotState]}`}
        >
          <PillDot state={dotState} />
          {body}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="max-h-[60vh] w-[300px] overflow-y-auto p-3"
      >
        <PopoverContentInner
          onlineConnections={onlineConnections}
          executionsByConnection={executionsByConnection}
          onViewAll={() => setModalOpen(true)}
        />
      </PopoverContent>
    </Popover>
  );
}

// The popover body + footer. Split out so the 1s tick (which drives running-row
// elapsed timers) only mounts when the popover is open — the PopoverContent is
// unmounted while closed, so the interval lives exactly as long as the popover.
function PopoverContentInner({
  onlineConnections,
  executionsByConnection,
  onViewAll,
}: {
  onlineConnections: ConnectionView[];
  executionsByConnection: Record<string, ExecutionView[]>;
  onViewAll: () => void;
}) {
  const t = useTranslations("agentPresence");
  const nowMs = useNowTick();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-[#6B6B6B]">
          {t("popoverTitle")}
        </span>
      </div>
      <PopoverBody
        onlineConnections={onlineConnections}
        executionsByConnection={executionsByConnection}
        nowMs={nowMs}
      />
      <Button
        variant="ghost"
        size="sm"
        onClick={onViewAll}
        className="w-full justify-center text-[12px] font-medium text-[#C67A52] hover:bg-[#C67A5214] hover:text-[#A65F3C]"
      >
        {t("viewAll")}
      </Button>
    </div>
  );
}
