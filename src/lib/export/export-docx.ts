import type { ExportableDocument } from "@/types/export";

export async function exportAsDocx(doc: ExportableDocument): Promise<Blob> {
  const [
    { unified },
    { default: remarkParse },
    { default: remarkGfm },
    { default: remarkDocx },
    { default: remarkMermaid },
    { buildMetadataMarkdown },
    { imagePlugin },
    { shikiPlugin },
  ] = await Promise.all([
    import("unified"),
    import("remark-parse"),
    import("remark-gfm"),
    import("remark-docx"),
    import("./remark-mermaid"),
    import("./export-md"),
    import("remark-docx/plugins/image"),
    import("remark-docx/plugins/shiki"),
  ]);

  const markdown = buildMetadataMarkdown(doc) + "\n\n" + (doc.content ?? "");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processor = (unified() as any)
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMermaid)
    .use(remarkDocx, {
      title: doc.title,
      creator: doc.createdByName ?? "",
      thematicBreak: "line",
      styles: {
        default: {
          heading1: {
            paragraph: { spacing: { before: 360, after: 120 } },
          },
          heading2: {
            paragraph: { spacing: { before: 300, after: 100 } },
          },
          heading3: {
            paragraph: { spacing: { before: 240, after: 80 } },
          },
          document: {
            paragraph: {
              spacing: { after: 120 },
            },
          },
        },
      },
      plugins: [
        imagePlugin(),
        shikiPlugin({ theme: "github-light" }),
      ],
    });

  const file = await processor.process(markdown);
  const arrayBuffer = await file.result;
  return new Blob([arrayBuffer], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
