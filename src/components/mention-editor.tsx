"use client";

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { isImeComposing } from "@/lib/ime";

// Localized strings the (module-level, hook-less) popup renderer needs. Built in
// the component via useTranslations and threaded through as plain strings.
interface MentionPopupLabels {
  online: string;
  offline: string;
  /** Status text for an online agent with no active work. */
  idle: string;
  /** Active-task count text for an online agent, e.g. "3 active". */
  activeCount: (n: number) => string;
}

// Extend Mention to support custom `mentionType` attribute (user | agent)
const CustomMention = Mention.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      mentionType: {
        default: "user",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-mention-type") || "user",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-mention-type": attributes.mentionType || "user",
        }),
      },
    };
  },
});

// ── Types ──────────────────────────────────────────────────────

interface Mentionable {
  type: "user" | "agent";
  uuid: string;
  name: string;
  email?: string;
  roles?: string[];
  // Agent liveness (agents only; see mention.service.ts). `online` drives the
  // status dot; `activeCount` drives the count badge (shown only when > 0).
  online?: boolean;
  activeCount?: number;
}

export interface MentionEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  onSubmit?: () => void;
}

export interface MentionEditorRef {
  focus: () => void;
  clear: () => void;
}

// Local type definitions to avoid importing from @tiptap/suggestion
interface KeyDownHandlerProps {
  event: KeyboardEvent;
}

interface KeyDownHandler {
  onKeyDown: (props: KeyDownHandlerProps) => boolean;
}

// ── Debounce helper ────────────────────────────────────────────

function useDebouncedCallback(
  callback: (query: string) => void,
  delay: number
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const debouncedFn = useCallback(
    (query: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => callbackRef.current(query), delay);
    },
    [delay]
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return debouncedFn;
}

// ── Convert Tiptap JSON to plain text with mention markers ─────

function editorToPlainText(editor: Editor): string {
  const json = editor.getJSON();
  if (!json.content) return "";

  function processNode(node: Record<string, unknown>): string {
    if (node.type === "mention") {
      const attrs = node.attrs as Record<string, string> | undefined;
      if (attrs) {
        return `@[${attrs.label || attrs.id}](${attrs.mentionType || "user"}:${attrs.id})`;
      }
      return "";
    }

    if (node.type === "text") {
      return (node.text as string) || "";
    }

    if (node.type === "hardBreak") {
      return "\n";
    }

    const children = node.content as Record<string, unknown>[] | undefined;
    if (children) {
      return children.map(processNode).join("");
    }

    return "";
  }

  return (json.content as Record<string, unknown>[])
    .map((block) => processNode(block))
    .join("\n");
}

// ── Parse plain text with mention markers into Tiptap JSON ─────

function plainTextToEditorContent(text: string): Record<string, unknown> {
  if (!text) {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }

  const MENTION_RE = /@\[([^\]]+)\]\((user|agent):([a-f0-9-]+)\)/g;
  const lines = text.split("\n");

  const content = lines.map((line) => {
    const inlineContent: Record<string, unknown>[] = [];
    let lastIndex = 0;
    let match;
    const regex = new RegExp(MENTION_RE.source, "g");

    while ((match = regex.exec(line)) !== null) {
      if (match.index > lastIndex) {
        inlineContent.push({
          type: "text",
          text: line.slice(lastIndex, match.index),
        });
      }

      inlineContent.push({
        type: "mention",
        attrs: {
          id: match[3],
          label: match[1],
          mentionType: match[2],
        },
      });

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < line.length) {
      inlineContent.push({
        type: "text",
        text: line.slice(lastIndex),
      });
    }

    return {
      type: "paragraph",
      content: inlineContent.length > 0 ? inlineContent : undefined,
    };
  });

  return { type: "doc", content };
}

// ── Imperative suggestion popup rendering ──────────────────────

// Exported for unit testing the row DOM (dot / count badge / roles-removed /
// user-row-unchanged) without booting a full Tiptap editor + suggestion flow.
export function createSuggestionPopupRenderer(
  items: Mentionable[],
  isLoading: boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  command: (attrs: any) => void,
  keyDownRef: React.MutableRefObject<KeyDownHandler | null>,
  container: HTMLDivElement,
  labels: MentionPopupLabels
) {
  container.innerHTML = "";

  if (isLoading) {
    const loader = document.createElement("div");
    loader.className = "flex items-center justify-center py-3 px-4";
    loader.innerHTML =
      '<div class="h-4 w-4 animate-spin rounded-full border-2 border-[#9A9A9A] border-t-transparent"></div>';
    container.appendChild(loader);
    return;
  }

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "py-2 px-3 text-xs text-[#9A9A9A]";
    empty.textContent = "No results";
    container.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "py-1";
  let selectedIdx = 0;

  const doCommand = (item: Mentionable) => {
    command({
      id: item.uuid,
      label: item.name,
      mentionType: item.type,
    });
  };

  const renderList = () => {
    list.innerHTML = "";
    items.forEach((item, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors ${
        index === selectedIdx
          ? "bg-[#FAF8F4] text-[#2C2C2C]"
          : "text-[#6B6B6B] hover:bg-[#FAF8F4]"
      }`;
      btn.onclick = () => doCommand(item);

      // Avatar wrapped in a relative container so the agent presence dot can sit
      // at the bottom-right corner of the avatar (the conventional presence-dot
      // position), rather than on a separate status line.
      const avatarWrap = document.createElement("div");
      avatarWrap.className = "relative shrink-0";

      const avatar = document.createElement("div");
      avatar.className = `flex h-6 w-6 items-center justify-center rounded-full ${
        item.type === "agent"
          ? "bg-[#C67A52] text-white"
          : "bg-[#E5E0D8] text-[#6B6B6B]"
      }`;
      avatar.innerHTML =
        item.type === "agent"
          ? '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>'
          : '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
      avatarWrap.appendChild(avatar);

      // Online presence dot at the avatar's bottom-right, online agents only.
      // The white ring (border) lifts it off the avatar fill. Offline agents
      // show no dot (the "Idle / N active" text line below carries the rest of
      // the state, and a sea of grey corner dots would be noise).
      if (item.type === "agent" && item.online) {
        const dot = document.createElement("span");
        dot.className =
          "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-[#22C55E] ring-2 ring-white";
        dot.title = labels.online;
        avatarWrap.appendChild(dot);
      }

      const info = document.createElement("div");
      info.className = "min-w-0 flex-1";

      const nameEl = document.createElement("div");
      nameEl.className = "truncate text-xs font-medium";
      nameEl.textContent = item.name;
      info.appendChild(nameEl);

      if (item.email) {
        const emailEl = document.createElement("div");
        emailEl.className = "truncate text-[10px] text-[#9A9A9A]";
        emailEl.textContent = item.email;
        info.appendChild(emailEl);
      }

      // Agent status line (replaces the old roles line). For an ONLINE agent we
      // always show an explicit status — never a blank line: the active-task
      // count when busy ("▶ N", green), or a muted "Idle" when it has no
      // running/queued work. Offline agents show nothing here (the absent
      // presence dot already conveys offline). User rows get no status line.
      if (item.type === "agent" && item.online) {
        const count = item.activeCount ?? 0;
        const statusEl = document.createElement("div");
        if (count > 0) {
          statusEl.className =
            "mt-0.5 truncate text-[10px] font-medium text-[#15803D]";
          statusEl.textContent = `▶ ${labels.activeCount(count)}`;
        } else {
          statusEl.className = "mt-0.5 truncate text-[10px] text-[#9A9A9A]";
          statusEl.textContent = labels.idle;
        }
        info.appendChild(statusEl);
      }

      btn.appendChild(avatarWrap);
      btn.appendChild(info);
      list.appendChild(btn);
    });
  };

  renderList();
  container.appendChild(list);

  keyDownRef.current = {
    onKeyDown: ({ event }: KeyDownHandlerProps) => {
      if (isImeComposing(event)) return false;
      if (event.key === "ArrowUp") {
        selectedIdx = selectedIdx <= 0 ? items.length - 1 : selectedIdx - 1;
        renderList();
        return true;
      }
      if (event.key === "ArrowDown") {
        selectedIdx = selectedIdx >= items.length - 1 ? 0 : selectedIdx + 1;
        renderList();
        return true;
      }
      if (event.key === "Enter") {
        if (items[selectedIdx]) {
          doCommand(items[selectedIdx]);
        }
        return true;
      }
      if (event.key === "Escape") {
        return true;
      }
      return false;
    },
  };
}

// ── MentionEditor Component ────────────────────────────────────

export const MentionEditor = forwardRef<MentionEditorRef, MentionEditorProps>(
  ({ value, onChange, placeholder, className, disabled, onSubmit }, ref) => {
    const suggestionItemsRef = useRef<Mentionable[]>([]);
    const suggestionLoadingRef = useRef(false);
    const keyDownRef = useRef<KeyDownHandler | null>(null);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const popupRef = useRef<HTMLDivElement | null>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentCommandRef = useRef<((attrs: any) => void) | null>(null);
    const [, forceUpdate] = useState(0);
    const isInternalUpdate = useRef(false);

    // Localized labels for the popup's agent-liveness UI. Kept in a ref so the
    // module-level renderer (called from Tiptap's long-lived suggestion
    // callbacks) always reads current strings without a stale closure.
    const t = useTranslations("mention");
    const labelsRef = useRef<MentionPopupLabels>({
      online: "",
      offline: "",
      idle: "",
      activeCount: () => "",
    });
    labelsRef.current = {
      online: t("online"),
      offline: t("offline"),
      idle: t("idle"),
      activeCount: (n: number) => t("activeCount", { count: n }),
    };

    // Fetch mentionables from API
    const fetchMentionables = useCallback(async (query: string) => {
      suggestionLoadingRef.current = true;
      forceUpdate((n) => n + 1);

      try {
        const res = await fetch(
          `/api/mentionables?q=${encodeURIComponent(query)}&limit=10`
        );
        if (res.ok) {
          const json = await res.json();
          if (json.success) {
            suggestionItemsRef.current = json.data;
          }
        }
      } catch {
        suggestionItemsRef.current = [];
      } finally {
        suggestionLoadingRef.current = false;
        forceUpdate((n) => n + 1);
      }
    }, []);

    const debouncedFetch = useDebouncedCallback(fetchMentionables, 250);

    // Re-render popup when items change
    useEffect(() => {
      if (popupRef.current && currentCommandRef.current) {
        createSuggestionPopupRenderer(
          suggestionItemsRef.current,
          suggestionLoadingRef.current,
          currentCommandRef.current,
          keyDownRef,
          popupRef.current,
          labelsRef.current
        );
      }
    });

    // Create the Tiptap editor
    const editor = useEditor({
      immediatelyRender: false,
      extensions: [
        StarterKit.configure({
          heading: false,
          blockquote: false,
          codeBlock: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          horizontalRule: false,
        }),
        CustomMention.configure({
          HTMLAttributes: {
            class: "text-blue-600 font-medium",
          },
          renderText({ node }) {
            return `@${node.attrs.label ?? node.attrs.id}`;
          },
          suggestion: {
            char: "@",
            allowSpaces: true,
            items: ({ query }: { query: string }) => {
              debouncedFetch(query);
              return suggestionItemsRef.current;
            },
            render: () => {
              return {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onStart: (props: any) => {
                  const popup = document.createElement("div");
                  popup.className =
                    "z-[100] rounded-md border border-[#E5E0D8] bg-white shadow-md min-w-[200px] max-w-[300px] overflow-hidden";
                  popupRef.current = popup;
                  currentCommandRef.current = props.command;

                  if (props.clientRect) {
                    const rect =
                      typeof props.clientRect === "function"
                        ? props.clientRect()
                        : props.clientRect;
                    if (rect) {
                      popup.style.position = "fixed";
                      popup.style.left = `${rect.left}px`;
                      const spaceBelow = window.innerHeight - rect.bottom;
                      if (spaceBelow < 220) {
                        popup.style.bottom = `${window.innerHeight - rect.top + 4}px`;
                      } else {
                        popup.style.top = `${rect.bottom + 4}px`;
                      }
                    }
                  }

                  // Mount inside the editor wrapper (not document.body) so the
                  // popup lives within the same DOM subtree as the editor. When
                  // the editor is hosted inside a modal Radix Dialog (e.g. the
                  // proposal comments Sheet), the dialog sets
                  // `pointer-events: none` on <body> and treats clicks outside
                  // its subtree as "interact outside" dismissals. A body-level
                  // popup would inherit the disabled pointer-events (clicks dead)
                  // and would dismiss the dialog on click. Keeping it inside the
                  // wrapper inherits `pointer-events: auto` and is recognized as
                  // inside the dialog. `position: fixed` still positions it
                  // against the viewport so it escapes any overflow clipping.
                  (wrapperRef.current ?? document.body).appendChild(popup);

                  createSuggestionPopupRenderer(
                    suggestionItemsRef.current,
                    suggestionLoadingRef.current,
                    props.command,
                    keyDownRef,
                    popup,
                    labelsRef.current
                  );
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onUpdate: (props: any) => {
                  currentCommandRef.current = props.command;
                  if (popupRef.current && props.clientRect) {
                    const rect =
                      typeof props.clientRect === "function"
                        ? props.clientRect()
                        : props.clientRect;
                    if (rect) {
                      popupRef.current.style.left = `${rect.left}px`;
                      const spaceBelow = window.innerHeight - rect.bottom;
                      if (spaceBelow < 220) {
                        popupRef.current.style.top = "";
                        popupRef.current.style.bottom = `${window.innerHeight - rect.top + 4}px`;
                      } else {
                        popupRef.current.style.bottom = "";
                        popupRef.current.style.top = `${rect.bottom + 4}px`;
                      }
                    }
                  }

                  if (popupRef.current) {
                    createSuggestionPopupRenderer(
                      suggestionItemsRef.current,
                      suggestionLoadingRef.current,
                      props.command,
                      keyDownRef,
                      popupRef.current,
                      labelsRef.current
                    );
                  }
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onKeyDown: (props: any) => {
                  if (keyDownRef.current) {
                    return keyDownRef.current.onKeyDown(props);
                  }
                  return false;
                },
                onExit: () => {
                  popupRef.current?.remove();
                  popupRef.current = null;
                  currentCommandRef.current = null;
                  suggestionItemsRef.current = [];
                  suggestionLoadingRef.current = false;
                },
              };
            },
          },
        }),
      ],
      content: plainTextToEditorContent(value),
      editable: !disabled,
      editorProps: {
        attributes: {
          class: cn(
            "min-h-[36px] max-h-[120px] overflow-y-auto px-3 py-2 text-sm outline-none",
            "prose prose-sm max-w-none [&_p]:my-0"
          ),
          "data-placeholder": placeholder || "",
        },
        handleKeyDown: (_view, event) => {
          if (isImeComposing(event)) return false;
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !popupRef.current &&
            onSubmit
          ) {
            event.preventDefault();
            onSubmit();
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: ed }) => {
        isInternalUpdate.current = true;
        const text = editorToPlainText(ed);
        onChange(text);
      },
    });

    // Sync external value changes into editor
    useEffect(() => {
      if (!editor || isInternalUpdate.current) {
        isInternalUpdate.current = false;
        return;
      }

      const currentText = editorToPlainText(editor);
      if (currentText !== value) {
        editor.commands.setContent(plainTextToEditorContent(value));
      }
    }, [value, editor]);

    // Update editable state
    useEffect(() => {
      if (editor) {
        editor.setEditable(!disabled);
      }
    }, [disabled, editor]);

    useImperativeHandle(ref, () => ({
      focus: () => editor?.commands.focus(),
      clear: () => {
        editor?.commands.clearContent();
        onChange("");
      },
    }));

    return (
      <div
        ref={wrapperRef}
        className={cn(
          "relative rounded-md border border-input bg-transparent shadow-xs transition-[color,box-shadow]",
          "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
      >
        <EditorContent editor={editor} />
        <style>{`
          .tiptap p.is-editor-empty:first-child::before {
            content: attr(data-placeholder);
            color: #9A9A9A;
            float: left;
            height: 0;
            pointer-events: none;
          }
          .tiptap .mention {
            color: #2563eb;
            font-weight: 500;
          }
        `}</style>
      </div>
    );
  }
);
MentionEditor.displayName = "MentionEditor";
