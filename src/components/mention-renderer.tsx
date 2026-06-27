"use client";

import React from "react";

import { MarkdownContent } from "@/components/markdown-content";
import type { Components } from "streamdown";
// Reuse the SHARED pin codec (pure, dependency-free) so the client parser and the
// server mention service can never drift on how the `?cwd=…&host=…` suffix decodes.
import { decodePinSuffix } from "@/lib/mention-format";

/**
 * Regex to match `@[DisplayName](type:uuid)` patterns in text, with an OPTIONAL
 * pinned-instance suffix `?cwd=…&host=…` INSIDE the parens (cwd-addressable
 * instances). This is byte-identical in source to the SERVER parser's
 * `MENTION_REGEX` (src/services/mention.service.ts) so the client recognizes the
 * exact same set of tokens the server produces — including pinned ones.
 * - Group 1 (DisplayName): any non-`]` characters
 * - Group 2 (type): user | agent
 * - Group 3 (uuid): a strict UUID
 * - Group 4 (pin): the raw pin query string after `?` (or undefined when unpinned),
 *   matched as "everything up to the closing paren" — the codec keeps the payload
 *   paren-free by percent-escaping `(`/`)`.
 *
 * NOTE (bug fix): the previous client regex `/@\[([^\]]+)\]\((user|agent):([a-f0-9-]+)\)/g`
 * could NOT match a pinned token — the `?…` defeated the trailing `)` — so pinned
 * mentions rendered as broken raw text. The optional 4th group fixes that while
 * leaving un-pinned tokens parsed exactly as before.
 */
const MENTION_REGEX =
  /@\[([^\]]+)\]\((user|agent):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?([^)]*))?\)/gi;

/**
 * A parsed mention's reference shape, aligned with `MentionRef`
 * (src/services/mention.service.ts): `type`, `uuid`, `displayName`, plus the
 * OPTIONAL pinned-instance `pinnedHost`/`pinnedCwd`. The pin fields are present
 * ONLY for a pinned token — an un-pinned token omits them entirely, so its shape
 * is object-identical to before this change.
 */
export interface ParsedMentionRef {
  type: "user" | "agent";
  uuid: string;
  displayName: string;
  pinnedHost?: string | null;
  pinnedCwd?: string | null;
}

interface MentionPart {
  type: "text" | "mention";
  content: string;
  mentionType?: "user" | "agent";
  mentionUuid?: string;
  // Pinned-instance fields, present only when the matched token was pinned
  // (mirrors ParsedMentionRef / MentionRef — absent on un-pinned tokens).
  pinnedHost?: string | null;
  pinnedCwd?: string | null;
}

function parseMentions(text: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let lastIndex = 0;

  const regex = new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags);
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        type: "text",
        content: text.slice(lastIndex, match.index),
      });
    }

    // Decode the optional pin suffix (group 4) via the shared codec. Attach the
    // pin fields ONLY when present, keeping un-pinned parts byte-identical to the
    // legacy shape (mirrors the server parser in mention.service.ts).
    const { pinnedHost, pinnedCwd } = decodePinSuffix(match[4]);
    const part: MentionPart = {
      type: "mention",
      content: match[1],
      mentionType: match[2].toLowerCase() as "user" | "agent",
      mentionUuid: match[3].toLowerCase(),
    };
    if (pinnedHost !== null || pinnedCwd !== null) {
      part.pinnedHost = pinnedHost;
      part.pinnedCwd = pinnedCwd;
    }
    parts.push(part);

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({
      type: "text",
      content: text.slice(lastIndex),
    });
  }

  return parts;
}

// Unique placeholder prefix that won't appear in normal content
const MENTION_PLACEHOLDER_PREFIX = "\u200B\u200BMENTION_";
const MENTION_PLACEHOLDER_SUFFIX = "\u200B\u200B";
const MENTION_PLACEHOLDER_REGEX = /\u200B\u200BMENTION_(\d+)\u200B\u200B/g;

/**
 * Pre-process content: replace @[Name](type:uuid) with placeholders
 * so markdown renderers don't mangle the mention syntax.
 *
 * This is the DEFAULT (non-comment) path's preprocessing. Exported so the
 * byte-stability test can assert it is unchanged by the comment-path addition —
 * its placeholder output must remain identical for every other surface.
 */
export function preprocessMentions(content: string): {
  processed: string;
  mentions: Array<{
    displayName: string;
    type: string;
    uuid: string;
    pinnedHost?: string | null;
    pinnedCwd?: string | null;
  }>;
} {
  const mentions: Array<{
    displayName: string;
    type: string;
    uuid: string;
    pinnedHost?: string | null;
    pinnedCwd?: string | null;
  }> = [];
  const regex = new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags);

  // The 4th group (`pin`) is the raw pin query string (or undefined) — decode it
  // via the shared codec and attach pin fields only when present (un-pinned
  // placeholders stay byte-identical).
  const processed = content.replace(regex, (_match, name, type, uuid, pin) => {
    const index = mentions.length;
    const { pinnedHost, pinnedCwd } = decodePinSuffix(pin);
    const entry: {
      displayName: string;
      type: string;
      uuid: string;
      pinnedHost?: string | null;
      pinnedCwd?: string | null;
    } = { displayName: name, type, uuid };
    if (pinnedHost !== null || pinnedCwd !== null) {
      entry.pinnedHost = pinnedHost;
      entry.pinnedCwd = pinnedCwd;
    }
    mentions.push(entry);
    return `${MENTION_PLACEHOLDER_PREFIX}${index}${MENTION_PLACEHOLDER_SUFFIX}`;
  });

  return { processed, mentions };
}

// ── React-native mention rendering (opt-in, comment path only) ──────────────
//
// The default ContentWithMentions path above renders mentions via imperative DOM
// injection (MentionPostProcessor: document.createElement spans). That cannot host
// an interactive React component (a Radix Popover with state/handlers), so the
// comment surface needs a React-native path: mentions become real React nodes.
//
// Approach: instead of a zero-width text placeholder, preprocess each mention into
// a `<chorus-mention idx="N">@Name</chorus-mention>` custom inline TAG, then let
// Streamdown render that tag through a `components` override (markdown structure
// stays fully intact — a mention inside a list/heading/bold still works, unlike
// splitting the body at mention boundaries). `literalTagContent` keeps the tag's
// child label out of the markdown parser; `allowedTags` whitelists it through the
// sanitizer. This is gated behind the opt-in `renderMention` prop so EVERY OTHER
// surface keeps the byte-stable DOM-injection path untouched (q6 = comments only).

const MENTION_TAG = "chorus-mention";
const MENTION_TAG_ATTR = "idx";

/**
 * The parsed mention shape handed to a `renderMention` render-prop — a
 * `ParsedMentionRef` plus its stable index in the body (so the consumer can key
 * the node). This is the contract the comment path renders against.
 */
export interface RenderMentionArg extends ParsedMentionRef {
  index: number;
}

/**
 * Pre-process content for the React-native path: replace each `@[Name](type:uuid?…)`
 * with a `<chorus-mention idx="N">@Name</chorus-mention>` custom tag. Returns the
 * processed markdown plus the parsed mention refs (index-aligned with the `idx`
 * attribute). The display label is escaped of `<`/`>`/`&` so a name can never break
 * out of the tag; the badge re-derives its own label from the ref's displayName.
 *
 * Exported for the byte-stability test: a test can assert the comment path emits
 * `<chorus-mention>` tags WITHOUT mounting the heavy Streamdown renderer, and that
 * the legacy `preprocessMentions` (every other surface) is left unchanged.
 */
export function preprocessMentionsAsTags(content: string): {
  processed: string;
  mentions: ParsedMentionRef[];
} {
  const mentions: ParsedMentionRef[] = [];
  const regex = new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags);

  const processed = content.replace(regex, (_match, name, type, uuid, pin) => {
    const index = mentions.length;
    const { pinnedHost, pinnedCwd } = decodePinSuffix(pin);
    const ref: ParsedMentionRef = {
      type: (type as string).toLowerCase() as "user" | "agent",
      uuid: (uuid as string).toLowerCase(),
      displayName: name,
    };
    if (pinnedHost !== null || pinnedCwd !== null) {
      ref.pinnedHost = pinnedHost;
      ref.pinnedCwd = pinnedCwd;
    }
    mentions.push(ref);
    const label = `@${name}`
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<${MENTION_TAG} ${MENTION_TAG_ATTR}="${index}">${label}</${MENTION_TAG}>`;
  });

  return { processed, mentions };
}

interface MentionRendererProps {
  children: string;
  className?: string;
}

/**
 * Renders plain text with @mentions highlighted.
 * For use in places that don't need markdown rendering.
 */
export function MentionRenderer({ children, className }: MentionRendererProps) {
  if (!children || typeof children !== "string") {
    return null;
  }

  const parts = parseMentions(children);

  if (parts.length === 1 && parts[0].type === "text") {
    return <span className={className}>{children}</span>;
  }

  return (
    <span className={className}>
      {parts.map((part, index) => {
        if (part.type === "mention") {
          return (
            <span
              key={index}
              className="text-blue-600 font-medium"
              title={`${part.mentionType}: ${part.mentionUuid}`}
            >
              @{part.content}
            </span>
          );
        }
        return <React.Fragment key={index}>{part.content}</React.Fragment>;
      })}
    </span>
  );
}

interface ContentWithMentionsProps {
  children: string;
  /**
   * OPT-IN React-native mention rendering. When provided, each `@mention` is
   * rendered as a real React node returned by this render-prop (so an interactive
   * MentionBadge / Radix Popover can be mounted) instead of via the default
   * imperative DOM injection. When ABSENT, rendering is byte-for-byte identical to
   * before — the DOM-injection path (MentionPostProcessor) is used unchanged. Only
   * the comment surface passes this, keeping every other surface (idea / proposal /
   * task / document descriptions) untouched (q6 = comments only).
   */
  renderMention?: (arg: RenderMentionArg) => React.ReactNode;
}

/**
 * Renders markdown content with @mention support.
 *
 * Default (no `renderMention`): pre-processes mentions into zero-width placeholders,
 * renders through Streamdown, then replaces placeholders with styled mention spans
 * via a DOM effect. Drop-in replacement for <Streamdown>{content}</Streamdown>.
 *
 * Opt-in (`renderMention` provided): pre-processes mentions into `<chorus-mention>`
 * custom tags and renders them as React nodes via a Streamdown `components`
 * override — used ONLY by the comment path so agent mentions can become an
 * interactive MentionBadge. The default path is unchanged.
 */
export function ContentWithMentions({
  children,
  renderMention,
}: ContentWithMentionsProps) {
  if (!children || typeof children !== "string") {
    return null;
  }

  // Check if there are any mentions at all. Reuse the source AND flags (the regex
  // is case-insensitive) so detection matches what parseMentions/preprocessMentions
  // will actually capture.
  const hasMentionPatterns = new RegExp(
    MENTION_REGEX.source,
    MENTION_REGEX.flags.replace("g", ""),
  ).test(children);

  if (!hasMentionPatterns) {
    return (
      <div className="overflow-hidden [&_pre]:overflow-x-auto">
        <MarkdownContent>{children}</MarkdownContent>
      </div>
    );
  }

  // ── Opt-in React-native path (comment surface only) ──────────────────────
  if (renderMention) {
    return (
      <ReactNativeMentionContent renderMention={renderMention}>
        {children}
      </ReactNativeMentionContent>
    );
  }

  // ── Default path (every other surface): byte-stable DOM injection ─────────
  const { processed, mentions } = preprocessMentions(children);

  return (
    <MentionPostProcessor mentions={mentions}>
      <MarkdownContent>{processed}</MarkdownContent>
    </MentionPostProcessor>
  );
}

/**
 * The React-native mention render path: preprocess mentions into `<chorus-mention>`
 * tags and map that tag to the caller's `renderMention` node via Streamdown's
 * `components` override. The `idx` attribute keys back into the parsed refs.
 * Memoizes the preprocess + the components map so re-renders (e.g. presence polls
 * upstream) don't re-parse the body or churn the Streamdown component identity.
 */
function ReactNativeMentionContent({
  children,
  renderMention,
}: {
  children: string;
  renderMention: (arg: RenderMentionArg) => React.ReactNode;
}) {
  const { processed, mentions } = React.useMemo(
    () => preprocessMentionsAsTags(children),
    [children],
  );

  const components = React.useMemo<Components>(() => {
    // `chorus-mention` is a custom (non-standard) tag, so it isn't in the
    // react-markdown Components keys — cast through a record to register it.
    const map: Record<string, React.ComponentType<{ idx?: string }>> = {
      [MENTION_TAG]: ({ idx }) => {
        const index = idx === undefined ? NaN : parseInt(idx, 10);
        const ref = Number.isInteger(index) ? mentions[index] : undefined;
        if (!ref) return null;
        return <>{renderMention({ ...ref, index })}</>;
      },
    };
    return map as unknown as Components;
  }, [mentions, renderMention]);

  return (
    <div className="overflow-hidden [&_pre]:overflow-x-auto">
      <MarkdownContent
        components={components}
        allowedTags={{ [MENTION_TAG]: [MENTION_TAG_ATTR] }}
        literalTagContent={[MENTION_TAG]}
      >
        {processed}
      </MarkdownContent>
    </div>
  );
}

/**
 * Post-processes rendered markdown to replace mention placeholders with styled spans.
 * Uses a ref + DOM manipulation to find and replace placeholder text nodes.
 */
function MentionPostProcessor({
  children,
  mentions,
}: {
  children: React.ReactNode;
  // Pin fields are carried through (for surfaces that may read them) but the
  // DOM-injection rendering below intentionally uses only type/uuid/displayName,
  // so this non-comment path stays byte-stable.
  mentions: Array<{
    displayName: string;
    type: string;
    uuid: string;
    pinnedHost?: string | null;
    pinnedCwd?: string | null;
  }>;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!containerRef.current || mentions.length === 0) return;

    const walker = document.createTreeWalker(
      containerRef.current,
      NodeFilter.SHOW_TEXT,
      null
    );

    const textNodes: Text[] = [];
    let node;
    while ((node = walker.nextNode())) {
      if (MENTION_PLACEHOLDER_REGEX.test(node.textContent || "")) {
        textNodes.push(node as Text);
      }
      // Reset regex lastIndex
      MENTION_PLACEHOLDER_REGEX.lastIndex = 0;
    }

    for (const textNode of textNodes) {
      const text = textNode.textContent || "";
      const fragment = document.createDocumentFragment();
      let lastIdx = 0;
      let m;

      const regex = new RegExp(MENTION_PLACEHOLDER_REGEX.source, "g");
      while ((m = regex.exec(text)) !== null) {
        // Add text before placeholder
        if (m.index > lastIdx) {
          fragment.appendChild(
            document.createTextNode(text.slice(lastIdx, m.index))
          );
        }

        // Create mention span
        const mentionIndex = parseInt(m[1], 10);
        const mention = mentions[mentionIndex];
        if (mention) {
          const span = document.createElement("span");
          span.className = "text-blue-600 font-medium";
          span.title = `${mention.type}: ${mention.uuid}`;
          span.textContent = `@${mention.displayName}`;
          fragment.appendChild(span);
        } else {
          fragment.appendChild(document.createTextNode(m[0]));
        }

        lastIdx = m.index + m[0].length;
      }

      // Add remaining text
      if (lastIdx < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIdx)));
      }

      textNode.parentNode?.replaceChild(fragment, textNode);
    }
  }, [mentions]);

  return <div ref={containerRef} className="overflow-hidden [&_pre]:overflow-x-auto">{children}</div>;
}

/**
 * Utility to check if text contains any @mention patterns.
 */
export function hasMentions(text: string): boolean {
  // Drop only the global flag (a `g`-flagged regex's stateful `.test` would skip
  // matches across calls); keep case-insensitivity.
  return new RegExp(
    MENTION_REGEX.source,
    MENTION_REGEX.flags.replace("g", ""),
  ).test(text);
}

/**
 * Extracts all mentions from text content as `ParsedMentionRef`s, including any
 * optional pinned-instance suffix (reusing the shared codec). An un-pinned token
 * yields a ref with NO pin fields (object-identical to the legacy shape); a
 * pinned token adds `pinnedHost`/`pinnedCwd`.
 */
export function extractMentions(text: string): ParsedMentionRef[] {
  const mentions: ParsedMentionRef[] = [];
  const regex = new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags);
  let match;

  while ((match = regex.exec(text)) !== null) {
    const { pinnedHost, pinnedCwd } = decodePinSuffix(match[4]);
    const ref: ParsedMentionRef = {
      displayName: match[1],
      type: match[2].toLowerCase() as "user" | "agent",
      uuid: match[3].toLowerCase(),
    };
    if (pinnedHost !== null || pinnedCwd !== null) {
      ref.pinnedHost = pinnedHost;
      ref.pinnedCwd = pinnedCwd;
    }
    mentions.push(ref);
  }

  return mentions;
}
