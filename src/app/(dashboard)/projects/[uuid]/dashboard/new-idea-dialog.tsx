"use client";

// New-idea dialog — static form by default, plus (add-conversational-idea-entry)
// an explicit switch into a CONVERSATIONAL mode when an online daemon exists:
// instead of filling the form, the user describes the idea to a chosen agent
// instance; the woken agent creates the idea itself (pure conversational,
// elaboration q2=a — the frontend never POSTs /ideas in that mode) and the UI
// hands off to the daemon chat focused on the new session.
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isImeComposing } from "@/lib/ime";
import { useAgentPresenceOptional } from "@/contexts/agent-presence-context";
import { ConversationalEntry, DaemonConnectCta } from "@/components/agent-presence";
import { buildIdeaInstruction } from "./build-idea-instruction";

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
  /** Project display name, threaded into the conversational instruction
   *  template (display sugar — the template degrades to uuid-only without it). */
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
  projectName,
}: NewIdeaDialogProps) {
  const t = useTranslations("ideaTracker");
  const tLineage = useTranslations("ideaTracker.lineage");
  const isDerive = !!parentUuid;
  const tCommon = useTranslations("common");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        }),
      });
      const json = await res.json();
      if (json.success && json.data?.uuid) {
        setTitle("");
        setContent("");
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
            <span className="ml-1 text-xs font-normal text-[#9A9A9A]">
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
          className="bg-[#C67A52] hover:bg-[#B56A42] text-white"
        >
          {isSubmitting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          {tCommon("create")}
        </Button>
      </DialogFooter>
    </>
  );

  // Conversational pane: the reusable entry with the create-idea template. On a
  // successful dispatch: close this dialog and land the user in the daemon chat
  // on the new session. `onCreated` is deliberately NOT called — no Idea entity
  // exists at dispatch time (the woken agent creates it).
  const conversationPane = (
    <div className="py-2">
      <ConversationalEntry
        buildInstruction={(userText) =>
          buildIdeaInstruction(projectUuid, projectName, userText)
        }
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
            <p className="text-[13px] text-[#6B6B6B]">
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
              <div className="rounded-xl border border-[#EFEBE4] bg-[#FCFBF8] px-3 py-2">
                <p className="px-1 pt-1 text-[12px] font-medium text-[#6B6B6B]">
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
