import type { ExportMetadata } from "@/types/export";

let mermaidInitialized = false;

async function initMermaid() {
  if (mermaidInitialized) return;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, theme: "default" });
  mermaidInitialized = true;
}

async function mermaidSvgToPng(svgHtml: string): Promise<string> {
  const { toPng } = await import("html-to-image");

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.top = "0";
  container.style.left = "0";
  container.style.background = "white";
  container.style.zIndex = "99999";
  container.style.pointerEvents = "none";
  container.innerHTML = svgHtml;
  document.body.appendChild(container);

  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  try {
    const svgEl = container.querySelector("svg");
    let pixelRatio = window.devicePixelRatio || 2;

    if (svgEl) {
      const viewBox = svgEl.viewBox?.baseVal;
      const intrinsicWidth =
        (viewBox && viewBox.width > 0 ? viewBox.width : 0) ||
        parseFloat(svgEl.style.maxWidth) ||
        parseFloat(svgEl.getAttribute("width") || "0");
      const displayedWidth = container.offsetWidth;
      if (intrinsicWidth > 0 && displayedWidth > 0) {
        pixelRatio = Math.max(pixelRatio, (intrinsicWidth / displayedWidth) * 1.5);
      }
    }

    pixelRatio = Math.min(pixelRatio, 8);

    return await toPng(container, { backgroundColor: "#ffffff", pixelRatio });
  } finally {
    document.body.removeChild(container);
  }
}

let renderCounter = 0;

export async function renderMermaidBlocks(html: string): Promise<string> {
  const mermaidBlockRegex =
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/gi;

  const matches = [...html.matchAll(mermaidBlockRegex)];
  if (matches.length === 0) return html;

  await initMermaid();
  const { default: mermaid } = await import("mermaid");

  let result = html;

  for (const match of matches) {
    const fullMatch = match[0];
    const diagramCode = match[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    try {
      const id = `mermaid-export-${renderCounter++}`;
      const { svg } = await mermaid.render(id, diagramCode);
      const pngDataUrl = await mermaidSvgToPng(svg);
      result = result.replace(
        fullMatch,
        `<div class="mermaid-diagram" style="text-align:center;margin:1em 0"><img src="${pngDataUrl}" alt="Mermaid diagram" style="max-width:100%"></div>`
      );
    } catch (err) {
      console.warn("Mermaid render failed, keeping code block:", err);
    }
  }

  return result;
}

export function convertInlineCodeForPdf(html: string): string {
  return html.replace(
    /<code>([\s\S]*?)<\/code>/gi,
    (match, content, offset, full) => {
      const before = full.substring(0, offset);
      let depth = 0;
      const preOpenRe = /<pre[\s>]/gi;
      const preCloseRe = /<\/pre[\s>]/gi;
      let m;
      while ((m = preOpenRe.exec(before)) !== null) depth++;
      while ((m = preCloseRe.exec(before)) !== null) depth--;
      if (depth > 0) return match;
      return `<span style="font-family:Consolas,'Courier New',monospace;font-size:0.85em;color:#c7254e;font-weight:600">${content}</span>`;
    }
  );
}

const CSS = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
    max-width: 800px;
    margin: 0 auto;
    padding: 2em;
  }
  .metadata-header {
    border-bottom: 2px solid #e5e7eb;
    padding-bottom: 1em;
    margin-bottom: 2em;
    color: #6b7280;
    font-size: 0.875em;
  }
  .metadata-header h1 {
    color: #1a1a1a;
    font-size: 1.75em;
    margin: 0 0 0.5em 0;
  }
  .metadata-header .meta-row {
    display: flex;
    gap: 2em;
    flex-wrap: wrap;
  }
  .metadata-header .meta-item {
    display: flex;
    gap: 0.4em;
  }
  .metadata-header .meta-label {
    font-weight: 600;
    color: #374151;
  }
  h1, h2, h3, h4, h5, h6 {
    color: #111827;
    margin-top: 1.5em;
    margin-bottom: 0.5em;
    page-break-after: avoid;
  }
  h1 { font-size: 1.5em; }
  h2 { font-size: 1.3em; }
  h3 { font-size: 1.15em; }
  pre {
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 1em;
    overflow-x: auto;
    font-size: 0.875em;
    page-break-inside: avoid;
  }
  code {
    font-family: Consolas, "Courier New", monospace;
    font-size: 0.85em;
  }
  :not(pre) > code {
    background: #f0f0f0;
    padding: 0 4px;
    border-radius: 3px;
    font-size: 0.85em;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
    page-break-inside: avoid;
  }
  th, td {
    border: 1px solid #d1d5db;
    padding: 0.5em 0.75em;
    text-align: left;
  }
  th {
    background: #f9fafb;
    font-weight: 600;
  }
  blockquote {
    border-left: 4px solid #d1d5db;
    margin: 1em 0;
    padding: 0.5em 1em;
    color: #4b5563;
    background: #f9fafb;
  }
  img { max-width: 100%; height: auto; }
  .mermaid-diagram { page-break-inside: avoid; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 2em 0; }
  a { color: #2563eb; }
  @media print {
    body { padding: 0; max-width: none; }
  }
`;

function metadataHtml(metadata: ExportMetadata): string {
  return `<div class="metadata-header">
  <h1>${escapeHtml(metadata.title)}</h1>
  <div class="meta-row">
    ${metadata.type ? `<div class="meta-item"><span class="meta-label">Type:</span> ${escapeHtml(metadata.type)}</div>` : ""}
    ${metadata.version ? `<div class="meta-item"><span class="meta-label">Version:</span> ${escapeHtml(metadata.version)}</div>` : ""}
    ${metadata.author ? `<div class="meta-item"><span class="meta-label">Author:</span> ${escapeHtml(metadata.author)}</div>` : ""}
  </div>
  <div class="meta-row" style="margin-top:0.3em">
    ${metadata.created ? `<div class="meta-item"><span class="meta-label">Created:</span> ${escapeHtml(metadata.created)}</div>` : ""}
    ${metadata.updated ? `<div class="meta-item"><span class="meta-label">Updated:</span> ${escapeHtml(metadata.updated)}</div>` : ""}
    ${metadata.project ? `<div class="meta-item"><span class="meta-label">Project:</span> ${escapeHtml(metadata.project)}</div>` : ""}
  </div>
</div>`;
}

export function wrapInHtmlTemplate(body: string, metadata: ExportMetadata): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(metadata.title)}</title>
<style>${CSS}</style>
</head>
<body>
${metadataHtml(metadata)}
${body}
</body>
</html>`;
}

export function buildPdfContent(body: string, metadata: ExportMetadata): string {
  const scopedCss = CSS
    .replace(/\bbody\b/g, ".export-root")
    .replace(/\bh1\b(?!\s*\{)/g, ".export-root h1")
    .replace(/\bh2\b(?!\s*\{)/g, ".export-root h2")
    .replace(/\bh3\b(?!\s*\{)/g, ".export-root h3");

  return `<div class="export-root">
<style>
  .export-root {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
    padding: 2em;
  }
  .export-root .metadata-header {
    border-bottom: 2px solid #e5e7eb;
    padding-bottom: 1em;
    margin-bottom: 2em;
    color: #6b7280;
    font-size: 0.875em;
  }
  .export-root .metadata-header h1 {
    color: #1a1a1a;
    font-size: 1.75em;
    margin: 0 0 0.5em 0;
  }
  .export-root .metadata-header .meta-row {
    display: flex;
    gap: 2em;
    flex-wrap: wrap;
  }
  .export-root .metadata-header .meta-item {
    display: flex;
    gap: 0.4em;
  }
  .export-root .metadata-header .meta-label {
    font-weight: 600;
    color: #374151;
  }
  .export-root h1, .export-root h2, .export-root h3, .export-root h4, .export-root h5, .export-root h6 {
    color: #111827;
    margin-top: 1.5em;
    margin-bottom: 0.5em;
  }
  .export-root h1 { font-size: 1.5em; }
  .export-root h2 { font-size: 1.3em; }
  .export-root h3 { font-size: 1.15em; }
  .export-root pre {
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 1em;
    overflow-x: auto;
    font-size: 0.875em;
  }
  .export-root code {
    font-family: Consolas, "Courier New", monospace;
    font-size: 0.85em;
  }
  .export-root :not(pre) > code {
    background: #f0f0f0;
    border: 1px solid #e0e0e0;
    padding: 1px 5px;
    border-radius: 3px;
  }
  .export-root table {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
  }
  .export-root th, .export-root td {
    border: 1px solid #d1d5db;
    padding: 0.5em 0.75em;
    text-align: left;
  }
  .export-root th {
    background: #f9fafb;
    font-weight: 600;
  }
  .export-root blockquote {
    border-left: 4px solid #d1d5db;
    margin: 1em 0;
    padding: 0.5em 1em;
    color: #4b5563;
    background: #f9fafb;
  }
  .export-root img { max-width: 100%; height: auto; }
  .export-root .mermaid-diagram { text-align: center; margin: 1em 0; }
  .export-root hr { border: none; border-top: 1px solid #e5e7eb; margin: 2em 0; }
  .export-root a { color: #2563eb; }
</style>
${metadataHtml(metadata)}
${body}
</div>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
