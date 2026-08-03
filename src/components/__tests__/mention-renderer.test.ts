// Unit tests for the CLIENT mention parser's pin-suffix support
// (src/components/mention-renderer.tsx). The internal `parseMentions` is exercised
// through the exported `extractMentions`, which runs the same regex + shared
// `decodePinSuffix` codec and emits the `ParsedMentionRef` shape — the exact parse
// contract this task must guarantee (pinned recognized, non-pinned byte-compatible).

import { describe, it, expect } from "vitest";
import {
  extractMentions,
  hasMentions,
  preprocessMentions,
  preprocessMentionsAsTags,
  type ParsedMentionRef,
} from "@/components/mention-renderer";

const AGENT = "abcdef12-3456-7890-abcd-ef1234567890";
const USER = "11111111-2222-3333-4444-555555555555";

describe("client mention parser — pin suffix support", () => {
  it("parses a pinned agent token into {uuid, pinnedHost, pinnedCwd} (the broken-text bug is fixed)", () => {
    const text = `hey @[DevBot](agent:${AGENT}?cwd=%2Fwork&host=prod) please look`;
    // The pinned token IS recognized (previously it fell through as raw text).
    expect(hasMentions(text)).toBe(true);

    const refs = extractMentions(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual<ParsedMentionRef>({
      type: "agent",
      uuid: AGENT,
      displayName: "DevBot",
      pinnedHost: "prod",
      pinnedCwd: "/work",
    });
  });

  it("parses a non-pinned token with NO pin fields (byte-compatible with legacy shape)", () => {
    const refs = extractMentions(`ping @[DevBot](agent:${AGENT}) now`);
    expect(refs).toHaveLength(1);
    // Object-identical to the legacy three-field shape: the pin keys must be ABSENT,
    // not present-with-null.
    expect(refs[0]).toEqual({
      type: "agent",
      uuid: AGENT,
      displayName: "DevBot",
    });
    expect("pinnedHost" in refs[0]).toBe(false);
    expect("pinnedCwd" in refs[0]).toBe(false);
  });

  it("preserves the runtime cwd marker for comment liveness", () => {
    const refs = extractMentions(
      `@[DevBot](agent:${AGENT}?cwd=%2Fwork%2Fdynamic&host=prod&runtime=1)`,
    );
    expect(refs[0]).toEqual<ParsedMentionRef>({
      type: "agent",
      uuid: AGENT,
      displayName: "DevBot",
      pinnedHost: "prod",
      pinnedCwd: "/work/dynamic",
      runtimeCwd: true,
    });
  });

  it("parses an unknown-path pin (cwd=&host=…) as pinnedCwd:null, pinnedHost set", () => {
    const refs = extractMentions(`@[CI](agent:${AGENT}?cwd=&host=ci-runner)`);
    expect(refs[0]).toEqual<ParsedMentionRef>({
      type: "agent",
      uuid: AGENT,
      displayName: "CI",
      pinnedHost: "ci-runner",
      pinnedCwd: null,
    });
  });

  it("parses an unknown-host pin (host=) as pinnedHost:'' (the unknown-host sentinel)", () => {
    const refs = extractMentions(`@[Srv](agent:${AGENT}?cwd=%2Fsrv%2Fapp&host=)`);
    expect(refs[0]).toEqual<ParsedMentionRef>({
      type: "agent",
      uuid: AGENT,
      displayName: "Srv",
      pinnedHost: "",
      pinnedCwd: "/srv/app",
    });
  });

  it("parses user mentions (with no pin) exactly as before", () => {
    const refs = extractMentions(`cc @[Alice](user:${USER})`);
    expect(refs[0]).toEqual({
      type: "user",
      uuid: USER,
      displayName: "Alice",
    });
  });

  it("recognizes an uppercase-hex UUID token (case-insensitive)", () => {
    const upper = AGENT.toUpperCase();
    const text = `@[DevBot](agent:${upper})`;
    expect(hasMentions(text)).toBe(true);
    const refs = extractMentions(text);
    // uuid is normalized to lowercase (mirrors the server parser).
    expect(refs[0].uuid).toBe(AGENT);
  });

  it("parses a mix of pinned, non-pinned, and user tokens in one body", () => {
    const text =
      `@[A](agent:${AGENT}?cwd=%2Fa&host=h1) and @[B](agent:${AGENT}) and @[C](user:${USER})`;
    const refs = extractMentions(text);
    expect(refs).toEqual<ParsedMentionRef[]>([
      { type: "agent", uuid: AGENT, displayName: "A", pinnedHost: "h1", pinnedCwd: "/a" },
      { type: "agent", uuid: AGENT, displayName: "B" },
      { type: "user", uuid: USER, displayName: "C" },
    ]);
  });
});

// ── Comment-path React-native preprocessing vs. the byte-stable default path ──
//
// Task 3 (the integration task) moves the COMMENT surface off imperative DOM
// injection onto a React-native path: ContentWithMentions, given the opt-in
// `renderMention` prop, preprocesses mentions into `<chorus-mention>` custom tags
// (which Streamdown renders through a `components` override as real React nodes —
// e.g. an interactive MentionBadge). CRITICAL constraint (q6 = comments only):
// every OTHER surface (idea/proposal/task/document descriptions) keeps the legacy
// zero-width-placeholder DOM-injection path BYTE-STABLE. These tests pin both the
// new comment-path output AND the unchanged default-path output without mounting
// the heavy Streamdown renderer.

describe("default-path preprocessing (every NON-comment surface) is byte-stable", () => {
  const PLACEHOLDER_RE = /​​MENTION_(\d+)​​/;

  it("emits the legacy zero-width placeholders — NOT chorus-mention tags", () => {
    const text = `hi @[DevBot](agent:${AGENT}) and @[Alice](user:${USER})`;
    const { processed, mentions } = preprocessMentions(text);

    // The DOM-injection path must keep producing zero-width placeholders, and must
    // NOT leak the comment-only custom tag onto other surfaces.
    expect(processed).not.toContain("chorus-mention");
    expect(PLACEHOLDER_RE.test(processed)).toBe(true);
    // Both mentions captured, index-aligned.
    expect(mentions).toHaveLength(2);
    expect(mentions[0]).toMatchObject({ type: "agent", uuid: AGENT });
    expect(mentions[1]).toMatchObject({ type: "user", uuid: USER });
  });

  it("preserves a pinned token's pin fields in the default path", () => {
    const { mentions } = preprocessMentions(
      `@[DevBot](agent:${AGENT}?cwd=%2Fwork&host=prod)`,
    );
    expect(mentions[0]).toMatchObject({
      type: "agent",
      uuid: AGENT,
      pinnedHost: "prod",
      pinnedCwd: "/work",
    });
  });
});

describe("comment-path preprocessing (React-native) emits chorus-mention tags", () => {
  it("replaces each mention with an indexed <chorus-mention> tag and parses refs", () => {
    const text = `hi @[DevBot](agent:${AGENT}) and @[Alice](user:${USER})`;
    const { processed, mentions } = preprocessMentionsAsTags(text);

    // Custom tags, index-aligned with the parsed refs.
    expect(processed).toContain(`<chorus-mention idx="0">@DevBot</chorus-mention>`);
    expect(processed).toContain(`<chorus-mention idx="1">@Alice</chorus-mention>`);
    // No leftover zero-width placeholders on the comment path.
    expect(processed).not.toContain("​");
    expect(mentions).toEqual<ParsedMentionRef[]>([
      { type: "agent", uuid: AGENT, displayName: "DevBot" },
      { type: "user", uuid: USER, displayName: "Alice" },
    ]);
  });

  it("carries the pin fields for a pinned agent mention (badge reads them)", () => {
    const { mentions } = preprocessMentionsAsTags(
      `@[DevBot](agent:${AGENT}?cwd=%2Fwork&host=prod)`,
    );
    expect(mentions[0]).toEqual<ParsedMentionRef>({
      type: "agent",
      uuid: AGENT,
      displayName: "DevBot",
      pinnedHost: "prod",
      pinnedCwd: "/work",
    });
  });

  it("escapes <,>,& in a display name so it can't break out of the tag", () => {
    const { processed } = preprocessMentionsAsTags(
      `@[<b>&Bot</b>](agent:${AGENT})`,
    );
    expect(processed).toContain(
      `<chorus-mention idx="0">@&lt;b&gt;&amp;Bot&lt;/b&gt;</chorus-mention>`,
    );
  });

  it("leaves non-mention markdown untouched (mentions inside prose)", () => {
    const text = `**bold** then @[DevBot](agent:${AGENT}) in a *list*`;
    const { processed } = preprocessMentionsAsTags(text);
    // Surrounding markdown is preserved verbatim; only the token is swapped.
    expect(processed).toBe(
      `**bold** then <chorus-mention idx="0">@DevBot</chorus-mention> in a *list*`,
    );
  });
});
