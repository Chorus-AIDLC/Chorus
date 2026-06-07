"use client";

import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

/**
 * Draft shape for a single acceptance criterion row in the editor.
 * Mirrors the minimum fields the UI needs to add / edit / persist a row.
 * Both the Task Draft panel (proposal stage) and the Task Detail panel
 * (post-materialize) consume this same shape.
 */
export interface AcceptanceCriteriaItemDraft {
  description: string;
  required: boolean;
}

interface AcceptanceCriteriaEditorProps {
  items: AcceptanceCriteriaItemDraft[];
  onChange: (items: AcceptanceCriteriaItemDraft[]) => void;
  disabled?: boolean;
}

/**
 * Controlled editor for a list of acceptance criteria.
 *
 * Renders one row per item: a description Input, a `required` Switch with
 * required/optional label, and a delete button. A bottom "Add Criterion"
 * button appends a fresh row with `{ description: "", required: true }`.
 *
 * Owns no persistence and no validation: callers supply `items` and
 * `onChange`, and decide when/how to save (e.g. filter empty rows on save,
 * call change-detection via `acCriteriaChanged`).
 */
export function AcceptanceCriteriaEditor({
  items,
  onChange,
  disabled,
}: AcceptanceCriteriaEditorProps) {
  const t = useTranslations();

  const updateAt = (index: number, patch: Partial<AcceptanceCriteriaItemDraft>) => {
    const next = items.slice();
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };

  const removeAt = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  const append = () => {
    onChange([...items, { description: "", required: true }]);
  };

  return (
    <div className="space-y-3">
      {items.length > 0 && (
        <div className="space-y-2">
          {items.map((item, index) => (
            <div
              key={index}
              className="flex items-start gap-2 rounded-lg border border-[#E5E2DC] bg-[#FAF8F4] p-2.5"
            >
              <div className="flex-1 min-w-0">
                <Input
                  value={item.description}
                  onChange={(e) => updateAt(index, { description: e.target.value })}
                  placeholder={t("acceptanceCriteria.criterionPlaceholder")}
                  className="border-[#E5E2DC] text-sm focus-visible:ring-[#C67A52] h-8"
                  disabled={disabled}
                />
              </div>
              <div className="flex items-center gap-2 shrink-0 pt-1">
                <Switch
                  checked={item.required}
                  onCheckedChange={(checked) => updateAt(index, { required: checked })}
                  className="data-[state=checked]:bg-[#C67A52]"
                  disabled={disabled}
                />
                <span className="text-[10px] font-medium text-[#6B6B6B] min-w-[52px]">
                  {item.required
                    ? t("acceptanceCriteria.required")
                    : t("acceptanceCriteria.optional")}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-7 p-0 border-[#E5E2DC] text-[#9A9A9A] hover:text-[#D32F2F] hover:border-[#D32F2F] hover:bg-[#FFEBEE]"
                  onClick={() => removeAt(index)}
                  disabled={disabled}
                  type="button"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 border-[#E5E2DC] text-xs text-[#6B6B6B] hover:text-[#C67A52] hover:border-[#C67A52]"
        onClick={append}
        disabled={disabled}
        type="button"
      >
        <Plus className="h-3 w-3" />
        {t("acceptanceCriteria.addCriterion")}
      </Button>
    </div>
  );
}

/**
 * Normalize a row for comparison: trim description, coerce required to a
 * boolean. Order is preserved by the caller (we compare arrays index-wise).
 */
function normalizeRow(item: AcceptanceCriteriaItemDraft): {
  description: string;
  required: boolean;
} {
  return {
    description: item.description.trim(),
    required: Boolean(item.required),
  };
}

/**
 * Returns true if the edited acceptance-criteria rows differ from the
 * original set in a way that requires a server-side replace. Compares:
 *
 *   - trimmed description
 *   - boolean `required` flag
 *   - row order (index-wise)
 *
 * Whitespace-only differences are ignored (`"foo "` and `"foo"` are equal).
 *
 * Used by both panels (Task Draft + Task Detail in Task 2) to decide whether
 * to call `replaceAcceptanceCriteria` on save — skipping the call when the
 * set is unchanged preserves dev/admin verification marks.
 */
export function acCriteriaChanged(
  original: AcceptanceCriteriaItemDraft[],
  edited: AcceptanceCriteriaItemDraft[]
): boolean {
  if (original.length !== edited.length) return true;
  for (let i = 0; i < original.length; i++) {
    const a = normalizeRow(original[i]);
    const b = normalizeRow(edited[i]);
    if (a.description !== b.description) return true;
    if (a.required !== b.required) return true;
  }
  return false;
}
