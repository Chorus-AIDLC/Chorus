import { ClipboardList, FileEdit, Palette, BookOpen, FileText, type LucideIcon } from "lucide-react";

export const docTypeConfig: Record<string, { labelKey: string; color: string; icon: LucideIcon }> = {
  prd: { labelKey: "documents.typePrd", color: "bg-[#E3F2FD] text-[#1976D2] dark:bg-[#13253a] dark:text-[#5AA9F0]", icon: ClipboardList },
  spec: { labelKey: "documents.typeSpec", color: "bg-[#E8F5E9] text-[#5A9E6F] dark:bg-[#14281a] dark:text-[#6FD19A]", icon: FileEdit },
  design: { labelKey: "documents.typeDesign", color: "bg-[#F3E5F5] text-[#7B1FA2] dark:bg-[#281630] dark:text-[#C98FE0]", icon: Palette },
  note: { labelKey: "documents.typeNote", color: "bg-[#FFF3E0] text-[#E65100] dark:bg-[#3a2a12] dark:text-[#F0A050]", icon: BookOpen },
  report: { labelKey: "documents.typeReport", color: "bg-[#FFF8E1] text-[#9A6B00] dark:bg-[#332a12] dark:text-[#E0B44E]", icon: FileText },
  other: { labelKey: "documents.typeOther", color: "bg-[#F5F5F5] text-[#6B6B6B] dark:bg-[#1e1e20] dark:text-[#aba29a]", icon: FileText },
};
