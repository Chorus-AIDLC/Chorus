import type { ExportableDocument } from "@/types/export";

export async function exportAsPdf(doc: ExportableDocument): Promise<Blob> {
  const [{ unified }, { default: remarkParse }, { default: remarkGfm }, { default: remarkPdf }, { default: remarkMermaid }, { buildMetadataMarkdown }] =
    await Promise.all([
      import("unified"),
      import("remark-parse"),
      import("remark-gfm"),
      import("remark-pdf"),
      import("./remark-mermaid"),
      import("./export-md"),
    ]);

  const markdown = buildMetadataMarkdown(doc) + "\n\n" + (doc.content ?? "");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processor = (unified() as any)
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMermaid)
    .use(remarkPdf, {
      fonts: ["Helvetica", "Courier"],
      size: "A4",
      margin: { top: 60, bottom: 60, left: 65, right: 65 },
      spacing: 6,
      styles: {
        default: {
          fontSize: 10.5,
          color: "#24292f",
        },
        head1: {
          fontSize: 24,
          bold: true,
          color: "#1f2328",
        },
        head2: {
          fontSize: 18,
          bold: true,
          color: "#1f2328",
        },
        head3: {
          fontSize: 15,
          bold: true,
          color: "#1f2328",
        },
        head4: {
          fontSize: 12.5,
          bold: true,
          color: "#1f2328",
        },
        head5: {
          fontSize: 11,
          bold: true,
          color: "#1f2328",
        },
        head6: {
          fontSize: 10.5,
          bold: true,
          italic: true,
          color: "#656d76",
        },
        link: {
          color: "#0969da",
          underline: true,
        },
        inlineCode: {
          font: "Courier",
          color: "#1f2328",
          fontSize: 9.5,
          bold: true,
        },
        code: {
          font: "Courier",
          fontSize: 9,
          color: "#1f2328",
        },
        blockquote: {
          color: "#656d76",
          italic: true,
        },
      },
    });

  const file = await processor.process(markdown);
  const arrayBuffer = await file.result;
  return new Blob([arrayBuffer], { type: "application/pdf" });
}
