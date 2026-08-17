"use client";

// MentionBadge — the interactive rendering of an AGENT @mention in the comment
// area (子2 of the comment-mention-badges feature). It turns the dead mention
// text into a live control:
//   - a <Badge> with the agent name + an online dot (StatusDot, the shared
//     presence-dot vocabulary). Online state is the Task-1 liveness verdict
//     (instance-precise for a pinned mention, agent-overall for a non-pinned one).
//   - clicking opens a portaled Radix <Popover> with a minimal identity set
//     (name + online status), plus cwd + host for a PINNED mention (omitted for a
//     non-pinned one, which identifies no single instance — q9).
//   - an OWNER-ONLY, ONLINE-ONLY "Open conversation" <Button> inside the popover
//     (q4/q5/q8): shown ONLY when the current user owns the agent AND the relevant
//     target is online; HIDDEN (never disabled) otherwise. Activating it calls the
//     additive `openChatForAgent(agentUuid, pin?)` presence action, which opens the
//     daemon chat focused on the pinned instance (pinned) or the agent (non-pinned).
//
// The badge + popover identity are visible to EVERYONE (owner or not — q5 option
// a); only the "Open conversation" action is owner/online-gated.
//
// It reads presence/liveness/owner via hooks (useMentionLiveness over
// useAgentPresence) and the current user via useAuth — no liveness/owner props are
// threaded in, matching the Tech Design's "Module Contracts".

import { useTranslations } from "next-intl";
import { MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { StatusDot } from "@/components/agent-presence/status";
import { useAgentPresence } from "@/contexts/agent-presence-context";
import { useAuth } from "@/contexts/auth-context";
import { useMentionLiveness } from "@/lib/use-mention-liveness";
import {
  formatCwd,
  formatHost,
} from "@/lib/daemon-instance-format";
import type { ParsedMentionRef } from "@/components/mention-renderer";

export interface MentionBadgeProps {
  /**
   * The parsed AGENT mention reference (user mentions are not badge-ified). The
   * optional `pinnedHost`/`pinnedCwd` decide pinned (instance-precise) vs
   * non-pinned (agent-overall) liveness + popover fields.
   */
  mention: ParsedMentionRef;
  /** The resolved display name shown on the badge + popover. */
  displayName: string;
}

export function MentionBadge({ mention, displayName }: MentionBadgeProps) {
  const t = useTranslations("mention");
  const tPresence = useTranslations("agentPresence");
  const { openChatForAgent } = useAgentPresence();
  const { user } = useAuth();

  // Liveness verdict from the Task-1 rule: pinned → instance-precise; non-pinned →
  // agent-overall. Also yields the matched instance's owner/host/cwd. Pass only the
  // fields the rule needs (uuid + pin), preserving the "pinned iff a pin key is
  // present" contract — a pinned ref still carries the keys (even when null), an
  // un-pinned one omits them.
  const liveness = useMentionLiveness(
    mention.pinnedHost !== undefined || mention.pinnedCwd !== undefined
      ? {
          uuid: mention.uuid,
          pinnedHost: mention.pinnedHost,
          pinnedCwd: mention.pinnedCwd,
        }
      : { uuid: mention.uuid },
  );

  const { pinned, online, ownerUuid, host, cwd } = liveness;

  // The owner-only, online-only "Open conversation" gate (mirrors the server owner
  // rule: agent.ownerUuid === current user). Hidden — not disabled — when either
  // condition fails (q4/q5/q8). When offline there is no live row, so ownerUuid may
  // be null; the online check alone already hides it then, but we gate on both so a
  // non-owner with an online agent never sees it either.
  const isOwner = user?.uuid != null && user.uuid === ownerUuid;
  const showOpenConversation = isOwner && online;

  const statusLabel = online ? t("online") : t("offline");

  // Pinned identity fields, formatted via the shared truncation helpers. An
  // "unknown" value resolves to an i18n KEY the caller localizes (per the helper
  // contract), so we never leak raw English.
  const cwdFmt = pinned ? formatCwd(cwd) : null;
  const hostFmt = pinned ? formatHost(host ?? "") : null;

  const handleOpenConversation = () => {
    openChatForAgent(
      mention.uuid,
      pinned ? { host: host ?? "", cwd: cwd ?? null } : undefined,
    );
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge
          variant="secondary"
          // A real button role for the trigger so keyboard users can open the
          // popover; the inline-flex badge keeps the name + dot on one line.
          className="cursor-pointer gap-1 align-baseline"
          aria-label={t("badgeAria", { name: displayName, status: statusLabel })}
        >
          <StatusDot online={online} />
          <span>@{displayName}</span>
        </Badge>
      </PopoverTrigger>
      {/* Portaled by default (src/components/ui/popover.tsx) so it escapes the
          scrollable comment list's overflow. */}
      <PopoverContent className="w-64" align="start">
        <div className="flex flex-col gap-3">
          {/* Identity header: avatar + name + online status. Visible to everyone (q5). */}
          <div className="flex items-center gap-2">
            <AgentAvatar name={displayName} size="sm" className="rounded-full" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-foreground">
                {displayName}
              </p>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <StatusDot online={online} />
                {statusLabel}
              </p>
            </div>
          </div>

          {/* Pinned mention → the instance's working directory + host. A non-pinned
              mention identifies no single instance, so these are omitted (q9). */}
          {pinned && cwdFmt && hostFmt && (
            <dl className="flex flex-col gap-1.5 text-xs">
              <div className="flex flex-col gap-0.5">
                <dt className="text-muted-foreground">
                  {t("workingDirectory")}
                </dt>
                <dd
                  className="truncate font-mono text-foreground"
                  title={
                    cwdFmt.isUnknown ? tPresence("unknownPath") : cwdFmt.title
                  }
                >
                  {cwdFmt.isUnknown
                    ? tPresence("unknownPath")
                    : cwdFmt.label}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-muted-foreground">{t("host")}</dt>
                <dd
                  className="truncate font-mono text-foreground"
                  title={
                    hostFmt.isUnknown ? tPresence("unknownHost") : hostFmt.title
                  }
                >
                  {hostFmt.isUnknown
                    ? tPresence("unknownHost")
                    : hostFmt.label}
                </dd>
              </div>
            </dl>
          )}

          {/* Owner-only, online-only action. Hidden (not disabled) otherwise. */}
          {showOpenConversation && (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={handleOpenConversation}
            >
              <MessageSquare />
              {t("openConversation")}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
