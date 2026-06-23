"use client";

// Shared instance picker — a path-first selectable list of an agent's ONLINE
// (host, cwd) daemon instances.
//
// A daemon instance is identified by `(agentUuid, clientType, host, cwd)` (see
// DaemonConnection). This component renders one selectable row per instance,
// path-first (cwd primary via formatCwd) and host-conditional (host shown as a
// per-row suffix only when the agent spans 2+ distinct hosts, per the spec's
// "host-conditional" rule). It is consumed by:
//   - the @mention secondary picker (live wake target),
//   - the task-assignment cwd pin,
//   - the ad-hoc send picker (live send).
//
// ONLINE-ONLY: every consumer filters its candidate list to online instances
// BEFORE handing it here, so the picker never sees an offline (host, cwd) place.
// An offline instance is not a valid target on any surface — a fully-offline
// agent simply receives a plain notification (no pin, no wake), so its caller
// shows NO picker at all. Consequently every row this component renders is
// selectable; there is no disabled state and no "will queue" affordance.
//
// A SINGLE instance auto-selects (no extra click) via an effect — the common
// single-daemon case needs no interaction.
//
// Presentational + prop-driven: it never fetches the instance list itself. The
// caller passes the online instances (each {connectionUuid, host, cwd,
// effectiveStatus}) and owns the selected connectionUuid.

import { useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Folder } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import {
  formatCwd,
  formatHost,
  type FormatCwdOptions,
  type FormatHostOptions,
} from "@/lib/daemon-instance-format";
import { StatusDot } from "./status";

/**
 * One selectable daemon instance. A structural subset of `ConnectionView`
 * (daemon-connection.service) carrying exactly the fields the picker renders, so
 * every consumer (mention / assign / send) maps its data to this shape.
 */
export interface InstanceCandidate {
  /** The current live `DaemonConnection.uuid` for this (host, cwd) place. */
  connectionUuid: string;
  /** Host the instance runs on. "" denotes an unknown/host-less self-report. */
  host: string;
  /** Working directory. null for a legacy daemon that never self-reported one. */
  cwd: string | null;
  /**
   * Server-derived liveness verdict. The picker only ever renders online
   * instances (callers filter beforehand); this field is retained so the
   * candidate shape stays a structural subset of `ConnectionView` and the
   * status dot can render verbatim.
   */
  effectiveStatus: "online" | "offline";
}

export interface InstancePickerProps {
  /** The agent's ONLINE instances to choose from (callers filter offline out). */
  instances: InstanceCandidate[];
  /**
   * The currently selected instance's connectionUuid, or null when none picked.
   * Controlled: the caller owns selection state.
   */
  selectedConnectionUuid: string | null;
  /**
   * Selection callback. Receives the full candidate (so the caller can read the
   * durable (host, cwd) place, not just the ephemeral connectionUuid).
   */
  onSelect: (instance: InstanceCandidate) => void;
  /** Optional className on the root list. */
  className?: string;
  /** Forwarded to formatCwd for callers with a tighter/looser path budget. */
  cwdFormatOptions?: FormatCwdOptions;
  /** Forwarded to formatHost for callers with a tighter/looser host budget. */
  hostFormatOptions?: FormatHostOptions;
  /** Accessible label for the radio group (defaults to the localized title). */
  ariaLabel?: string;
}

/**
 * Monospace path chip — a folder glyph + the path-first cwd label. The full
 * absolute path (or the localized "unknown path" for a legacy null-cwd) is
 * exposed on hover via the title. Matches design.pen "Path Chip".
 */
function PathChip({
  cwd,
  formatOptions,
}: {
  cwd: string | null;
  formatOptions?: FormatCwdOptions;
}) {
  const t = useTranslations();
  const formatted = formatCwd(cwd, formatOptions);
  // isUnknown → label/title are i18n KEYS; resolve via t(). Otherwise the helper
  // already returned the (possibly truncated) literal path / full path title.
  const label = formatted.isUnknown ? t(formatted.label) : formatted.label;
  const title = formatted.isUnknown ? t(formatted.title) : formatted.title;
  return (
    <span
      title={title}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-md border border-[#E5E0D8] bg-[#FAF8F4] px-2 py-0.5",
        "font-mono text-xs",
        formatted.isUnknown ? "text-[#9A9A9A] italic" : "text-[#2C2C2C]",
      )}
    >
      <Folder className="size-3 shrink-0 text-[#9A9A9A]" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * De-emphasized host suffix — a dimmed monospace host, right-truncated and
 * width-capped (formatHost). Rendered only when the agent spans 2+ hosts (the
 * caller passes `show`). The full host is on hover via title.
 */
function HostSuffix({
  host,
  formatOptions,
}: {
  host: string;
  formatOptions?: FormatHostOptions;
}) {
  const t = useTranslations();
  const formatted = formatHost(host, formatOptions);
  const label = formatted.isUnknown ? t(formatted.label) : formatted.label;
  const title = formatted.isUnknown ? t(formatted.title) : formatted.title;
  return (
    <span
      title={title}
      className="shrink-0 truncate font-mono text-[10px] text-[#9A9A9A]"
    >
      {label}
    </span>
  );
}

/**
 * Path-first, host-conditional selectable list of an agent's ONLINE (host, cwd)
 * instances. See module header for the online-only contract.
 */
export function InstancePicker({
  instances,
  selectedConnectionUuid,
  onSelect,
  className,
  cwdFormatOptions,
  hostFormatOptions,
  ariaLabel,
}: InstancePickerProps) {
  const t = useTranslations("mentionInstance");

  // Host-conditional rule: only surface a per-row host suffix when the agent's
  // instances span 2+ DISTINCT hosts (otherwise the host is redundant noise and
  // is shown once at the header by the caller). Memoized over the host set.
  const isMultiHost = useMemo(() => {
    const hosts = new Set(instances.map((i) => i.host));
    return hosts.size > 1;
  }, [instances]);

  // Single-instance auto-select: when exactly one (online) instance exists, pick
  // it with no extra click. Guarded so it never re-fires once it is already the
  // selection.
  const soleInstance = instances.length === 1 ? instances[0] : null;
  useEffect(() => {
    if (soleInstance && selectedConnectionUuid !== soleInstance.connectionUuid) {
      onSelect(soleInstance);
    }
    // onSelect is treated as stable per the controlled-component contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soleInstance, selectedConnectionUuid]);

  if (instances.length === 0) {
    return (
      <div className={cn("py-2 text-xs text-[#9A9A9A]", className)}>
        {t("noInstances")}
      </div>
    );
  }

  return (
    <RadioGroup
      aria-label={ariaLabel ?? t("title")}
      value={selectedConnectionUuid ?? undefined}
      onValueChange={(value) => {
        const next = instances.find((i) => i.connectionUuid === value);
        if (next) onSelect(next);
      }}
      className={cn("gap-1.5", className)}
    >
      {instances.map((instance) => {
        const radioId = `instance-${instance.connectionUuid}`;
        return (
          <label
            key={instance.connectionUuid}
            htmlFor={radioId}
            className={cn(
              "flex items-center gap-2.5 rounded-md border px-2.5 py-2 transition-colors",
              "cursor-pointer border-[#E5E0D8] hover:bg-[#FAF8F4]",
              selectedConnectionUuid === instance.connectionUuid &&
                "border-[#C67A52] bg-[#FAF8F4]",
            )}
          >
            {/* Status dot — pinned to the row edge, never shrinks. Always online
                (the picker only renders online instances). */}
            <span className="flex shrink-0 items-center" aria-hidden>
              <StatusDot online />
            </span>

            {/* Path-first identity. Path keeps shrink priority; host follows. */}
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <PathChip cwd={instance.cwd} formatOptions={cwdFormatOptions} />
              {isMultiHost && (
                <HostSuffix
                  host={instance.host}
                  formatOptions={hostFormatOptions}
                />
              )}
            </span>

            {/* Selection control — pinned to the row edge, never shrinks. */}
            <RadioGroupItem
              id={radioId}
              value={instance.connectionUuid}
              className="shrink-0"
            />
          </label>
        );
      })}
    </RadioGroup>
  );
}
