import { ClipboardList, FileEdit, Palette, BookOpen, FileText, type LucideIcon } from "lucide-react";

export const docTypeConfig: Record<string, { labelKey: string; color: string; icon: LucideIcon }> = {
  prd: { labelKey: "documents.typePrd", color: "bg-[#E3F2FD] text-[#1976D2]", icon: ClipboardList },
  spec: { labelKey: "documents.typeSpec", color: "bg-[#E8F5E9] text-[#5A9E6F]", icon: FileEdit },
  design: { labelKey: "documents.typeDesign", color: "bg-[#F3E5F5] text-[#7B1FA2]", icon: Palette },
  note: { labelKey: "documents.typeNote", color: "bg-[#FFF3E0] text-[#E65100]", icon: BookOpen },
  other: { labelKey: "documents.typeOther", color: "bg-[#F5F5F5] text-[#6B6B6B]", icon: FileText },
};
