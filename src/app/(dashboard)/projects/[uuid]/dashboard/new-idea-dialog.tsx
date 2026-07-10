"use client";

// New-idea dialog — static form by default, plus (add-conversational-idea-entry)
// an explicit switch into a CONVERSATIONAL mode when an online daemon exists:
// instead of filling the form, the user describes the idea to a chosen agent
// instance. The dispatch (add-conversational-idea-root-session) POSTs
// /api/ideas/conversational, which PRE-CREATES the Idea (createdBy = this user,
// placeholder title, instance-assigned, elaborating) and its root daemon session
// anchored to the idea from birth (sessionId = directIdeaUuid = ideaUuid) — the
// server composes the wake instruction (the template needs the ideaUuid, which
// only the server knows pre-creation). The UI hands off to the daemon chat
// focused on the new idea-anchored session.
//
// Mode rules (elaboration q3=b + q6=b):
//   - "form" is ALWAYS the default; the switch is an explicit tab.
//   - The conversational tab is enabled only when ≥1 online daemon connection is
//     visible via the presence spine; offline it stays VISIBLE but disabled, and
//     the pane behind it shows the startup guidance (ConversationalEntry's
//     built-in DaemonConnectCta fallback) — never hidden, never silent.
//   - Derive-child mode (parentUuid set) is form-only: the template contract
//     does not cover lineage, so the tabs are not rendered at all.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isImeComposing } from "@/lib/ime";
import { authFetch } from "@/lib/auth-client";
import { useAgentPresenceOptional } from "@/contexts/agent-presence-context";
import {
  ConversationalEntry,
  ConversationalDispatchError,
  DaemonConnectCta,
} from "@/components/agent-presence";
import type { SessionView } from "@/services/daemon-session.service";

interface NewIdeaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectUuid: string;
  onCreated?: (uuid: string) => void;
  /** When set, the new idea is derived as a child of this idea (single-parent
   *  lineage). Switches the dialog copy to "derive" wording. */
  parentUuid?: string | null;
  /** Display title of the parent, shown in the derive subtitle for context. */
  parentTitle?: string;
  /** Project display name. No longer threaded into the dispatch (the server
   *  resolves the project name itself for the instruction template); kept in
   *  the props contract for existing call sites. */
  projectName?: string;
}

type EntryMode = "form" | "conversation";

export function NewIdeaDialog({
  open,
  onOpenChange,
  projectUuid,
  onCreated,
  parentUuid,
  parentTitle,
  // `projectName` intentionally not destructured — the server resolves the
  // project name itself for the conversational instruction template.
}: NewIdeaDialogProps) {
  const t = useTranslations("ideaTracker");
  const tLineage = useTranslations("ideaTracker.lineage");
  const isDerive = !!parentUuid;
  const tCommon = useTranslations("common");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [isContainer, setIsContainer] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Conversational container-decompose intent (add-container-idea-ui Block 3): when
  // checked, the dispatch flags the pre-created idea as a container and asks the woken
  // agent to propose child ideas as an elaboration round. Rides the existing
  // conversational wake — no new action type.
  const [decompose, setDecompose] = useState(false);

  // Conversational mode plumbing. The presence spine is optional so the dialog
  // stays mountable outside the dashboard shell (treated as "no daemon online").
  const presence = useAgentPresenceOptional();
  const daemonOnline = (presence?.connections ?? []).some(
    (c) => c.effectiveStatus === "online",
  );
  const [mode, setMode] = useState<EntryMode>("form");
  // Derive-child is form-only; and if every daemon drops offline mid-dialog the
  // conversational pane degrades to its startup guidance (the tab itself only
  // gates NEW switches — an active pane is never yanked out from under the user).
  const showTabs = !isDerive;
  const effectiveMode: EntryMode = isDerive ? "form" : mode;

  const handleSubmit = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${projectUuid}/ideas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: trimmedTitle,
          content: content.trim() || undefined,
          ...(parentUuid ? { parentUuid } : {}),
          ...(isContainer ? { isContainer: true } : {}),
        }),
      });
      const json = await res.json();
      if (json.success && json.data?.uuid) {
        setTitle("");
        setContent("");
        setIsContainer(false);
        onOpenChange(false);
        onCreated?.(json.data.uuid);
      } else {
        setError(json.error || t("error.createFailed"));
      }
    } catch {
      setError(t("error.createFailed"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const formPane = (
    <>
      <div className="space-y-4 py-2">
        <div className="space-y-2">
          <Label htmlFor="idea-title">{t("newIdea.ideaTitle")}</Label>
          <Input
            id="idea-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("newIdea.titlePlaceholder")}
            autoFocus
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === "Enter" && !e.shiftKey && title.trim()) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="idea-content">
            {t("newIdea.description")}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              ({tCommon("optional")})
            </span>
          </Label>
          <Textarea
            id="idea-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t("newIdea.descriptionPlaceholder")}
            rows={4}
            className="resize-none"
          />
        </div>

        {/* Container toggle — a checked box makes a bare container in one step;
            content stays optional, only the title is required. */}
        <div className="flex items-start gap-2">
          <Checkbox
            id="idea-is-container"
            checked={isContainer}
            onCheckedChange={(checked) => setIsContainer(checked === true)}
            className="mt-0.5"
          />
          <div className="grid gap-1 leading-none">
            <Label htmlFor="idea-is-container" className="cursor-pointer">
              {tLineage("makeContainer")}
            </Label>
            <p className="text-xs font-normal text-muted-foreground">
              {tLineage("containerHint")}
            </p>
          </div>
        </div>

        {error && (
          <div className="rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {error}
          </div>
        )}
      </div>

      <DialogFooter>
        <Button
          variant="outline"
          onClick={() => onOpenChange(false)}
          disabled={isSubmitting}
        >
          {tCommon("cancel")}
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={isSubmitting || !title.trim()}
          className="bg-primary hover:bg-[#B56A42] text-white"
        >
          {isSubmitting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          {tCommon("create")}
        </Button>
      </DialogFooter>
    </>
  );

  // Conversational pane: the reusable entry with a consumer-owned dispatch that
  // POSTs the RAW description to /api/ideas/conversational — the server
  // pre-creates the Idea and composes the instruction (no client template). On
  // success: close this dialog and land the user in the daemon chat on the new
  // idea-anchored session (it already carries directIdeaUuid, so the chat list
  // presents it as the idea's conversation). `onCreated` is deliberately NOT
  // called — the idea list refreshes via the SSE change event, and calling it
  // would navigate away from the chat handoff.
  const conversationalDispatch = async (args: {
    agentUuid: string;
    connectionUuid: string;
    userText: string;
  }): Promise<SessionView> => {
    const res = await authFetch("/api/ideas/conversational", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUuid,
        agentUuid: args.agentUuid,
        connectionUuid: args.connectionUuid,
        descriptionText: args.userText,
        ...(decompose ? { decompose: true } : {}),
      }),
    });
    if (!res.ok) {
      // Surface the server reason through the component's status-aware error
      // mapping (409 → retryable offline copy + connection re-poll).
      let serverMessage: string | null = null;
      try {
        const json = await res.json();
        if (typeof json?.error === "string" && json.error) {
          serverMessage = json.error;
        }
      } catch {
        // Non-JSON error body — fall back to the component's generic copy.
      }
      throw new ConversationalDispatchError(res.status, serverMessage);
    }
    let session: SessionView | null = null;
    try {
      const json = await res.json();
      if (json?.success && json.data?.session) {
        session = json.data.session as SessionView;
      }
    } catch {
      // Non-JSON success body — treated as a failed dispatch below.
    }
    if (!session) {
      throw new ConversationalDispatchError(res.status, null);
    }
    return session;
  };

  const conversationPane = (
    <div className="space-y-3 py-2">
      {/* Decompose intent — ask the agent to break the described work into child
          ideas under a new container, proposed as an elaboration round to confirm.
          Only meaningful in conversational mode (needs an online daemon). */}
      <div className="flex items-start gap-2">
        <Checkbox
          id="idea-decompose"
          checked={decompose}
          onCheckedChange={(checked) => setDecompose(checked === true)}
          className="mt-0.5"
        />
        <div className="grid gap-1 leading-none">
          <Label htmlFor="idea-decompose" className="cursor-pointer">
            {t("newIdea.decompose")}
          </Label>
          <p className="text-xs font-normal text-muted-foreground">
            {t("newIdea.decomposeHint")}
          </p>
        </div>
      </div>
      <ConversationalEntry
        dispatch={conversationalDispatch}
        onStarted={(session) => {
          onOpenChange(false);
          presence?.openChatForSession(session);
        }}
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{isDerive ? tLineage("deriveIdea") : t("newIdea.title")}</DialogTitle>
          {isDerive && parentTitle && (
            <p className="text-[13px] text-muted-foreground">
              {tLineage("derivedFrom")} · {parentTitle}
            </p>
          )}
        </DialogHeader>

        {showTabs && (
          <>
            <Tabs
              value={effectiveMode}
              onValueChange={(v) => setMode(v as EntryMode)}
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="form">{t("newIdea.modeForm")}</TabsTrigger>
                {/* Visible-but-disabled when no daemon is online (q6=b) — the
                    affordance advertises the conversational path; the hint
                    below explains why and how to enable it. */}
                <TabsTrigger value="conversation" disabled={!daemonOnline}>
                  {t("newIdea.modeConversation")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {/* The disabled switch is never silent: the startup guidance (with
                the copyable command from the shared constant) renders inline,
                collapsible-free — exactly the shared CTA the other daemon
                empty states show. */}
            {!daemonOnline && (
              <div className="rounded-xl border border-[#EFEBE4] dark:border-[#2a2a2e] bg-[#FCFBF8] dark:bg-[#1e1d1b] px-3 py-2">
                <p className="px-1 pt-1 text-[12px] font-medium text-muted-foreground">
                  {t("newIdea.modeConversationOfflineHint")}
                </p>
                <DaemonConnectCta variant="compact" />
              </div>
            )}
          </>
        )}

        {effectiveMode === "form" ? formPane : conversationPane}
      </DialogContent>
    </Dialog>
  );
}
