"use client";

import React from "react";

import { MarkdownContent } from "@/components/markdown-content";

/**
 * Regex to match @[DisplayName](type:uuid) patterns in text.
 * - DisplayName: any non-] characters
 * - type: user | agent
 * - uuid: standard UUID format
 */
const MENTION_REGEX = /@\[([^\]]+)\]\((user|agent):([a-f0-9-]+)\)/g;

interface MentionPart {
  type: "text" | "mention";
  content: string;
  mentionType?: "user" | "agent";
  mentionUuid?: string;
}

function parseMentions(text: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let lastIndex = 0;

  const regex = new RegExp(MENTION_REGEX.source, "g");
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        type: "text",
        content: text.slice(lastIndex, match.index),
      });
    }

    parts.push({
      type: "mention",
      content: match[1],
      mentionType: match[2] as "user" | "agent",
      mentionUuid: match[3],
    });

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
 */
function preprocessMentions(content: string): {
  processed: string;
  mentions: Array<{ displayName: string; type: string; uuid: string }>;
} {
  const mentions: Array<{ displayName: string; type: string; uuid: string }> =
    [];
  const regex = new RegExp(MENTION_REGEX.source, "g");

  const processed = content.replace(regex, (_match, name, type, uuid) => {
    const index = mentions.length;
    mentions.push({ displayName: name, type, uuid });
    return `${MENTION_PLACEHOLDER_PREFIX}${index}${MENTION_PLACEHOLDER_SUFFIX}`;
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
}

/**
 * Renders markdown content with @mention support.
 * Pre-processes mentions into placeholders, renders through Streamdown,
 * then replaces placeholders with styled mention spans via DOM effect.
 *
 * Drop-in replacement for <Streamdown>{content}</Streamdown>.
 */
export function ContentWithMentions({ children }: ContentWithMentionsProps) {
  if (!children || typeof children !== "string") {
    return null;
  }

  // Check if there are any mentions at all
  const hasMentionPatterns = new RegExp(MENTION_REGEX.source).test(children);

  if (!hasMentionPatterns) {
    return (
      <div className="overflow-hidden [&_pre]:overflow-x-auto">
        <MarkdownContent>{children}</MarkdownContent>
      </div>
    );
  }

  const { processed, mentions } = preprocessMentions(children);

  return (
    <MentionPostProcessor mentions={mentions}>
      <MarkdownContent>{processed}</MarkdownContent>
    </MentionPostProcessor>
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
  mentions: Array<{ displayName: string; type: string; uuid: string }>;
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
  return new RegExp(MENTION_REGEX.source).test(text);
}

/**
 * Extracts all mentions from text content.
 */
export function extractMentions(
  text: string
): Array<{ displayName: string; type: "user" | "agent"; uuid: string }> {
  const mentions: Array<{
    displayName: string;
    type: "user" | "agent";
    uuid: string;
  }> = [];
  const regex = new RegExp(MENTION_REGEX.source, "g");
  let match;

  while ((match = regex.exec(text)) !== null) {
    mentions.push({
      displayName: match[1],
      type: match[2] as "user" | "agent",
      uuid: match[3],
    });
  }

  return mentions;
}
