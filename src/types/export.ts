// src/types/export.ts
// Type definitions for Document export (Markdown / PDF / Word)

export type ExportFormat = "md" | "pdf" | "docx";

export interface ExportableDocument {
  title: string;
  content: string;
  type: string;
  version?: number | string;
  createdAt?: string;
  updatedAt?: string;
  createdByName?: string;
  projectName?: string;
}

export interface ExportMetadata {
  title: string;
  type: string;
  version: string;
  author: string;
  created: string;
  updated: string;
  project: string;
}
