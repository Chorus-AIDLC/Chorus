"use client";

import { useCallback, useState } from "react";

import { clientLogger } from "@/lib/logger-client";
import type { ExportFormat, ExportableDocument } from "@/types/export";

/**
 * Sanitize a document title for use as a filename. Strips characters that
 * Windows/macOS/Linux filesystems reject, collapses whitespace to single
 * dashes, and falls back to "document" for empty results.
 */
function sanitizeFilename(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s/g, "-");
  return cleaned.length > 0 ? cleaned : "document";
}

/**
 * Trigger a browser download for a Blob by creating a temporary object URL,
 * clicking a hidden anchor, and revoking the URL afterwards.
 */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Defer revocation so Safari/iOS have time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


export interface UseDocumentExportResult {
  exportDocument: (doc: ExportableDocument, format: ExportFormat) => Promise<void>;
  isExporting: boolean;
  exportError: string | null;
}

/**
 * React hook for exporting a Document as Markdown, PDF, or Word.
 *
 * PDF and Word modules are loaded lazily via dynamic import() so their heavy
 * dependencies (unified, remark-pdf, remark-docx, mermaid) do not affect the
 * initial bundle.
 */
export function useDocumentExport(): UseDocumentExportResult {
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const exportDocument = useCallback(
    async (doc: ExportableDocument, format: ExportFormat) => {
      setIsExporting(true);
      setExportError(null);
      try {
        const filenameBase = sanitizeFilename(doc.title);
        let blob: Blob;
        let extension: string;

        if (format === "md") {
          const { exportAsMarkdownBlob } = await import("@/lib/export/export-md");
          blob = exportAsMarkdownBlob(doc);
          extension = "md";
        } else if (format === "pdf") {
          const { exportAsPdf } = await import("@/lib/export/export-pdf");
          blob = await exportAsPdf(doc);
          extension = "pdf";
        } else if (format === "docx") {
          const { exportAsDocx } = await import("@/lib/export/export-docx");
          blob = await exportAsDocx(doc);
          extension = "docx";
        } else {
          const exhaustive: never = format;
          throw new Error(`Unsupported export format: ${String(exhaustive)}`);
        }

        triggerDownload(blob, `${filenameBase}.${extension}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setExportError(message);
        // Re-surface the full error so developers can see the stack; the UI
        // layer is responsible for showing a toast based on `exportError`.
        clientLogger.error("useDocumentExport export failed", err);
      } finally {
        setIsExporting(false);
      }
    },
    []
  );

  return { exportDocument, isExporting, exportError };
}
