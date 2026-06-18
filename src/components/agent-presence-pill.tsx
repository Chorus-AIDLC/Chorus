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
        className="inline-flex h-2 w-2 rounded-full bg-[#D97706] opacity-80"
      />
    );
  }
  // online → pulsing green; idle + loading → flat grey (loading additionally
  // mutes the surrounding text so the two stay distinguishable).
  return <StatusDot online={state === "online"} size="sm" />;
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

// The presence pill. `mobile` widens the type scale a touch to match the
// profile block's mobile-drawer sizing (the only other resident rail element
// that tunes by `mobile`).
export function AgentPresencePill({ mobile = false }: { mobile?: boolean }) {
  const t = useTranslations("agentPresence");
  const { status, onlineCount, connections, executionsByConnection, setModalOpen } =
    useAgentPresence();

  const textSize = mobile ? "text-[13px]" : "text-[11px]";
  const countSize = mobile ? "text-[15px]" : "text-[13px]";

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

  // The pill's text. Error must NEVER read as "0 online" (no silent error);
  // loading is a muted placeholder with no count flash; idle and online both
  // show the localized "{count} online" with the count as the emphasized glyph.
  let label: React.ReactNode;
  if (status === "error") {
    label = (
      <span className="truncate text-[#B45309]" title={t("unavailable")}>
        {t("unavailable")}
      </span>
    );
  } else if (status === "loading") {
    label = (
      <span className="truncate text-muted-foreground/60">{t("loading")}</span>
    );
  } else {
    label = (
      <span className="truncate text-muted-foreground">
        <span className={`font-semibold tabular-nums text-foreground ${countSize}`}>
          {onlineCount}
        </span>{" "}
        {t("online")}
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
          size="sm"
          aria-label={t("pillAria")}
          className={`w-full justify-start gap-2 rounded-lg px-2.5 ${mobile ? "h-9" : "h-8"} text-muted-foreground hover:text-foreground ${textSize}`}
        >
          <PillDot state={dotState} />
          {label}
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
