import { describe, it, expect } from "vitest";

import {
  buildMetadata,
  buildMetadataMarkdown,
  exportAsMarkdown,
  exportAsMarkdownBlob,
  renderFrontmatter,
} from "../export-md";
import { formatDateTime } from "@/lib/format-date";
import type { ExportableDocument } from "@/types/export";

const CREATED_AT = "2026-04-21T10:00:00.000Z";
const UPDATED_AT = "2026-04-21T11:00:00.000Z";
const CREATED_AT_FORMATTED = formatDateTime(CREATED_AT);
const UPDATED_AT_FORMATTED = formatDateTime(UPDATED_AT);

const fullDoc: ExportableDocument = {
  title: "Design Doc",
  content: "# Hello\n\nBody text.",
  type: "tech_design",
  version: 3,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  createdByName: "Alice",
  projectName: "Chorus 0.7.0",
};

describe("buildMetadata", () => {
  it("formats numeric version with v prefix", () => {
    const meta = buildMetadata(fullDoc);
    expect(meta.version).toBe("v3");
    expect(meta.author).toBe("Alice");
    expect(meta.project).toBe("Chorus 0.7.0");
    expect(meta.title).toBe("Design Doc");
    expect(meta.type).toBe("tech_design");
    expect(meta.created).toBe(CREATED_AT_FORMATTED);
    expect(meta.updated).toBe(UPDATED_AT_FORMATTED);
    expect(meta.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(meta.updated).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("keeps string versions verbatim", () => {
    const meta = buildMetadata({ ...fullDoc, version: "Draft" });
    expect(meta.version).toBe("Draft");
  });

  it("uses empty strings for missing optional fields", () => {
    const meta = buildMetadata({
      title: "T",
      content: "C",
      type: "prd",
    });
    expect(meta.version).toBe("");
    expect(meta.author).toBe("");
    expect(meta.created).toBe("");
    expect(meta.updated).toBe("");
    expect(meta.project).toBe("");
  });

  it("treats null version as empty", () => {
    const meta = buildMetadata({
      ...fullDoc,
      version: null as unknown as number,
    });
    expect(meta.version).toBe("");
  });
});

describe("renderFrontmatter", () => {
  it("produces delimited YAML block with all keys", () => {
    const meta = buildMetadata(fullDoc);
    const yaml = renderFrontmatter(meta);
    expect(yaml.startsWith("---\n")).toBe(true);
    expect(yaml.endsWith("\n---")).toBe(true);
    expect(yaml).toContain("title: Design Doc");
    expect(yaml).toContain("type: tech_design");
    expect(yaml).toContain("version: v3");
    expect(yaml).toContain("author: Alice");
    expect(yaml).toContain(`created: "${CREATED_AT_FORMATTED}"`);
    expect(yaml).toContain(`updated: "${UPDATED_AT_FORMATTED}"`);
    expect(yaml).toContain("project: Chorus 0.7.0");
  });

  it("quotes values that contain YAML-significant characters", () => {
    const meta = buildMetadata({
      ...fullDoc,
      title: "Report: Q1 Review",
    });
    const yaml = renderFrontmatter(meta);
    expect(yaml).toContain('title: "Report: Q1 Review"');
  });

  it("escapes embedded quotes, backslashes, and newlines", () => {
    const meta = buildMetadata({
      ...fullDoc,
      title: 'Line1\nLine2 "quoted" \\back',
    });
    const yaml = renderFrontmatter(meta);
    expect(yaml).toContain('title: "Line1\\nLine2 \\"quoted\\" \\\\back"');
  });

  it("quotes leading-dash and empty values", () => {
    const yaml = renderFrontmatter({
      title: "-danger",
      type: "",
      version: "",
      author: "",
      created: "",
      updated: "",
      project: "",
    });
    expect(yaml).toContain('title: "-danger"');
    expect(yaml).toContain('type: ""');
  });

  it("escapes carriage returns", () => {
    const yaml = renderFrontmatter({
      title: "a\rb",
      type: "prd",
      version: "v1",
      author: "",
      created: "",
      updated: "",
      project: "",
    });
    expect(yaml).toContain('title: "a\\rb"');
  });

  it("quotes trailing whitespace", () => {
    const yaml = renderFrontmatter({
      title: "trailing ",
      type: "prd",
      version: "v1",
      author: "",
      created: "",
      updated: "",
      project: "",
    });
    expect(yaml).toContain('title: "trailing "');
  });
});

describe("buildMetadataMarkdown", () => {
  it("renders title as h1 and metadata as a table", () => {
    const md = buildMetadataMarkdown(fullDoc);
    expect(md).toContain("# Design Doc");
    expect(md).toContain("| **Type** | tech_design |");
    expect(md).toContain("| **Version** | v3 |");
    expect(md).toContain("| **Author** | Alice |");
    expect(md).toContain(`| **Created** | ${CREATED_AT_FORMATTED} |`);
    expect(md).toContain(`| **Updated** | ${UPDATED_AT_FORMATTED} |`);
    expect(md).toContain("| **Project** | Chorus 0.7.0 |");
  });

  it("includes table header row", () => {
    const md = buildMetadataMarkdown(fullDoc);
    expect(md).toContain("| | |\n|---|---|");
  });

  it("omits empty metadata rows", () => {
    const md = buildMetadataMarkdown({
      title: "Minimal",
      content: "body",
      type: "",
    });
    expect(md).toContain("# Minimal");
    expect(md).not.toContain("| **Type**");
    expect(md).not.toContain("| **Version**");
    expect(md).not.toContain("| **Author**");
  });

  it("does not contain thematic break separator", () => {
    const md = buildMetadataMarkdown(fullDoc);
    expect(md).not.toContain("\n---\n");
  });
});

describe("exportAsMarkdown", () => {
  it("prepends frontmatter and separates body with blank line", () => {
    const out = exportAsMarkdown(fullDoc);
    const parts = out.split("\n---\n");
    expect(parts).toHaveLength(2);
    expect(parts[1]).toBe("\n# Hello\n\nBody text.");
  });

  it("handles empty content by emitting only the header", () => {
    const out = exportAsMarkdown({ ...fullDoc, content: "" });
    expect(out.endsWith("---\n\n")).toBe(true);
  });

  it("defaults missing title to empty string and missing content safely", () => {
    const out = exportAsMarkdown({
      title: "",
      content: undefined as unknown as string,
      type: "note",
    });
    expect(out).toContain('title: ""');
    expect(out).toContain("---");
  });
});

describe("exportAsMarkdownBlob", () => {
  it("produces a Blob tagged as text/markdown", () => {
    const blob = exportAsMarkdownBlob(fullDoc);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/markdown;charset=utf-8");
    expect(blob.size).toBeGreaterThan(0);
  });
});
