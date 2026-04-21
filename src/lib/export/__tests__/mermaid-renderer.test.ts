import { describe, it, expect } from "vitest";
import { wrapInHtmlTemplate } from "../mermaid-renderer";
import type { ExportMetadata } from "@/types/export";

describe("wrapInHtmlTemplate", () => {
  const metadata: ExportMetadata = {
    title: "Test Document",
    type: "tech_design",
    version: "v1",
    author: "Test User",
    created: "2026-01-01",
    updated: "2026-01-02",
    project: "Test Project",
  };

  it("produces a complete HTML document", () => {
    const html = wrapInHtmlTemplate("<p>Hello</p>", metadata);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("<p>Hello</p>");
  });

  it("includes metadata in the header", () => {
    const html = wrapInHtmlTemplate("<p>Body</p>", metadata);
    expect(html).toContain("Test Document");
    expect(html).toContain("tech_design");
    expect(html).toContain("v1");
    expect(html).toContain("Test User");
    expect(html).toContain("2026-01-01");
    expect(html).toContain("2026-01-02");
    expect(html).toContain("Test Project");
  });

  it("includes CSS for typography, code blocks, and tables", () => {
    const html = wrapInHtmlTemplate("", metadata);
    expect(html).toContain("font-family:");
    expect(html).toContain("border-collapse: collapse");
    expect(html).toContain("page-break-inside: avoid");
  });

  it("escapes HTML entities in metadata", () => {
    const meta: ExportMetadata = {
      ...metadata,
      title: 'Doc <script>alert("xss")</script>',
    };
    const html = wrapInHtmlTemplate("", meta);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits empty metadata fields gracefully", () => {
    const sparse: ExportMetadata = {
      title: "Only Title",
      type: "",
      version: "",
      author: "",
      created: "",
      updated: "",
      project: "",
    };
    const html = wrapInHtmlTemplate("<p>content</p>", sparse);
    expect(html).toContain("Only Title");
    expect(html).not.toContain("Type:");
    expect(html).not.toContain("Version:");
  });
});
