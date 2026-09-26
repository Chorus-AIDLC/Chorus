// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { Streamdown } from "streamdown";
import { MarkdownContent } from "@/components/markdown-content";
import { ContentWithMentions } from "@/components/mention-renderer";
import { CITATION_REQUEST_TIMEOUT_MS } from "@/lib/reference-citation-store";
import en from "../../../messages/en.json";
import ja from "../../../messages/ja.json";
import ko from "../../../messages/ko.json";
import zh from "../../../messages/zh.json";

// The Markdown parser, sanitizer, renderer, tooltip and i18n are all real.
// Diagram generation/highlighting are covered by the existing plugin tests.
vi.mock("@/lib/streamdown-plugins", () => ({
  streamdownPluginsFor: () => ({}),
  streamdownControls: { mermaid: { fullscreen: true } },
}));

const uuid = "550e8400-e29b-41d4-a716-446655440000";
const other = "650e8400-e29b-41d4-a716-446655440000";
const markdown = `[1](ref:${uuid})`;
const reference = {
  uuid, title: "Evidence title", type: "docs", url: "https://example.com/evidence",
  notes: `Plain notes [2](ref:${other})`, targetType: "idea", targetUuid: other,
};
const fetchMock = vi.fn<typeof fetch>();
const ok = (data = reference) => new Response(JSON.stringify({ success: true, data }));
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={en}>{children}</NextIntlClientProvider>
);
const marker = () => document.querySelector<HTMLAnchorElement>("[data-citation-state]")!;
const ready = () => waitFor(() => expect(marker()?.getAttribute("data-citation-state")).toBe("ready"));
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  fetchMock.mockReset().mockImplementation(async () => ok());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
});

describe("real Markdown citation rendering", () => {
  it("loads direct UUIDs once across blocks and repeated uppercase UUIDs", async () => {
    const request = deferred();
    fetchMock.mockReturnValue(request.promise);
    render(<MarkdownContent>{`${markdown}\n\n[again](ref:${uuid.toUpperCase()})`}</MarkdownContent>, { wrapper });
    expect(marker().textContent).toBe("[1]");
    expect(marker().getAttribute("href")).toBeNull();
    expect(marker().getAttribute("aria-label")).toBe(en.references.citationLoading);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/api/references/${uuid}`, {
      credentials: "same-origin", cache: "no-store", signal: expect.any(AbortSignal),
    });
    await act(async () => request.resolve(ok()));
    await ready();
    const links = document.querySelectorAll("[data-citation-state]");
    expect([...links].map((link) => link.getAttribute("href"))).toEqual([reference.url, reference.url]);
    expect(marker().getAttribute("target")).toBe("_blank");
    expect(marker().getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("revalidates on keyboard focus and hover; notes are plain text", async () => {
    render(<MarkdownContent>{markdown}</MarkdownContent>, { wrapper });
    await ready();
    fetchMock.mockImplementation(async () => ok({ ...reference, title: "Updated title", url: "https://example.com/new" }));
    fireEvent.focus(marker());
    await waitFor(() => expect(marker().getAttribute("href")).toBe("https://example.com/new"));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Updated title");
    expect(tooltip.textContent).toContain(en.references.typeDocs);
    expect(tooltip.textContent).toContain("https://example.com/new");
    expect(tooltip.textContent).toContain(reference.notes);
    expect(fetchMock.mock.calls.every(([url]) => url === `/api/references/${uuid}`)).toBe(true);
    expect(tooltip.querySelector("[data-citation-state]")).toBeNull();
    fireEvent.blur(marker());
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    fireEvent.mouseEnter(marker());
    await waitFor(() => expect(marker().getAttribute("aria-label")).toBe(en.references.citationMissing));
    expect(marker().getAttribute("href")).toBeNull();
    expect(marker().getAttribute("tabindex")).toBe("0");
    expect(marker().className).toContain("text-muted-foreground");
  });

  it.each([404, 401, 403, 500, "network"] as const)("distinguishes %s and retries on focus", async (failure) => {
    fetchMock.mockImplementation(async () => {
      if (failure === "network") throw new Error("offline");
      return new Response(null, { status: failure });
    });
    render(<MarkdownContent>{markdown}</MarkdownContent>, { wrapper });
    const status = failure === 404 ? "missing" : "error";
    await waitFor(() => expect(marker().getAttribute("data-citation-state")).toBe(status));
    expect(marker().getAttribute("aria-label")).toBe(failure === 404 ? en.references.citationMissing : en.references.citationError);
    expect(marker().getAttribute("href")).toBeNull();
    fetchMock.mockImplementation(async () => ok());
    fireEvent.focus(marker());
    await ready();
    expect(marker().getAttribute("href")).toBe(reference.url);
  });

  it("revalidates mounted references when the window regains focus", async () => {
    render(<MarkdownContent>{`${markdown} ${markdown}`}</MarkdownContent>, { wrapper });
    await ready();
    const request = deferred();
    fetchMock.mockReturnValue(request.promise);
    fireEvent(window, new Event("focus"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A ready link remains usable while the refresh is pending (touch/click).
    expect(marker().getAttribute("href")).toBe(reference.url);
    await act(async () => request.resolve(new Response(null, { status: 404 })));
    await waitFor(() => expect(marker().getAttribute("data-citation-state")).toBe("missing"));
    expect([...document.querySelectorAll("[data-citation-state]")].every((node) => !node.hasAttribute("href"))).toBe(true);
  });

  it.each([401, 503, "network"] as const)("retains loaded details after a %s refresh failure and recovers", async (failure) => {
    render(<MarkdownContent>{markdown}</MarkdownContent>, { wrapper });
    await ready();
    fetchMock.mockImplementation(async () => {
      if (failure === "network") throw new Error("offline");
      return new Response(null, { status: failure });
    });
    fireEvent.focus(marker());
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toContain(en.references.citationRefreshError));
    expect(marker().getAttribute("href")).toBe(reference.url);
    expect(marker().getAttribute("data-citation-state")).toBe("ready");
    fetchMock.mockImplementation(async () => ok({ ...reference, title: "Recovered", url: "https://example.com/recovered" }));
    fireEvent.mouseEnter(marker());
    await waitFor(() => expect(marker().getAttribute("href")).toBe("https://example.com/recovered"));
    expect(screen.getByRole("tooltip").textContent).not.toContain(en.references.citationRefreshError);
  });

  it("times out a hung request, retries, and ignores its late response", async () => {
    vi.useFakeTimers();
    const hung = deferred();
    fetchMock.mockReturnValueOnce(hung.promise);
    render(<MarkdownContent>{markdown}</MarkdownContent>, { wrapper });
    const signal = fetchMock.mock.calls[0][1]?.signal;
    await act(async () => vi.advanceTimersByTimeAsync(CITATION_REQUEST_TIMEOUT_MS));
    expect(signal?.aborted).toBe(true);
    expect(marker().getAttribute("data-citation-state")).toBe("error");
    await act(async () => fireEvent.focus(marker()));
    expect(marker().getAttribute("data-citation-state")).toBe("ready");
    await act(async () => hung.resolve(new Response(null, { status: 404 })));
    expect(marker().getAttribute("href")).toBe(reference.url);
  });

  it("deduplicates requests across forty Markdown mounts on load and window focus", async () => {
    const request = deferred();
    fetchMock.mockImplementation(() => request.promise.then((response) => response.clone()));
    const text = `${markdown} [2](ref:${other}) [3](ref:750e8400-e29b-41d4-a716-446655440000)`;
    render(<>{Array.from({ length: 40 }, (_, i) => <MarkdownContent key={i}>{text}</MarkdownContent>)}</>, { wrapper });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => request.resolve(ok()));
    expect(document.querySelectorAll('[data-citation-state="ready"]')).toHaveLength(120);
    const refresh = deferred();
    fetchMock.mockImplementation(() => refresh.promise.then((response) => response.clone()));
    fireEvent(window, new Event("focus"));
    expect(fetchMock).toHaveBeenCalledTimes(6);
    await act(async () => refresh.resolve(ok()));
  });

  it("defers clipped/offscreen citations until visible or keyboard-focused", async () => {
    const observers: IntersectionObserverCallback[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { observers.push(callback); }
      observe() {} disconnect() {}
    });
    render(<MarkdownContent>{markdown}</MarkdownContent>, { wrapper });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => observers[0]([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => observers[0]([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver));
    await ready();
  });

  it("ignores old responses after UUID changes and after unmount, without a global cache", async () => {
    const old = deferred();
    fetchMock.mockReturnValueOnce(old.promise);
    const view = render(<MarkdownContent>{markdown}</MarkdownContent>, { wrapper });
    await act(async () => view.rerender(<MarkdownContent>{`[2](ref:${other})`}</MarkdownContent>));
    await ready();
    await act(async () => old.resolve(ok({ ...reference, url: "https://example.com/stale" })));
    expect(marker().getAttribute("href")).toBe(reference.url);
    view.unmount();
    fetchMock.mockImplementation(async () => ok({ ...reference, title: "New session" }));
    render(<MarkdownContent>{markdown}</MarkdownContent>, { wrapper });
    await ready();
    expect(marker().getAttribute("aria-label")).toContain("New session");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("disables legacy non-HTTP URLs while retaining details", async () => {
    fetchMock.mockImplementation(async () => ok({ ...reference, url: "javascript:alert(1)" }));
    render(<MarkdownContent>{markdown}</MarkdownContent>, { wrapper });
    await ready();
    expect(marker().getAttribute("href")).toBeNull();
    expect(marker().getAttribute("aria-label")).toContain(en.references.citationUnsafe);
  });

  it("discards an in-flight request when the entire Markdown tree unmounts", async () => {
    const abandoned = deferred();
    fetchMock.mockReturnValueOnce(abandoned.promise);
    const view = render(<MarkdownContent>{markdown}</MarkdownContent>, { wrapper });
    const signal = fetchMock.mock.calls[0][1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    render(<MarkdownContent>{markdown}</MarkdownContent>, { wrapper });
    await ready();
    await act(async () => abandoned.resolve(new Response(null, { status: 404 })));
    expect(marker().getAttribute("data-citation-state")).toBe("ready");
    expect(marker().getAttribute("href")).toBe(reference.url);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([{ locale: "en", messages: en }, { locale: "ja", messages: ja },
    { locale: "ko", messages: ko }, { locale: "zh", messages: zh }])(
    "localizes disabled states in $locale",
    async ({ locale, messages }) => {
      fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
      render(
        <NextIntlClientProvider locale={locale} messages={messages}>
          <MarkdownContent>{markdown}</MarkdownContent>
        </NextIntlClientProvider>,
      );
      expect(marker().getAttribute("aria-label")).toBe(messages.references.citationLoading);
      await waitFor(() => expect(marker().getAttribute("aria-label")).toBe(messages.references.citationMissing));
    },
  );

  it("keeps ordinary links identical to Streamdown, including its safety dialog", async () => {
    const text = "[ordinary](https://example.com) [mail](mailto:hi@example.com) [bad](javascript:alert%281%29) [empty]()";
    const baseline = render(<Streamdown>{text}</Streamdown>);
    const expected = baseline.container.innerHTML;
    baseline.unmount();
    const result = render(<MarkdownContent>{text}</MarkdownContent>, { wrapper });
    expect(result.container.innerHTML).toBe(expected);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "ordinary" }));
    expect(await screen.findByRole("button", { name: "Open link" })).toBeTruthy();
  });

  it("preserves caller anchor overrides alongside references", async () => {
    render(<MarkdownContent components={{ a: ({ children, href }) => <a href={href} data-custom-link>{children}</a> }}>
      {`${markdown} [normal](https://example.com)`}
    </MarkdownContent>, { wrapper });
    await ready();
    expect(document.querySelector("[data-custom-link]")?.textContent).toBe("normal");
    expect(document.querySelectorAll("[data-custom-link]")).toHaveLength(1);
  });

  it("leaves code, escapes, malformed refs and Mermaid fences out of citation parsing", () => {
    const content = [
      `\`${markdown}\``, `\\[1](ref:${uuid})`, `\`\`\`text\n${markdown}\n\`\`\``,
      `\`\`\`mermaid\ngraph TD; A-->B\n\`\`\``, "[bad](ref:not-a-uuid)", `[bad2](ref:${uuid}?x=1)`,
    ].join("\n\n");
    const { container } = render(<MarkdownContent>{content}</MarkdownContent>, { wrapper });
    expect(container.querySelector("[data-citation-state]")).toBeNull();
    expect(container.querySelector('code[data-language="mermaid"], [data-language="mermaid"]')).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([`ref:${uuid.slice(0, -1)}`, "ref:not-a-uuid", `ref:${uuid}?x=1`, `ref:${uuid}#x`, `REF:${uuid}/`])(
    "renders malformed %s as non-interactive text, never an empty href",
    (href) => {
      const { container } = render(<MarkdownContent>{`[bad](${href})`}</MarkdownContent>, { wrapper });
      expect(screen.getByText(/^bad/).closest("a,button,[role=link]")).toBeNull();
      expect(container.querySelector("a")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("keeps unrelated code blocks mounted when citation content changes", async () => {
    const view = render(<MarkdownContent>{`${markdown}\n\n\`\`\`text\nunchanged\n\`\`\``}</MarkdownContent>, { wrapper });
    await ready();
    const code = view.container.querySelector("pre");
    await act(async () => view.rerender(<MarkdownContent>{`[2](ref:${other})\n\n\`\`\`text\nunchanged\n\`\`\``}</MarkdownContent>));
    await ready();
    expect(marker().textContent).toBe("[2]");
    expect(view.container.querySelector("pre")).toBe(code);
  });

  it("preserves citation identity and avoids refetching when surrounding prose grows", async () => {
    const view = render(<MarkdownContent>{`Evidence ${markdown} says`}</MarkdownContent>, { wrapper });
    await ready();
    const original = marker();
    for (let i = 1; i <= 5; i++) {
      await act(async () => view.rerender(<MarkdownContent>{`Evidence ${markdown} says ${"more ".repeat(i)}`}</MarkdownContent>));
      expect(marker()).toBe(original);
      expect(view.container.textContent).toContain("more ".repeat(i).trim());
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("composes frontmatter, literal mention custom tags and citations, including theme changes", async () => {
    const text = `---\ntitle: Metadata\n---\n@[agent_name](agent:${other}) ${markdown}`;
    const { container } = render(
      <ContentWithMentions renderMention={(mention) => <button>{mention.displayName}</button>}>{text}</ContentWithMentions>,
      { wrapper },
    );
    await ready();
    expect(screen.getByText("Metadata")).toBeTruthy();
    expect(screen.getByRole("button", { name: "agent_name" })).toBeTruthy();
    expect(container.querySelector("em")).toBeNull();
    await act(async () => document.documentElement.classList.add("dark"));
    await ready();
    expect(screen.getByRole("button", { name: "agent_name" })).toBeTruthy();
    expect(marker().textContent).toBe("[1]");
  });
});
