"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Bot } from "lucide-react";

import { AgentAvatar } from "@/components/ui/agent-avatar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AgentPermissionPicker,
  type AgentPermissionPickerChange,
} from "@/components/AgentPermissionPicker";
import { ROLE_PRESETS, type PresetKey } from "@/lib/authz/presets";
import type { Permission } from "@/lib/authz/types";

export type AgentFormPreset = PresetKey | "custom";

export interface AgentFormFieldsProps {
  name: string;
  onNameChange: (next: string) => void;

  preset: AgentFormPreset;
  permissions: Permission[];
  onPermissionsChange: (next: AgentPermissionPickerChange) => void;

  persona: string;
  onPersonaChange: (next: string) => void;

  nameInputId?: string;
  personaInputId?: string;
  readOnly?: boolean;
}

export function AgentFormFields({
  name,
  onNameChange,
  preset,
  permissions,
  onPermissionsChange,
  persona,
  onPersonaChange,
  nameInputId = "agent-form-name",
  personaInputId = "agent-form-persona",
  readOnly = false,
}: AgentFormFieldsProps) {
  const t = useTranslations();

  // The picker is displayed against the full effective permission set: for a
  // preset, show its built-in set; for custom mode, whatever is stored.
  const pickerPermissions: Permission[] = useMemo(() => {
    if (preset === "custom") return permissions;
    return [...ROLE_PRESETS[preset]];
  }, [preset, permissions]);

  return (
    <div className="space-y-5">
      {/* Live avatar preview — a deterministic DiceBear avatar seeded by the
          typed name, updating as the user types (no reroll / options). Shared by
          the create and edit flows. While the name is empty there is no identity
          to seed, so a neutral Bot tile stands in. */}
      <div className="flex flex-col items-center gap-2">
        {name.trim() ? (
          <AgentAvatar name={name} size={56} className="rounded-2xl" />
        ) : (
          <div
            aria-hidden
            className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground"
          >
            <Bot className="size-7" />
          </div>
        )}
        <span className="text-xs text-muted-foreground">
          {t("settings.agentAvatarPreview")}
        </span>
      </div>

      <div className="space-y-2">
        <Label htmlFor={nameInputId} className="text-[13px]">
          {t("settings.name")}
        </Label>
        <Input
          id={nameInputId}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t("settings.namePlaceholder")}
          className="border-border"
          required
          disabled={readOnly}
        />
      </div>

      <AgentPermissionPicker
        preset={preset}
        permissions={pickerPermissions}
        onChange={onPermissionsChange}
        readOnly={readOnly}
      />

      <div className="space-y-2">
        <Label htmlFor={personaInputId} className="text-[13px]">
          {t("settings.agentPersona")}
        </Label>
        <Textarea
          id={personaInputId}
          value={persona}
          onChange={(e) => onPersonaChange(e.target.value)}
          placeholder={t("settings.personaPlaceholder")}
          rows={4}
          disabled={readOnly}
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.personaHint")}
        </p>
      </div>
    </div>
  );
}

export default AgentFormFields;
