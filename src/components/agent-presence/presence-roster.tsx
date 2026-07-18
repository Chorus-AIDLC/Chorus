"use client";

// Shared presence roster — the online-agent drill-down body reused by the
// bottom-right daemon-presence entry (and any future presence surface).
//
// Extracted verbatim from the retired sidebar presence pill so the online-only
// filtering, per-agent default-collapsed expand state, deterministic ordering,
// running/queued execution rows (with the Interrupt control), interrupted-row
// exclusion, and the 0-online daemon-connect CTA all carry over unchanged — the
// entry reuses this piece rather than rewriting the roster. Everything here is
// presentational + prop-driven; no piece fetches the connection/execution
// dataset itself (that is the shell-level AgentPresenceProvider's job).
//
// Imports come from the sibling module files (not the barrel index) so this file
// can itself be re-exported from the index without a circular import.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ListChecks, Play } from "lucide-react";
import { StatusDot } from "./status";
import {
  AgentGroupHeader,
  InstanceRow,
  useInstanceActivity,
  type AgentInstanceGroup,
} from "./instance-group";
import { ExecutionRow, ExecutionSection } from "./execution-row";
import { DaemonConnectCta } from "./daemon-connect-cta";
import type { ConnectionView, ExecutionView } from "./types";

// The status dot rendered in the entry trigger. Four states:
//  - online (count > 0) → the shared pulsing-green StatusDot (halo gated behind
//    motion-safe so reduced-motion degrades to a static dot),
//  - idle (0 online) / loading → the shared flat grey StatusDot (offline form),
//  - error   → an amber/"unavailable" dot, never green and never a count.
// The online + idle branches REUSE the shared StatusDot so the pulse/grey
// vocabulary can never drift from the modal/page; only the amber error dot is
// entry-local (StatusDot has no error state).
export function PillDot({
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
  // online → pulsing green; idle + loading → flat grey.
  return (
    <span className="shrink-0">
      <StatusDot online={state === "online"} size="md" />
    </span>
  );
}

// Derive the single rendered presence state from (status, onlineCount). Loading
// and error are owned by the provider's poll lifecycle; idle vs online is purely
// the count once the poll has settled to "ok". Pure — unit-testable.
export function deriveDotState(
  status: "loading" | "ok" | "error",
  onlineCount: number,
): "loading" | "error" | "idle" | "online" {
  return status === "loading"
    ? "loading"
    : status === "error"
      ? "error"
      : onlineCount > 0
        ? "online"
        : "idle";
}

// One instance sub-row inside an agent group. The path-first `InstanceRow`
// (cwd + host-conditional suffix + tinted activity dot) is the drill-down
// identity; nested beneath it the instance's running/queued executions render
// as the SAME stacked `ExecutionRow`s. Interrupted rows are dropped here (the
// roster has no resume affordance — that is the modal's job). An ONLINE instance
// with no running/queued work shows the quiet idle line instead, never a blank gap.
function RosterInstanceRow({
  connection,
  executions,
  showHost,
  nowMs,
}: {
  connection: ConnectionView;
  executions: ExecutionView[];
  showHost: boolean;
  nowMs: number;
}) {
  const t = useTranslations("agentPresence");
  const ta = useTranslations("agentConnections");
  const { text, dot } = useInstanceActivity(connection, executions, nowMs);

  const running = executions.filter((e) => e.status === "running");
  const queued = executions.filter((e) => e.status === "queued");
  const hasActive = running.length > 0 || queued.length > 0;
  const online = connection.effectiveStatus === "online";

  return (
    <div className="flex flex-col gap-2.5">
      <InstanceRow
        connection={connection}
        showHost={showHost}
        activity={text}
        dot={dot}
      />
      {hasActive ? (
        <div className="flex flex-col gap-4 pl-1">
          {running.length > 0 && (
            <ExecutionSection
              icon={Play}
              label={ta("execRunning")}
              count={running.length}
            >
              {running.map((exec) => (
                <ExecutionRow
                  key={exec.uuid}
                  exec={exec}
                  nowMs={nowMs}
                  layout="stacked"
                />
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
                <ExecutionRow
                  key={exec.uuid}
                  exec={exec}
                  nowMs={nowMs}
                  layout="stacked"
                />
              ))}
            </ExecutionSection>
          )}
        </div>
      ) : (
        online && (
          <p className="pl-1 text-[12px] text-muted-foreground">{t("connectionIdle")}</p>
        )
      )}
    </div>
  );
}

// One agent group: a host-conditional COLLAPSIBLE header + (when expanded) one
// path-first sub-row per ONLINE instance. DEFAULT COLLAPSED — the roster is
// glanceable, so the per-cwd rows are opt-in noise revealed via the header toggle.
function RosterAgentGroup({
  group,
  executionsByConnection,
  nowMs,
  expanded,
  onToggle,
}: {
  group: AgentInstanceGroup;
  executionsByConnection: Record<string, ExecutionView[]>;
  nowMs: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <AgentGroupHeader group={group} expanded={expanded} onToggle={onToggle} />
      {expanded && (
        <div className="flex flex-col gap-3 pl-7">
          {group.connections.map((connection) => (
            <RosterInstanceRow
              key={connection.uuid}
              connection={connection}
              executions={executionsByConnection[connection.uuid] ?? []}
              showHost={group.multiHost}
              nowMs={nowMs}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// The roster body: one COLLAPSIBLE row per ONLINE agent (collapsed by default).
// Per-agent expand state lives here in a Set of expanded agentUuids so toggling
// one agent never re-fetches or re-mounts the others. A 0-online set shows the
// daemon-connect CTA (compact) — not a dead-end "nobody online" sentence — so the
// user knows HOW to bring an agent online; it disappears on its own once a daemon
// connects (this branch is then replaced by the live agent groups).
export function PresenceRosterBody({
  groups,
  executionsByConnection,
  nowMs,
}: {
  groups: AgentInstanceGroup[];
  executionsByConnection: Record<string, ExecutionView[]>;
  nowMs: number;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (agentUuid: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(agentUuid)) next.delete(agentUuid);
      else next.add(agentUuid);
      return next;
    });

  if (groups.length === 0) {
    return <DaemonConnectCta variant="compact" />;
  }

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <RosterAgentGroup
          key={group.agentUuid}
          group={group}
          executionsByConnection={executionsByConnection}
          nowMs={nowMs}
          expanded={expanded.has(group.agentUuid)}
          onToggle={() => toggle(group.agentUuid)}
        />
      ))}
    </div>
  );
}
