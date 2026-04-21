import type { ExportMetadata, ExportableDocument } from "@/types/export";
import { buildMetadata } from "./export-md";

function readPngDimensions(dataUrl: string): { width: number; height: number } | null {
  try {
    const base64 = dataUrl.split(",")[1];
    if (!base64) return null;
    const binary = atob(base64.substring(0, 100));
    if (binary.substring(1, 4) !== "PNG") return null;
    const width =
      (binary.charCodeAt(16) << 24) |
      (binary.charCodeAt(17) << 16) |
      (binary.charCodeAt(18) << 8) |
      binary.charCodeAt(19);
    const height =
      (binary.charCodeAt(20) << 24) |
      (binary.charCodeAt(21) << 16) |
      (binary.charCodeAt(22) << 8) |
      binary.charCodeAt(23);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapInDocxTemplate(body: string, metadata: ExportMetadata): string {
  const metaRows: string[] = [];
  if (metadata.type)
    metaRows.push(`<tr><td style="font-weight:bold;padding:2px 8px 2px 0">Type</td><td style="padding:2px 0">${escapeHtml(metadata.type)}</td></tr>`);
  if (metadata.version)
    metaRows.push(`<tr><td style="font-weight:bold;padding:2px 8px 2px 0">Version</td><td style="padding:2px 0">${escapeHtml(metadata.version)}</td></tr>`);
  if (metadata.author)
    metaRows.push(`<tr><td style="font-weight:bold;padding:2px 8px 2px 0">Author</td><td style="padding:2px 0">${escapeHtml(metadata.author)}</td></tr>`);
  if (metadata.created)
    metaRows.push(`<tr><td style="font-weight:bold;padding:2px 8px 2px 0">Created</td><td style="padding:2px 0">${escapeHtml(metadata.created)}</td></tr>`);
  if (metadata.updated)
    metaRows.push(`<tr><td style="font-weight:bold;padding:2px 8px 2px 0">Updated</td><td style="padding:2px 0">${escapeHtml(metadata.updated)}</td></tr>`);
  if (metadata.project)
    metaRows.push(`<tr><td style="font-weight:bold;padding:2px 8px 2px 0">Project</td><td style="padding:2px 0">${escapeHtml(metadata.project)}</td></tr>`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(metadata.title)}</title>
<style>
  body {
    font-family: "Calibri", "Arial", sans-serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #1a1a1a;
    margin: 0;
  }
  .metadata-header {
    border-bottom: 2px solid #cccccc;
    padding-bottom: 10pt;
    margin-bottom: 16pt;
  }
  .metadata-header h1 {
    font-size: 18pt;
    margin: 0 0 6pt 0;
  }
  .metadata-table {
    border-collapse: collapse;
    font-size: 9pt;
    color: #666666;
    width: auto;
  }
  .metadata-table td {
    border: none;
  }
  h1 { font-size: 16pt; margin-top: 18pt; margin-bottom: 6pt; }
  h2 { font-size: 14pt; margin-top: 14pt; margin-bottom: 6pt; }
  h3 { font-size: 12pt; margin-top: 12pt; margin-bottom: 4pt; }
  pre {
    background-color: #f5f5f5;
    border: 1px solid #dddddd;
    padding: 8pt;
    font-family: "Consolas", "Courier New", monospace;
    font-size: 9pt;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  code {
    font-family: "Consolas", "Courier New", monospace;
    font-size: 9pt;
  }
  table {
    border-collapse: collapse;
    width: 450pt;
    table-layout: fixed;
    margin: 8pt 0;
  }
  th, td {
    border: 1px solid #cccccc;
    padding: 4pt 6pt;
    text-align: left;
    word-wrap: break-word;
    overflow: hidden;
  }
  th {
    background-color: #f0f0f0;
    font-weight: bold;
  }
  blockquote {
    border-left: 3pt solid #cccccc;
    margin: 8pt 0;
    padding: 4pt 10pt;
    color: #555555;
  }
  img {
    max-width: 450pt;
    height: auto;
  }
  hr {
    border: none;
    border-top: 1px solid #cccccc;
    margin: 16pt 0;
  }
  a { color: #2563eb; }
</style>
</head>
<body>
<div class="metadata-header">
  <h1>${escapeHtml(metadata.title)}</h1>
  ${metaRows.length > 0 ? `<table class="metadata-table">${metaRows.join("")}</table>` : ""}
</div>
${body}
</body>
</html>`;
}

export async function exportAsDocx(doc: ExportableDocument): Promise<Blob> {
  const [{ marked }, { renderMermaidBlocks }, htmlDocxModule] =
    await Promise.all([
      import("marked"),
      import("./mermaid-renderer"),
      import("html-docx-js-typescript"),
    ]);

  const metadata = buildMetadata(doc);
  const rawHtml = await marked.parse(doc.content ?? "");
  const withMermaid = await renderMermaidBlocks(rawHtml);
  const docxReady = withMermaid.replace(
    /<img src="(data:image\/png;base64,[^"]+)" alt="([^"]*)" style="max-width:100%">/g,
    (_, src: string, alt: string) => {
      const dims = readPngDimensions(src);
      if (dims) {
        const maxW = 450;
        const scale = Math.min(1, maxW / dims.width);
        const w = Math.round(dims.width * scale);
        const h = Math.round(dims.height * scale);
        return `<img src="${src}" alt="${alt}" width="${w}" height="${h}">`;
      }
      return `<img src="${src}" alt="${alt}" width="450">`;
    }
  );
  const withStyledCode = docxReady.replace(
    /<code>([\s\S]*?)<\/code>/gi,
    (match, content, offset, full) => {
      const before = full.substring(0, offset);
      let depth = 0;
      let m;
      const openRe = /<pre[\s>]/gi;
      const closeRe = /<\/pre[\s>]/gi;
      while ((m = openRe.exec(before)) !== null) depth++;
      while ((m = closeRe.exec(before)) !== null) depth--;
      if (depth > 0) return match;
      return `<span style="font-family:'Consolas','Courier New',monospace;font-size:9pt;background-color:#f5f5f5;color:#c7254e">${content}</span>`;
    }
  );
  const fullHtml = wrapInDocxTemplate(withStyledCode, metadata);

  const blob = await htmlDocxModule.asBlob(fullHtml);
  return blob as Blob;
}
