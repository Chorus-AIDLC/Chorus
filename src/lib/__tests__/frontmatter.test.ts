import { describe, it, expect } from "vitest";
import { splitFrontmatter } from "@/lib/frontmatter";

/** The real spec-lite dated change-doc header shipped in 0.18.0. */
const SPEC_LITE_HEADER = `---
date: 2026-09-08
change: chorus-native-and-model-b
spec: ..                 # the durable spec-lite folder this change establishes
status: in-progress      # proposed | in-progress | done
proposalUuid:
---

# Chorus-native spec-lite

Body text.
`;

describe("splitFrontmatter", () => {
  describe("recognized frontmatter", () => {
    it("parses the spec-lite change-doc header in source order", () => {
      const { entries, body } = splitFrontmatter(SPEC_LITE_HEADER);

      expect(entries).toEqual([
        { key: "date", value: "2026-09-08" },
        { key: "change", value: "chorus-native-and-model-b" },
        { key: "spec", value: ".." },
        { key: "status", value: "in-progress" },
        { key: "proposalUuid", value: "" },
      ]);
      expect(entries?.map((e) => e.key)).toEqual([
        "date",
        "change",
        "spec",
        "status",
        "proposalUuid",
      ]);
      expect(body).toBe("\n# Chorus-native spec-lite\n\nBody text.\n");
      expect(body).not.toContain("---");
      expect(body).not.toContain("date:");
    });

    it("keeps an empty value as an empty string and still emits the entry", () => {
      const { entries } = splitFrontmatter(SPEC_LITE_HEADER);
      const proposalUuid = entries?.find((e) => e.key === "proposalUuid");

      expect(proposalUuid).toBeDefined();
      expect(proposalUuid?.value).toBe("");
    });

    it("strips a trailing comment from an unquoted value", () => {
      const { entries } = splitFrontmatter(
        "---\nstatus: in-progress      # proposed | in-progress | done\n---\n"
      );

      expect(entries).toEqual([{ key: "status", value: "in-progress" }]);
    });

    it("preserves a `#` inside a quoted value", () => {
      const { entries } = splitFrontmatter(
        `---\ntitle: "release #42 # notes"\nlabel: 'a # b'\n---\n`
      );

      expect(entries).toEqual([
        { key: "title", value: "release #42 # notes" },
        { key: "label", value: "a # b" },
      ]);
    });

    it("drops a trailing comment that follows a quoted value", () => {
      const { entries } = splitFrontmatter(
        `---\ntitle: "release #42"   # a trailing comment\n---\n`
      );

      expect(entries).toEqual([{ key: "title", value: "release #42" }]);
    });

    it("preserves a `#` that is not preceded by whitespace", () => {
      const { entries } = splitFrontmatter("---\ncolor: #fff\n---\n");

      expect(entries).toEqual([{ key: "color", value: "#fff" }]);
    });

    it("never coerces values — dates, numbers and booleans stay strings", () => {
      const { entries } = splitFrontmatter(
        "---\ndate: 2026-09-08\ncount: 42\nenabled: true\n---\n"
      );

      expect(entries).toEqual([
        { key: "date", value: "2026-09-08" },
        { key: "count", value: "42" },
        { key: "enabled", value: "true" },
      ]);
      entries?.forEach((entry) => expect(typeof entry.value).toBe("string"));
    });

    it("accepts `...` as the closing fence", () => {
      const { entries, body } = splitFrontmatter("---\nkey: value\n...\nbody\n");

      expect(entries).toEqual([{ key: "key", value: "value" }]);
      expect(body).toBe("body\n");
    });

    it("allows blank lines and comments between the fences", () => {
      const { entries } = splitFrontmatter(
        "---\n# a leading comment\n\ndate: 2026-09-08\n\n  # an indented comment\nstatus: done\n---\n"
      );

      expect(entries).toEqual([
        { key: "date", value: "2026-09-08" },
        { key: "status", value: "done" },
      ]);
    });

    it("accepts keys containing dots, dashes and underscores", () => {
      const { entries } = splitFrontmatter(
        "---\nsome.key: a\nsome-key: b\nsome_key: c\nKey9: d\n---\n"
      );

      expect(entries).toEqual([
        { key: "some.key", value: "a" },
        { key: "some-key", value: "b" },
        { key: "some_key", value: "c" },
        { key: "Key9", value: "d" },
      ]);
    });

    it("handles CRLF line endings", () => {
      const { entries, body } = splitFrontmatter(
        "---\r\ndate: 2026-09-08\r\n---\r\n# Title\r\n"
      );

      expect(entries).toEqual([{ key: "date", value: "2026-09-08" }]);
      expect(body).toBe("# Title\r\n");
    });

    it("keeps a value that itself contains a colon", () => {
      const { entries } = splitFrontmatter("---\nurl: https://example.com\n---\n");

      expect(entries).toEqual([{ key: "url", value: "https://example.com" }]);
    });
  });

  describe("body-less frontmatter", () => {
    it("returns the entries with an empty body when the content is only frontmatter", () => {
      const { entries, body } = splitFrontmatter(
        "---\ndate: 2026-09-08\nstatus: done\n---\n"
      );

      expect(entries).toEqual([
        { key: "date", value: "2026-09-08" },
        { key: "status", value: "done" },
      ]);
      expect(body).toBe("");
    });

    it("returns an empty body when the closing fence has no trailing newline", () => {
      const { entries, body } = splitFrontmatter("---\ndate: 2026-09-08\n---");

      expect(entries).toEqual([{ key: "date", value: "2026-09-08" }]);
      expect(body).toBe("");
    });
  });

  describe("incomplete (still-streaming) frontmatter", () => {
    const streamingChunks = [
      "---",
      "---\n",
      "---\ndate: 2026-09-08",
      "---\ndate: 2026-09-08\n",
      "---\ndate: 2026-09-08\nstatus: in-progress\n",
    ];

    it.each(streamingChunks)(
      "returns entries: null with the body byte-equal to the input for %j",
      (chunk) => {
        const result = splitFrontmatter(chunk);

        expect(result.entries).toBeNull();
        expect(result.body).toBe(chunk);
      }
    );

    it("snaps to a card once the closing fence arrives", () => {
      const partial = "---\ndate: 2026-09-08\nstatus: in-progress\n";
      expect(splitFrontmatter(partial).entries).toBeNull();

      const complete = `${partial}---\n`;
      expect(splitFrontmatter(complete).entries).toEqual([
        { key: "date", value: "2026-09-08" },
        { key: "status", value: "in-progress" },
      ]);
      expect(splitFrontmatter(complete).body).toBe("");
    });
  });

  describe("bail-outs — body is returned strictly unmodified", () => {
    const cases: Array<[string, string]> = [
      ["empty string", ""],
      ["plain content with no frontmatter", "# Title\n\nSome body text.\n"],
      [
        "a mid-document thematic break",
        "# Title\n\nBefore the rule.\n\n---\n\nAfter the rule.\n",
      ],
      [
        "a leading `---` followed by prose",
        "---\nThis is just a comment that opens with a rule.\n\nMore prose.\n",
      ],
      [
        "a leading `---` followed by prose and a second `---`",
        "---\nJust prose here, not metadata.\n---\n\nMore prose.\n",
      ],
      [
        "a nested mapping",
        "---\nauthor:\n  name: Ada\n  email: ada@example.com\n---\n\nBody.\n",
      ],
      [
        "a YAML list",
        "---\ntags:\n  - one\n  - two\n---\n\nBody.\n",
      ],
      [
        "an inline flow sequence",
        "---\ntags: [one, two]\n---\n\nBody.\n",
      ],
      [
        "an inline flow mapping",
        "---\nauthor: { name: Ada }\n---\n\nBody.\n",
      ],
      [
        "a block scalar value",
        "---\nnotes: |\n  line one\n  line two\n---\n\nBody.\n",
      ],
      [
        "a fence pair wrapping only blank lines and comments",
        "---\n\n# just a comment\n\n---\n\nBody.\n",
      ],
      [
        "a fence pair wrapping nothing at all",
        "---\n---\n\nBody.\n",
      ],
      [
        "a blank line before the opening fence",
        "\n---\ndate: 2026-09-08\n---\n\nBody.\n",
      ],
      [
        "leading whitespace before the opening fence",
        "  ---\ndate: 2026-09-08\n---\n\nBody.\n",
      ],
      [
        "a longer rule instead of a `---` fence",
        "----\ndate: 2026-09-08\n----\n\nBody.\n",
      ],
      [
        "trailing content on the opening fence line",
        "--- yaml\ndate: 2026-09-08\n---\n\nBody.\n",
      ],
      [
        "a key with a space in it",
        "---\nsome key: value\n---\n\nBody.\n",
      ],
      [
        "a key containing an unsupported character",
        "---\nsome@key: value\n---\n\nBody.\n",
      ],
      [
        "a bare URL line with no space after the colon",
        "---\nhttps://example.com\n---\n\nBody.\n",
      ],
      [
        "a line with no colon at all",
        "---\ndate: 2026-09-08\njust a sentence\n---\n\nBody.\n",
      ],
      [
        "a line starting with a colon",
        "---\n: value\n---\n\nBody.\n",
      ],
    ];

    it.each(cases)("leaves %s untouched", (_label, source) => {
      const result = splitFrontmatter(source);

      expect(result.entries).toBeNull();
      expect(result.body).toBe(source);
    });

    it("does not treat a thematic break inside the body as a fence", () => {
      const source = "Intro.\n\n---\n\nkey: value\n\n---\n";
      const result = splitFrontmatter(source);

      expect(result.entries).toBeNull();
      expect(result.body).toBe(source);
    });
  });
});
