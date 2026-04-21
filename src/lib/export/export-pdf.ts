import type { ExportableDocument } from "@/types/export";
import { buildMetadata } from "./export-md";

export async function exportAsPdf(doc: ExportableDocument): Promise<Blob> {
  const [{ marked }, { renderMermaidBlocks, buildPdfContent, convertInlineCodeForPdf }, { jsPDF }] =
    await Promise.all([
      import("marked"),
      import("./mermaid-renderer"),
      import("jspdf"),
    ]);

  const metadata = buildMetadata(doc);
  const rawHtml = await marked.parse(doc.content ?? "");
  const withMermaid = await renderMermaidBlocks(rawHtml);
  const withInlineCode = convertInlineCodeForPdf(withMermaid);
  const content = buildPdfContent(withInlineCode, metadata);

  const wrapper = document.createElement("div");
  wrapper.innerHTML = content;
  wrapper.style.position = "fixed";
  wrapper.style.top = "0";
  wrapper.style.left = "0";
  wrapper.style.width = "750px";
  wrapper.style.background = "white";
  wrapper.style.zIndex = "99999";
  wrapper.style.pointerEvents = "none";
  document.body.appendChild(wrapper);

  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const target = wrapper.querySelector(".export-root") as HTMLElement;

  try {
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });

    await new Promise<void>((resolve, reject) => {
      pdf.html(target, {
        callback: () => resolve(),
        x: 0,
        y: 0,
        width: 170,
        windowWidth: 750,
        margin: [15, 20, 15, 20],
        autoPaging: "text",
        html2canvas: {
          scale: 0.2267,
          useCORS: true,
          logging: false,
          allowTaint: true,
        },
      }).catch(reject);
    });

    return pdf.output("blob");
  } finally {
    document.body.removeChild(wrapper);
  }
}
