"use client";

import {
  createContext, useContext, useEffect, useMemo, useState,
  type ComponentProps, type ElementType,
} from "react";
import {
  Block, Streamdown, defaultRehypePlugins, defaultUrlTransform,
  type BlockProps, type Components, type UrlTransform,
} from "streamdown";

import { FrontmatterCard } from "@/components/frontmatter-card";
import { ReferenceCitation } from "@/components/reference-citation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createCitationStore, type CitationStore } from "@/lib/reference-citation-store";
import { referenceUuid } from "@/lib/reference-citations";
import { splitFrontmatter } from "@/lib/frontmatter";
import {
  streamdownPluginsFor,
  streamdownControls,
} from "@/lib/streamdown-plugins";

const CitationContext = createContext<CitationStore | null>(null);
const citationUrlTransform: UrlTransform = (url, key, node) => {
  // Streamdown's transform is currently an identity function: its sanitizer
  // handles safety. Explicitly reject invalid refs after extending that schema.
  if (/^ref:/i.test(url)) {
    return key === "href" && node.tagName === "a" && referenceUuid(url) ? url : "";
  }
  return defaultUrlTransform(url, key, node);
};

function CitationBlock({ components, rehypePlugins, ...props }: BlockProps) {
  const store = useContext(CitationContext)!;
  // Block receives Streamdown's merged components, including its private default
  // anchor. Delegating preserves link safety, styles and caller overrides.
  const mergedComponents = useMemo(() => {
    const NormalLink = components!.a! as ElementType<ComponentProps<"a">>;
    function CitationLink(props: ComponentProps<"a">) {
      const uuid = referenceUuid(props.href);
      return uuid ? (
        <ReferenceCitation uuid={uuid} store={store}>
          {props.children}
        </ReferenceCitation>
      ) : <NormalLink {...props} />;
    }
    return { ...components, a: CitationLink } as Components;
  }, [components, store]);
  // Extend the already-resolved sanitizer, after Streamdown adds custom tags.
  const plugins = useMemo(() => rehypePlugins?.map((plugin) => {
    const sanitize = defaultRehypePlugins.sanitize;
    if (!Array.isArray(plugin) || !Array.isArray(sanitize) || plugin[0] !== sanitize[0]) return plugin;
    const schema = plugin[1] as { protocols?: Record<string, string[]> };
    return [plugin[0], {
      ...schema,
      protocols: { ...schema.protocols, href: [...(schema.protocols?.href ?? []), "ref"] },
    }] as typeof plugin;
  }), [rehypePlugins]);
  // Streamdown memoizes paragraphs by source position, so equal-length UUID
  // edits otherwise keep stale anchors mounted.
  return <Block key={props.content} {...props} components={mergedComponents} rehypePlugins={plugins} />;
}

// Custom-tag passthrough for Streamdown. The comment mention path
// (ContentWithMentions' opt-in `renderMention`) passes a `<chorus-mention>` custom
// tag mapping so an agent @mention renders as a real, interactive React node
// (MentionBadge) instead of imperatively-injected DOM — which a Radix Popover
// cannot live inside. `literalTagContent` keeps the tag's child label out of the
// markdown parser, and `allowedTags` whitelists the tag + its attributes through
// Streamdown's sanitizer.
export interface MarkdownContentProps {
  children: string;
  /** react-markdown-style element overrides (e.g. a custom `<chorus-mention>`). */
  components?: Components;
  /** Custom tags + permitted attributes allowed through sanitization. */
  allowedTags?: Record<string, string[]>;
  /** Tags whose children are treated as plain text (no markdown parsing). */
  literalTagContent?: string[];
}

function useDarkClass(): boolean {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setIsDark(root.classList.contains("dark"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

export function MarkdownContent({
  children,
  components,
  allowedTags,
  literalTagContent,
}: MarkdownContentProps) {
  const isDark = useDarkClass();
  const [citations] = useState(createCitationStore);
  useEffect(() => {
    window.addEventListener("focus", citations.refreshAll);
    return () => window.removeEventListener("focus", citations.refreshAll);
  }, [citations]);

  // A leading YAML frontmatter block is lifted out of the body and rendered as
  // a metadata card. `splitFrontmatter` only recognizes a flat key/value
  // mapping at offset 0 and otherwise returns the input untouched, so content
  // without frontmatter (`entries === null`) hands Streamdown the exact same
  // string as before — that identity is the regression guarantee for every
  // existing surface. Don't "simplify" this into a conditional strip.
  const { entries, body } = useMemo(() => splitFrontmatter(children), [children]);

  const mermaidOptions = useMemo(
    () => ({ config: { theme: isDark ? "dark" : "default" } as const }),
    [isDark],
  );

  // Theme-aware plugin set: the code plugin must emit dark Shiki vars in dark
  // (see streamdown-plugins.ts). Memoized so the plugin instance is stable per
  // theme; the `key` below already forces a remount + re-tokenize on flip.
  const plugins = useMemo(() => streamdownPluginsFor(isDark), [isDark]);

  // Mermaid caches its singleton inside Streamdown; passing a new `mermaid` prop
  // updates config but does not re-paint already-rendered SVGs. The `key` forces
  // React to tear down and rebuild the subtree on theme change, which is what
  // actually triggers the repaint. Don't drop the key while keeping the prop —
  // the prop alone won't repaint cached diagrams and the bug returns silently.
  //
  // Caller components and mention tag configuration still reach Streamdown.
  return (
    <CitationContext.Provider value={citations}>
      <TooltipProvider>
        {entries && <FrontmatterCard entries={entries} />}
        <Streamdown
          key={isDark ? "dark" : "light"}
          plugins={plugins}
          controls={streamdownControls}
          mermaid={mermaidOptions}
          components={components}
          allowedTags={allowedTags}
          literalTagContent={literalTagContent}
          BlockComponent={CitationBlock}
          urlTransform={citationUrlTransform}
        >
          {body}
        </Streamdown>
      </TooltipProvider>
    </CitationContext.Provider>
  );
}
