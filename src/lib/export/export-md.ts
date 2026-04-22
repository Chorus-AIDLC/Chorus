// src/lib/export/export-md.ts
// Markdown export: prepend YAML frontmatter metadata header to the raw markdown content.

import type { ExportMetadata, ExportableDocument } from "@/types/export";

/**
 * Escape a value for inclusion as a YAML scalar inside frontmatter.
 *
 * YAML strings that contain characters with special meaning (colons, quotes,
 * newlines, leading/trailing whitespace) must be wrapped in double quotes with
 * internal backslashes/quotes/newlines escaped. Empty strings also need quoting.
 */
function escapeYamlValue(value: string): string {
  if (value === "") return '""';

  const needsQuoting =
    /[:#&*!|>'"%@`{}\[\],\\]/.test(value) ||
    /^[\s-]/.test(value) ||
    /\s$/.test(value) ||
    /[\n\r]/.test(value);

  if (!needsQuoting) return value;

  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

/**
 * Build the ExportMetadata object from an ExportableDocument, filling in
 * sensible defaults for missing fields so every exported file has a complete
 * YAML header.
 */
export function buildMetadata(doc: ExportableDocument): ExportMetadata {
  const version =
    doc.version === undefined || doc.version === null
      ? ""
      : typeof doc.version === "number"
        ? `v${doc.version}`
        : String(doc.version);

  return {
    title: doc.title ?? "",
    type: doc.type ?? "",
    version,
    author: doc.createdByName ?? "",
    created: doc.createdAt ?? "",
    updated: doc.updatedAt ?? "",
    project: doc.projectName ?? "",
  };
}

/**
 * Render an ExportMetadata object as a YAML frontmatter block
 * (`---` delimited, one key per line).
 */
export function renderFrontmatter(metadata: ExportMetadata): string {
  const lines = [
    "---",
    `title: ${escapeYamlValue(metadata.title)}`,
    `type: ${escapeYamlValue(metadata.type)}`,
    `version: ${escapeYamlValue(metadata.version)}`,
    `author: ${escapeYamlValue(metadata.author)}`,
    `created: ${escapeYamlValue(metadata.created)}`,
    `updated: ${escapeYamlValue(metadata.updated)}`,
    `project: ${escapeYamlValue(metadata.project)}`,
    "---",
  ];
  return lines.join("\n");
}

/**
 * Build a rendered markdown metadata header for PDF/DOCX export.
 * Uses a markdown table (not YAML frontmatter) so it renders visually
 * in the unified pipeline output.
 */
export function buildMetadataMarkdown(doc: ExportableDocument): string {
  const meta = buildMetadata(doc);
  const rows: string[] = [];
  if (meta.type) rows.push(`| **Type** | ${meta.type} |`);
  if (meta.version) rows.push(`| **Version** | ${meta.version} |`);
  if (meta.author) rows.push(`| **Author** | ${meta.author} |`);
  if (meta.created) rows.push(`| **Created** | ${meta.created} |`);
  if (meta.updated) rows.push(`| **Updated** | ${meta.updated} |`);
  if (meta.project) rows.push(`| **Project** | ${meta.project} |`);

  const table = rows.length > 0
    ? `| | |\n|---|---|\n${rows.join("\n")}\n`
    : "";

  return `# ${meta.title}\n\n${table}`;
}

/**
 * Export a document as a Markdown string: YAML frontmatter + blank line + body.
 */
export function exportAsMarkdown(doc: ExportableDocument): string {
  const metadata = buildMetadata(doc);
  const frontmatter = renderFrontmatter(metadata);
  const body = doc.content ?? "";
  return `${frontmatter}\n\n${body}`;
}

/**
 * Export a document as a Blob suitable for triggering a browser download
 * (MIME type `text/markdown`, UTF-8).
 */
export function exportAsMarkdownBlob(doc: ExportableDocument): Blob {
  const text = exportAsMarkdown(doc);
  return new Blob([text], { type: "text/markdown;charset=utf-8" });
}
