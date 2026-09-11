// @vitest-environment jsdom
//
// UI tests for the frontmatter metadata card (render-markdown-frontmatter-card).
//
// vitest.config.ts sets `environment: 'node'` globally, so the docblock above is
// load-bearing: without it `document` is undefined and every case here fails.
// The first test asserts jsdom is actually active so a lost docblock is loud.
//
// Covers:
//  - FrontmatterCard renders <dl>/<dt>/<dd> rows with an em-dash for empty values,
//  - styling uses semantic tokens only (no hex, no fixed-palette classes),
//  - MarkdownContent renders the card above Streamdown and hands it the stripped body,
//  - the no-frontmatter regression guarantee: Streamdown receives the argument string
//    by reference-identity and no card is rendered,
//  - graceful degradation for a still-streaming block and for body-less frontmatter,
//  - every currently-forwarded Streamdown prop is still forwarded, INCLUDING the
//    `key={isDark ? "dark" : "light"}` remount (asserted behaviorally: a theme flip
//    must unmount + remount the subtree, which is what repaints mermaid).

import React from "react";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

import { splitFrontmatter } from "@/lib/frontmatter";
import { streamdownControls, streamdownPluginsFor } from "@/lib/streamdown-plugins";

// Resolve real i18n strings from en.json so the accessible label is the shipped one.
vi.mock("next-intl", async () => {
  const en = (await import("../../../messages/en.json")).default as Record<string, unknown>;
  return {
    useTranslations: (ns?: string) => (key: string) => {
      const full = ns ? `${ns}.${key}` : key;
      let node: unknown = en;
      for (const p of full.split(".")) {
        node =
          node && typeof node === "object" && p in (node as Record<string, unknown>)
            ? (node as Record<string, unknown>)[p]
            : undefined;
      }
      return typeof node === "string" ? node : full;
    },
  };
});

interface CapturedRender {
  props: Record<string, unknown>;
  mountId: number;
}

const renders: CapturedRender[] = [];
const mounts: number[] = [];
const unmounts: number[] = [];
let nextMountId = 0;

// Stand-in for Streamdown that records the props it is handed. React does not
// pass `key` through props, so the remount key is verified via mount/unmount
// bookkeeping instead — a mere re-render would reuse the same mountId.
vi.mock("streamdown", () => ({
  Streamdown: (props: Record<string, unknown>) => {
    const idRef = React.useRef<number | null>(null);
    if (idRef.current === null) idRef.current = nextMountId++;
    const mountId = idRef.current;
    renders.push({ props, mountId });
    React.useEffect(() => {
      mounts.push(mountId);
      return () => {
        unmounts.push(mountId);
      };
    }, [mountId]);
    return <div data-testid="streamdown">{String(props.children)}</div>;
  },
}));

// Imported after the mock so MarkdownContent binds to the stand-in.
const { FrontmatterCard } = await import("@/components/frontmatter-card");
const { MarkdownContent } = await import("@/components/markdown-content");

const lastRender = () => renders[renders.length - 1];

// The `dark` class is observed via MutationObserver, whose callback runs on a
// microtask — so the flip has to be awaited inside act(), not just applied.
async function setDark(dark: boolean) {
  await act(async () => {
    document.documentElement.classList.toggle("dark", dark);
    await Promise.resolve();
  });
}

beforeEach(() => {
  renders.length = 0;
  mounts.length = 0;
  unmounts.length = 0;
  nextMountId = 0;
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("test environment", () => {
  it("runs in jsdom (the @vitest-environment docblock is present)", () => {
    expect(typeof document).toBe("object");
    expect(typeof MutationObserver).toBe("function");
  });
});

describe("FrontmatterCard", () => {
  it("renders each entry as a dt/dd pair inside a labelled definition list", () => {
    const { container } = render(
      <FrontmatterCard
        entries={[
          { key: "date", value: "2026-09-08" },
          { key: "status", value: "in-progress" },
        ]}
      />,
    );

    // The label comes from i18n (messages/markdown.frontmatterLabel).
    const region = screen.getByRole("region", { name: "Document metadata" });
    expect(region).toBeTruthy();

    expect(container.querySelectorAll("dl")).toHaveLength(1);
    const terms = [...container.querySelectorAll("dt")].map((n) => n.textContent);
    const defs = [...container.querySelectorAll("dd")].map((n) => n.textContent);
    expect(terms).toEqual(["date", "status"]);
    expect(defs).toEqual(["2026-09-08", "in-progress"]);
  });

  it("renders an em-dash placeholder for an empty value instead of collapsing the row", () => {
    const { container } = render(
      <FrontmatterCard entries={[{ key: "proposalUuid", value: "" }]} />,
    );

    const dd = container.querySelector("dd");
    expect(dd?.textContent).toBe("—");
    // The row still exists and is still keyed by its <dt>.
    expect(container.querySelector("dt")?.textContent).toBe("proposalUuid");
  });

  it("does not translate frontmatter keys or values", () => {
    // A key that collides with an i18n namespace must still render verbatim.
    const { container } = render(
      <FrontmatterCard entries={[{ key: "common.save", value: "common.save" }]} />,
    );
    expect(container.querySelector("dt")?.textContent).toBe("common.save");
    expect(container.querySelector("dd")?.textContent).toBe("common.save");
  });

  it("renders repeated keys as distinct rows", () => {
    const { container } = render(
      <FrontmatterCard
        entries={[
          { key: "tag", value: "a" },
          { key: "tag", value: "b" },
        ]}
      />,
    );
    expect(container.querySelectorAll("dd")).toHaveLength(2);
  });

  it("styles itself with semantic tokens only — no hex, no fixed-palette classes", () => {
    const { container } = render(
      <FrontmatterCard entries={[{ key: "date", value: "2026-09-08" }]} />,
    );

    const classes = [...container.querySelectorAll<HTMLElement>("*")]
      .map((n) => n.className)
      .join(" ");

    // Hardcoded hex in any utility (bg-/text-/border-/ring-/hover:… ) is a
    // dual-theme bug: it cannot follow the .dark palette.
    expect(classes).not.toMatch(/-\[#/);
    // Fixed-palette Tailwind colors would need a `dark:` variant to be legible;
    // the card is required to need none.
    expect(classes).not.toMatch(/\b(bg|text|border|ring)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/);
    expect(classes).not.toMatch(/\bdark:/);
    // And it does use the semantic tokens the design calls for.
    expect(classes).toMatch(/\bborder-border\b/);
    expect(classes).toMatch(/\bbg-muted\/40\b/);
    expect(classes).toMatch(/\btext-muted-foreground\b/);
    expect(classes).toMatch(/\btext-foreground\b/);
    // Long UUIDs / paths must not overflow the panel.
    expect(classes).toMatch(/\bbreak-words\b/);
  });
});

describe("MarkdownContent frontmatter integration", () => {
  const WITH_FRONTMATTER = [
    "---",
    "date: 2026-09-08",
    "change: chorus-native-and-model-b",
    "status: in-progress      # proposed | in-progress | done",
    "proposalUuid:",
    "---",
    "",
    "# Title",
    "",
    "body text",
    "",
  ].join("\n");

  it("renders the card above Streamdown and passes it the stripped body", () => {
    const { container } = render(<MarkdownContent>{WITH_FRONTMATTER}</MarkdownContent>);

    const card = screen.getByRole("region", { name: "Document metadata" });
    const streamdown = screen.getByTestId("streamdown");
    // Card precedes the body in document order.
    expect(card.compareDocumentPosition(streamdown) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Trailing `#` comment stripped from the unquoted value; empty value shown.
    const defs = [...container.querySelectorAll("dd")].map((n) => n.textContent);
    expect(defs).toEqual(["2026-09-08", "chorus-native-and-model-b", "in-progress", "—"]);

    // Streamdown gets the body only — no fences, no key/value prose.
    const body = lastRender().props.children as string;
    expect(body).toBe(splitFrontmatter(WITH_FRONTMATTER).body);
    expect(body).not.toContain("---");
    expect(body).not.toContain("date: 2026-09-08");
    expect(body).toContain("# Title");
  });

  it("no-frontmatter content: no card, and Streamdown gets the argument string itself", () => {
    const plain = "body text\n\n---\n\nmore body\n";
    render(<MarkdownContent>{plain}</MarkdownContent>);

    expect(screen.queryByRole("region", { name: "Document metadata" })).toBeNull();
    // Reference identity, not just equality: the regression guarantee is that the
    // untouched string flows straight through to Streamdown.
    expect(lastRender().props.children).toBe(plain);
  });

  it("degrades gracefully while the closing fence has not streamed in yet", () => {
    const streaming = "---\ndate: 2026-09-08\nstatus: in-prog";
    expect(() => render(<MarkdownContent>{streaming}</MarkdownContent>)).not.toThrow();

    // Still ordinary body: no card yet, and the text is byte-identical.
    expect(screen.queryByRole("region", { name: "Document metadata" })).toBeNull();
    expect(lastRender().props.children).toBe(streaming);
  });

  it("snaps to a card once the closing fence arrives", () => {
    const streaming = "---\ndate: 2026-09-08\n";
    const { rerender } = render(<MarkdownContent>{streaming}</MarkdownContent>);
    expect(screen.queryByRole("region", { name: "Document metadata" })).toBeNull();

    rerender(<MarkdownContent>{`${streaming}---\n\nbody\n`}</MarkdownContent>);
    expect(screen.getByRole("region", { name: "Document metadata" })).toBeTruthy();
    expect(lastRender().props.children).toBe("\nbody\n");
  });

  it("body-less frontmatter renders the card with an empty body and no error", () => {
    const onlyFrontmatter = "---\ndate: 2026-09-08\n---\n";
    expect(() => render(<MarkdownContent>{onlyFrontmatter}</MarkdownContent>)).not.toThrow();

    expect(screen.getByRole("region", { name: "Document metadata" })).toBeTruthy();
    expect(lastRender().props.children).toBe("");
  });
});

describe("MarkdownContent prop forwarding (regression guard)", () => {
  it("forwards every Streamdown prop, with and without frontmatter", () => {
    const components = { p: () => null } as never;
    const allowedTags = { "chorus-mention": ["data-uuid"] };
    const literalTagContent = ["chorus-mention"];

    for (const content of ["plain body\n", "---\ndate: 2026-09-08\n---\n\nbody\n"]) {
      cleanup();
      renders.length = 0;
      render(
        <MarkdownContent
          components={components}
          allowedTags={allowedTags}
          literalTagContent={literalTagContent}
        >
          {content}
        </MarkdownContent>,
      );

      const { props } = lastRender();
      expect(props.plugins).toEqual(streamdownPluginsFor(false));
      expect(props.controls).toBe(streamdownControls);
      expect(props.mermaid).toEqual({ config: { theme: "default" } });
      expect(props.components).toBe(components);
      expect(props.allowedTags).toBe(allowedTags);
      expect(props.literalTagContent).toBe(literalTagContent);
    }
  });

  it("keeps the theme remount key: a dark flip unmounts and rebuilds the subtree", async () => {
    render(<MarkdownContent>{"---\ndate: 2026-09-08\n---\n\n```mermaid\ngraph TD\n```\n"}</MarkdownContent>);

    const firstMount = lastRender().mountId;
    expect(mounts).toEqual([firstMount]);
    expect(unmounts).toEqual([]);
    expect(lastRender().props.mermaid).toEqual({ config: { theme: "default" } });

    await setDark(true);

    // The `key={isDark ? "dark" : "light"}` flip must tear the subtree down —
    // that remount, not the `mermaid` prop alone, is what repaints cached
    // diagrams. If a fragment wrapper ever swallows the key this fails.
    const secondMount = lastRender().mountId;
    expect(secondMount).not.toBe(firstMount);
    expect(unmounts).toEqual([firstMount]);
    expect(mounts).toEqual([firstMount, secondMount]);

    // Theme-aware props follow, and the card is still above the body.
    expect(lastRender().props.mermaid).toEqual({ config: { theme: "dark" } });
    expect(lastRender().props.plugins).toEqual(streamdownPluginsFor(true));
    expect(screen.getByRole("region", { name: "Document metadata" })).toBeTruthy();
  });
});
