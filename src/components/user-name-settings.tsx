"use client";

import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { useAuth } from "@/contexts/auth-context";
import { authFetch } from "@/lib/auth-client";
import { DISPLAY_NAME_MAX_LENGTH, displayNameLength, displayNameSchema } from "@/lib/display-name";
import { isImeComposing } from "@/lib/ime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const savedNameSchema = z.object({
  success: z.literal(true),
  data: z.object({ user: z.object({ uuid: z.uuid(), name: displayNameSchema }) }),
});

export function UserNameSettings() {
  const auth = useAuth();
  return <NameEditor key={auth.user?.uuid ?? "loading"} auth={auth} />;
}

function NameEditor({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const translate = useTranslations("settings.displayName");
  const inputId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<"saved" | "failed" | null>(null);
  const pending = useRef(false);
  const value = draft ?? auth.user?.name ?? "";
  const parsed = displayNameSchema.safeParse(value);
  const disabled = auth.loading || !auth.user || saving;
  const invalid = !auth.loading && Boolean(auth.user) && !parsed.success;
  const canSave = !disabled && draft !== null && parsed.success;

  async function save() {
    if (!canSave || pending.current || !parsed.success || !auth.user) return;
    pending.current = true;
    setSaving(true);
    setFeedback(null);
    try {
      const response = await authFetch("/api/users/me/name", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: parsed.data }),
      });
      if (!response.ok) throw new Error("Name save failed");
      const result = savedNameSchema.parse(await response.json());
      if (result.data.user.uuid !== auth.user.uuid || result.data.user.name !== parsed.data) {
        throw new Error("Unexpected saved name");
      }
      auth.applySavedName(result.data.user.uuid, result.data.user.name);
      setDraft(null);
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
        <div className="max-w-md space-y-2">
          <Label htmlFor={inputId}>{translate("label")}</Label>
          <Input
            id={inputId}
            value={value}
            disabled={disabled}
            autoComplete="nickname"
            aria-invalid={invalid}
            aria-describedby={`${inputId}-hint ${inputId}-count${invalid ? ` ${inputId}-error` : ""}`}
            onChange={event => { setDraft(event.target.value); setFeedback(null); }}
            onKeyDown={event => {
              if (event.key !== "Enter" || isImeComposing(event)) return;
              event.preventDefault();
              void save();
            }}
          />
          <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">{translate("hint")}</p>
          <p id={`${inputId}-count`} className="text-xs text-muted-foreground" aria-live="polite">
            {translate("count", { count: displayNameLength(value), max: DISPLAY_NAME_MAX_LENGTH })}
          </p>
          {invalid && <p id={`${inputId}-error`} className="text-sm text-destructive">{translate("invalid", { max: DISPLAY_NAME_MAX_LENGTH })}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!canSave} onClick={save}>{translate(saving ? "saving" : "save")}</Button>
          <Button type="button" variant="ghost" disabled={disabled || draft === null} onClick={() => { setDraft(null); setFeedback(null); }}>{translate("cancel")}</Button>
        </div>
        <p role="status" aria-live="polite" className={feedback === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {auth.loading ? translate("loading") : feedback ? translate(feedback) : draft !== null ? translate("unsaved") : null}
        </p>
      </CardContent>
    </Card>
  );
}
