"use client";

// Daemon presence entry — the single bottom-right floating affordance for
// "how many of my agents are online right now, and let me talk to one".
//
// It REPLACES two prior disjoint bottom-corner elements: the sidebar-docked
// presence pill (bottom-left) and the pixel-canvas widget button (bottom-right).
// It is mounted ONCE at the dashboard shell under `AgentPresenceProvider`, so it
// is company-wide and stays live across route changes (the provider survives
// navigation). It reads ONLY from the `useAgentPresence()` spine — it never
// fetches anything itself, so opening it starts no second connection poll.
//
// Interaction (collapses the old pill → popover → "View all" → modal chain):
//   click the floating button → a click-triggered Popover opens the slim online
//   roster, with a PROMINENT one-click "Open chat" action that opens the daemon
//   chat modal directly via `setModalOpen(true)`.
//
// The trigger reuses the pill's state vocabulary verbatim (via `deriveDotState`
// + `PillDot` + the capsule skin) so the three non-silent states are preserved:
// idle (visible "0 online"), loading (muted, no count flash), error (amber
// "unavailable", never "0 online"), and online (emphasized count + pulsing dot,
// reduced-motion-aware). The roster body is the shared `PresenceRosterBody`.
//
// The project-scoped pixel "View activity" secondary affordance is added by a
// follow-on task; this component intentionally leaves a slot (`extraActions`) for
// it so the pixel bridge can inject it without reworking the entry.

import { useTranslations } from "next-intl";
import { MessagesSquare, LayoutGrid } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useAgentPresence } from "@/contexts/agent-presence-context";
import { usePixelActivityOptional } from "@/contexts/pixel-activity-context";
import {
  groupConnectionsByAgent,
  onlineConnectionsOnly,
  useNowTick,
  type ExecutionView,
} from "@/components/agent-presence";
import {
  PillDot,
  PresenceRosterBody,
  deriveDotState,
} from "@/components/agent-presence/presence-roster";

// Per-state skin for the floating trigger. Boldness lives in exactly one place —
// the count glyph — so the surface around it stays quiet. Each state is visually
// distinct (no silent error): online tints the count green, error shifts the
// whole capsule amber, loading/idle stay neutral-muted. Mirrors the retired
// pill's CAPSULE_SKIN so the vocabulary does not drift.
const TRIGGER_SKIN: Record<
  "loading" | "error" | "idle" | "online",
  string
> = {
  online:
    "border-[#E7E1D7] dark:border-[#2a2a2e] bg-card hover:bg-[#FBF4EF] dark:hover:bg-[#26241f] hover:border-[#E2D6C9] dark:hover:border-[#3a3a40]",
  idle: "border-[#EAE5DC] dark:border-[#2a2a2e] bg-card hover:bg-[#F6F2EC] dark:hover:bg-[#26241f]",
  loading: "border-[#EAE5DC] dark:border-[#2a2a2e] bg-card",
  error:
    "border-[#EBD9C4] dark:border-[#3a2f1a] bg-[#FFF9F2] dark:bg-[#2a2113] hover:bg-[#FEF3E4] dark:hover:bg-[#332a17]",
};

export function DaemonPresenceEntry() {
  const t = useTranslations("agentPresence");
  const {
    status,
    onlineCount,
    connections,
    executionsByConnection,
    setModalOpen,
  } = useAgentPresence();
  // Optional pixel-activity bridge: present only inside a project context (where
  // the project-scoped pixel widget is mounted and has registered `available`).
  // On global pages the provider is absent (null) or `available` is false, so the
  // "View activity" affordance is omitted entirely — not merely disabled.
  const pixel = usePixelActivityOptional();

  const dotState = deriveDotState(status, onlineCount);

  // The trigger body. Error must NEVER read as "0 online" (no silent error);
  // loading is a muted placeholder with no count flash; idle and online show the
  // emphasized count glyph + a pluralized "agent(s) online" unit.
  let body: React.ReactNode;
  if (status === "error") {
    body = (
      <span className="truncate text-[12px] font-medium text-[#B45309] dark:text-[#E0A34E]">
        {t("unavailable")}
      </span>
    );
  } else if (status === "loading") {
    body = (
      <span className="truncate text-[12px] text-muted-foreground/70">
        {t("loading")}
      </span>
    );
  } else {
    const onlineTint =
      onlineCount > 0
        ? "text-[#15803D] dark:text-[#4FD07A]"
        : "text-foreground/80";
    body = (
      <span className="flex min-w-0 items-baseline gap-1.5 truncate text-[12px]">
        <span
          className={`text-[15px] font-semibold leading-none tabular-nums ${onlineTint}`}
        >
          {onlineCount}
        </span>
        <span className="truncate text-muted-foreground">
          {t("onlineUnit", { count: onlineCount })}
        </span>
      </span>
    );
  }

  // Online-only presence: filter to the ONLINE connection set FIRST, then group.
  // The roster lists only live (host, cwd) instances — an offline instance never
  // appears, and an agent with zero online instances produces no group at all.
  // `onlineConnectionsOnly` also applies the stable identity sort, so raw refresh
  // array order cannot make the roster jump.
  const onlineAgentGroups = groupConnectionsByAgent(
    onlineConnectionsOnly(connections, executionsByConnection),
    executionsByConnection,
  ).filter((g) => g.onlineCount > 0);

  return (
    <div className="fixed bottom-4 right-4 md:bottom-6 md:right-6 z-40">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            aria-label={t("pillAria")}
            className={`group relative h-auto gap-2 rounded-full border px-4 py-2.5 shadow-lg transition-all hover:shadow-xl ${TRIGGER_SKIN[dotState]}`}
          >
            {/* Leftmost: the status dot represents the WHOLE pill's online state
                (online green / idle grey / error amber). Then the chat glyph, then
                the count + unit. A single leading dot — no overlap with the icon. */}
            <PillDot state={dotState} />
            <MessagesSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
            {body}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={8}
          className="max-h-[70vh] w-[min(92vw,400px)] overflow-y-auto p-3"
        >
          <EntryPopoverInner
            groups={onlineAgentGroups}
            executionsByConnection={executionsByConnection}
            onOpenChat={() => setModalOpen(true)}
            extraActions={
              // "Open pixel workspace" — present ONLY inside a project context (the
              // pixel bridge exists AND has registered availability). Opens the
              // project-scoped pixel-canvas view via the shell↔project bridge.
              pixel?.available ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => pixel.setOpen(true)}
                  className="w-full justify-center gap-2 text-[12px] font-medium text-muted-foreground hover:text-foreground"
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                  {t("openPixelWorkspace")}
                </Button>
              ) : undefined
            }
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

// The popover body: a header, a PROMINENT "Open chat" primary action, the shared
// online roster, and an optional `extraActions` slot (the project-scoped pixel
// "View activity" affordance is injected here by the pixel bridge). Split out so
// the 1s tick (which drives running-row elapsed timers) only mounts while the
// popover is open (PopoverContent is unmounted while closed).
function EntryPopoverInner({
  groups,
  executionsByConnection,
  onOpenChat,
  extraActions,
}: {
  groups: ReturnType<typeof groupConnectionsByAgent>;
  executionsByConnection: Record<string, ExecutionView[]>;
  onOpenChat: () => void;
  extraActions?: React.ReactNode;
}) {
  const t = useTranslations("agentPresence");
  const nowMs = useNowTick();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("popoverTitle")}
        </span>
      </div>
      {/* Prominent one-click action: opens the daemon chat modal directly,
          collapsing the old "View all" intermediate step. */}
      <Button
        size="sm"
        onClick={onOpenChat}
        className="w-full justify-center gap-2 text-[12px] font-medium"
      >
        <MessagesSquare className="h-3.5 w-3.5" />
        {t("openChat")}
      </Button>
      <PresenceRosterBody
        groups={groups}
        executionsByConnection={executionsByConnection}
        nowMs={nowMs}
      />
      {extraActions}
    </div>
  );
}
