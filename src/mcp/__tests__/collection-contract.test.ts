import { describe, expect, it } from "vitest";
import {
  COLLECTION_TOOL_INVENTORY,
  CollectionPayloadTooLargeError,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_COLLECTION_JSON_BYTES,
  MAX_PAGE_SIZE,
  PREVIEW_TEXT_CODE_POINTS,
  SUMMARY_TEXT_CODE_POINTS,
  assertCollectionToolsInventoried,
  buildBoundedCollectionPayload,
  collectionPageSchema,
  collectionPageSizeSchema,
  serializeBoundedCollection,
  serializeBoundedAggregate,
  truncatePreviewText,
  truncateSummaryText,
} from "@/mcp/tools/collection-contract";

describe("MCP collection contract", () => {
  it("applies shared defaults and validates positive bounded integers", () => {
    expect(collectionPageSchema.parse(undefined)).toBe(DEFAULT_PAGE);
    expect(collectionPageSizeSchema.parse(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(collectionPageSchema.parse(3)).toBe(3);
    expect(collectionPageSizeSchema.parse(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE);

    for (const invalid of [0, -1, 1.5]) {
      expect(() => collectionPageSchema.parse(invalid)).toThrow();
      expect(() => collectionPageSizeSchema.parse(invalid)).toThrow();
    }
    expect(() => collectionPageSizeSchema.parse(MAX_PAGE_SIZE + 1)).toThrow();
  });

  it("preserves the collection key and emits complete pagination metadata", () => {
    const payload = buildBoundedCollectionPayload({
      collectionKey: "ideas",
      rows: [{ uuid: "one" }, { uuid: "two" }],
      total: 9,
      page: 2,
      pageSize: 2,
    });

    expect(payload).toEqual({
      ideas: [{ uuid: "one" }, { uuid: "two" }],
      returned: 2,
      page: 2,
      pageSize: 2,
      total: 9,
    });
  });

  it("removes trailing rows until final UTF-8 JSON fits the byte ceiling", () => {
    const multibyte = "界".repeat(8_000);
    const text = serializeBoundedCollection({
      collectionKey: "results",
      rows: Array.from({ length: 5 }, (_, index) => ({
        uuid: String(index),
        snippet: multibyte,
      })),
      total: 5,
      page: 1,
      pageSize: 5,
    });
    const payload = JSON.parse(text) as {
      results: unknown[];
      returned: number;
      page: number;
      pageSize: number;
      total: number;
    };

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
      MAX_COLLECTION_JSON_BYTES,
    );
    expect(payload.returned).toBe(payload.results.length);
    expect(payload.returned).toBeGreaterThan(0);
    expect(payload.returned).toBeLessThan(5);
    expect(payload).toMatchObject({ page: 1, pageSize: 5, total: 5 });
  });

  it("returns a structured error when one row cannot fit", () => {
    expect.assertions(3);
    try {
      buildBoundedCollectionPayload({
        collectionKey: "documents",
        rows: [{ content: "界".repeat(30_000) }],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CollectionPayloadTooLargeError);
      expect(JSON.stringify(error)).toContain("MCP_COLLECTION_ROW_TOO_LARGE");
      expect(JSON.stringify(error)).toContain("65536");
    }
  });

  it("trims nested aggregate collection tails to the UTF-8 byte ceiling", () => {
    const payload = {
      agent: {
        uuid: "agent-1",
        name: "Agent",
        permissions: ["idea:read", "task:read"],
      },
      ideaTracker: {
        project: {
          name: "Project",
          ideas: Array.from({ length: 100 }, (_, index) => ({
            uuid: `idea-${index}`,
            title: "界".repeat(256),
          })),
        },
      },
      notifications: Array.from({ length: 5 }, (_, index) => ({
        uuid: `notification-${index}`,
        title: "界".repeat(512),
      })),
    };

    const text = serializeBoundedAggregate(payload);
    const result = JSON.parse(text);

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
      MAX_COLLECTION_JSON_BYTES,
    );
    expect(result.agent).toEqual(payload.agent);
    expect(result.ideaTracker.project.ideas.length).toBeLessThan(100);
    expect(result.notifications.length).toBeLessThanOrEqual(5);
  });

  it("truncates by Unicode code point and keeps the ellipsis inside the limit", () => {
    const summarySource = "😀".repeat(SUMMARY_TEXT_CODE_POINTS + 10);
    const previewSource = "界".repeat(PREVIEW_TEXT_CODE_POINTS + 10);
    const summary = truncateSummaryText(summarySource);
    const preview = truncatePreviewText(previewSource);

    expect(Array.from(summary)).toHaveLength(SUMMARY_TEXT_CODE_POINTS);
    expect(summary.endsWith("...")).toBe(true);
    expect(Array.from(preview)).toHaveLength(PREVIEW_TEXT_CODE_POINTS);
    expect(preview.endsWith("...")).toBe(true);
    expect(summarySource).toHaveLength((SUMMARY_TEXT_CODE_POINTS + 10) * 2);
    expect(previewSource).toBe("界".repeat(PREVIEW_TEXT_CODE_POINTS + 10));
  });

  it("rejects a discovered collection tool missing from the inventory", () => {
    expect(() =>
      assertCollectionToolsInventoried([
        "chorus_new_unbounded_list",
      ]),
    ).toThrow(/chorus_new_unbounded_list/);
  });

  it("documents and tests a finite limit for every non-page exemption", () => {
    const exemptions = Object.values(COLLECTION_TOOL_INVENTORY).filter(
      (entry) => entry.mode !== "page",
    );

    expect(exemptions.length).toBeGreaterThan(0);
    for (const entry of exemptions) {
      expect(entry.maximumRows).toBeGreaterThan(0);
      expect(entry.maximumRows).toBeLessThanOrEqual(MAX_PAGE_SIZE);
      expect(entry.reason.trim().length).toBeGreaterThan(10);
    }
  });

  it("marks every authoritative list that has no single-resource get", () => {
    const authoritativeTools = Object.entries(COLLECTION_TOOL_INVENTORY)
      .filter(([, entry]) => entry.detailSource === "list-authoritative")
      .map(([name]) => name)
      .sort();

    expect(authoritativeTools).toEqual([
      "chorus_get_activity",
      "chorus_get_comments",
      "chorus_get_notifications",
    ]);
  });
});
