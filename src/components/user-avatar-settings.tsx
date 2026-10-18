"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { useAuth } from "@/contexts/auth-context";
import { authFetch } from "@/lib/auth-client";
import { UserAvatar } from "@/components/ui/user-avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const savedAvatarSchema = z.object({
  success: z.literal(true),
  data: z.object({ user: z.object({ uuid: z.uuid(), avatarSeed: z.uuid() }) }),
});

export function UserAvatarSettings() {
  const auth = useAuth();
  return <AvatarEditor key={auth.user?.uuid ?? "loading"} auth={auth} />;
}

function AvatarEditor({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const translate = useTranslations("settings.avatar");
  const [draftSeed, setDraftSeed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "failed" | null>(null);
  const pending = useRef(false);
  const savedSeed = auth.user?.avatarSeed;
  const dirty = draftSeed !== null && draftSeed !== savedSeed;
  const disabled = auth.loading || !auth.user || saving;

  function randomize() {
    if (disabled || pending.current) return;
    setDraftSeed(crypto.randomUUID());
    setFeedback(null);
  }

  function cancel() {
    if (disabled || pending.current) return;
    setDraftSeed(null);
    setFeedback(null);
  }

  async function save() {
    if (disabled || pending.current || !dirty || !draftSeed || !auth.user) return;
    pending.current = true;
    setSaving(true);
    setFeedback(null);
    try {
      const response = await authFetch("/api/users/me/avatar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarSeed: draftSeed }),
      });
      if (!response.ok) throw new Error("Avatar save failed");
      const result = savedAvatarSchema.parse(await response.json());
      if (result.data.user.uuid !== auth.user.uuid) throw new Error("Unexpected user");
      auth.applySavedAvatar(result.data.user.uuid, result.data.user.avatarSeed);
      setDraftSeed(null);
      setFeedback("saved");
    } catch {
      setFeedback("failed");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <Card className="mb-8" aria-busy={auth.loading || saving}>
      <CardHeader>
        <CardTitle>{translate("title")}</CardTitle>
        <CardDescription>{translate("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-4">
          <UserAvatar
            userUuid={auth.user?.uuid}
            name={auth.user?.name}
            avatarSeed={draftSeed ?? savedSeed}
            size={80}
            aria-label={translate("preview")}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={disabled} onClick={randomize}>{translate("randomize")}</Button>
            <Button type="button" disabled={disabled || !dirty} onClick={save}>{translate(saving ? "saving" : "save")}</Button>
            <Button type="button" variant="ghost" disabled={disabled || !dirty} onClick={cancel}>{translate("cancel")}</Button>
          </div>
        </div>
        <p role="status" aria-live="polite" className={feedback === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {auth.loading ? translate("loading") : feedback ? translate(feedback) : dirty ? translate("unsaved") : translate("hint")}
        </p>
        <p className="text-xs text-muted-foreground">
          {translate.rich("attribution", {
            author: (text) => <a className="underline underline-offset-2" href="https://draftbit.com/" target="_blank" rel="noopener noreferrer">{text}</a>,
            source: (text) => <a className="underline underline-offset-2" href="https://www.dicebear.com/styles/personas/" target="_blank" rel="noopener noreferrer">{text}</a>,
            license: (text) => <a className="underline underline-offset-2" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">{text}</a>,
          })}
        </p>
      </CardContent>
    </Card>
  );
}
