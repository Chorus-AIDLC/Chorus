/** Normalize escaped newlines from JSON into real newlines for markdown rendering */
export function normalizeNewlines(text: string): string {
  return text.replace(/\\n/g, "\n");
}

/** Map document types to i18n keys under the "documents" namespace */
export const DOC_TYPE_I18N_KEYS: Record<string, string> = {
  prd: "typePrd",
  tech_design: "typeTechDesign",
  adr: "typeAdr",
  spec: "typeSpec",
  guide: "typeGuide",
  design: "typeDesign",
  note: "typeNote",
  report: "typeReport",
  other: "typeOther",
};
