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
import { clientLogger } from "@/lib/logger-client";
import { isImeComposing } from "@/lib/ime";
import { buildMentionMarker, decodePinSuffix } from "@/lib/mention-format";
import {
  InstancePicker,
  type InstanceCandidate,
} from "@/components/agent-presence/instance-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

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

// Extend Mention to support custom `mentionType` (user | agent) plus the
// optional pinned (host, cwd) instance target (cwd-addressable instances, T3).
// The pin attributes are carried on the node and serialized into the markup's
// query-string suffix by editorToPlainText; an un-pinned mention leaves them at
// their `null` default and serializes byte-identically to before this change.
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
      // Pinned instance host ("" = unknown-host instance, null = un-pinned).
      pinnedHost: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-pinned-host"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.pinnedHost == null
            ? {}
            : { "data-pinned-host": String(attributes.pinnedHost) },
      },
      // Pinned instance cwd (null = unknown-path instance OR un-pinned; the
      // presence of pinnedHost or a non-null cwd marks the mention as pinned).
      pinnedCwd: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-pinned-cwd"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.pinnedCwd == null
            ? {}
            : { "data-pinned-cwd": String(attributes.pinnedCwd) },
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
  // Live (host, cwd) instances for an agent (cwd-addressable instances, T3),
  // populated when the editor requests them (withInstances). When an agent has
  // 2+ instances the editor surfaces the secondary picker; a single instance
  // auto-selects; 0 instances → un-pinned mention (behaves as before).
  instances?: InstanceCandidate[];
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
      const attrs = node.attrs as Record<string, string | null> | undefined;
      if (attrs) {
        // Serialize via the shared codec so the optional pinned (host, cwd)
        // suffix matches what the service parser reads. Un-pinned (both null) →
        // byte-identical to the legacy `@[Name](type:uuid)` form.
        return buildMentionMarker(
          (attrs.label || attrs.id) as string,
          ((attrs.mentionType as string) || "user") as "user" | "agent",
          attrs.id as string,
          attrs.pinnedHost ?? null,
          attrs.pinnedCwd ?? null,
        );
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

  // Matches the legacy `@[Name](type:uuid)` form plus an OPTIONAL pinned-instance
  // suffix `?cwd=…&host=…` (cwd-addressable instances, T3). Group 4 is the raw
  // pin query string (or undefined for an un-pinned mention).
  const MENTION_RE = /@\[([^\]]+)\]\((user|agent):([a-f0-9-]+)(?:\?([^)]*))?\)/g;
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

      const { pinnedHost, pinnedCwd } = decodePinSuffix(match[4]);
      inlineContent.push({
        type: "mention",
        attrs: {
          id: match[3],
          label: match[1],
          mentionType: match[2],
          pinnedHost,
          pinnedCwd,
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
  labels: MentionPopupLabels,
  // Decides what happens when a candidate is chosen (cwd-addressable instances,
  // T3). When provided, it owns the secondary-picker branch: an agent with 2+
  // live instances defers the insert and opens the picker; otherwise it inserts
  // (auto-pinning a single instance). Omitted → legacy behavior: insert the bare
  // mention immediately. Tests can omit it to assert the un-pinned DOM/flow.
  selectMentionable?: (
    item: Mentionable,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    command: (attrs: any) => void,
  ) => void,
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
    if (selectMentionable) {
      // Delegate to the React owner: it decides immediate insert (auto-pinning a
      // single instance) vs. opening the secondary picker for 2+ instances.
      selectMentionable(item, command);
      return;
    }
    // Legacy path (no instance pinning): insert the bare mention.
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

// ── Secondary instance picker dialog (cwd-addressable instances, T3) ───────
//
// Shown when an @mentioned agent has 2+ ONLINE instances: the owner pins which
// (host, cwd) the mention targets. The caller passes ONLINE instances only — an
// offline instance is never a wake target and is not shown. Owns its own
// selection state; Confirm calls onConfirm with the chosen instance, Cancel
// discards (inserting nothing — the user can re-type the mention). Matches
// design.pen "@mention cwd Picker".
//
// Mobile-safe layout (fix-mention-cwd-picker-mobile-overflow): the dialog is
// capped to `max-h-[85svh]` — a DYNAMIC small-viewport unit that shrinks with the
// mobile soft keyboard / URL bar, unlike a static `vh` that tracks only the layout
// viewport. The body is a flex column: the header and footer (Cancel / Pin) are
// `shrink-0` so they stay visible and tappable, and ONLY the instance list scrolls
// (`min-h-0 flex-1 overflow-y-auto`). Without this, a tall instance list on a
// keyboard-shortened viewport pushed the Pin button off-screen with no way to reach
// it (Radix centers the content against the layout viewport, ignoring the keyboard).
//
// Stacking (z-[110]): this picker is opened from inside the idea-detail side panel,
// which is itself `fixed z-50`. The default Dialog overlay+content are also `z-50`,
// so the dialog only sits above the panel by PAINT ORDER — a tie that some mobile
// browsers resolve the other way, leaving the panel (and its Overview/Elaboration/
// Activity tab bar) painted OVER the dialog: the title looks occluded and taps on
// the footer land on the tab bar so Pin can't be clicked. Lifting BOTH the content
// and the overlay to `z-[110]` (above the panel's z-50 — in the same high band as
// the @-mention suggestion popup's own `z-[100]`, which already clears the panel)
// makes it deterministic regardless of paint order.
// Exported for the unit test that pins this layout contract.
export function MentionInstancePickerDialog({
  open,
  agentName,
  instances,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  agentName: string;
  instances: InstanceCandidate[];
  onConfirm: (instance: InstanceCandidate) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("mentionInstance");
  const [selected, setSelected] = useState<InstanceCandidate | null>(null);

  // Default-select the FIRST instance whenever a new pick opens the dialog, so
  // the picker is keyboard-complete: Pin is enabled immediately (no click), and
  // Radix RadioGroup's roving focus lands on a concrete row that Up/Down then
  // move between. (The dialog only opens for 2+ instances — see selectMentionable.)
  useEffect(() => {
    if (open) setSelected(instances[0] ?? null);
  }, [open, instances]);

  // Enter confirms the current selection — the keyboard counterpart to clicking
  // Pin. Scoped to the list region (below) so it never double-fires with the
  // footer's Cancel / Pin buttons, which own their native Enter activation. The
  // isImeComposing guard is mandatory (CLAUDE.md IME rule): a CJK/JP/KR user
  // pressing Enter to CONFIRM an IME candidate must not accidentally pin.
  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || isImeComposing(e)) return;
    if (!selected) return;
    e.preventDefault();
    onConfirm(selected);
  };

  const distinctHosts = new Set(instances.map((i) => i.host)).size;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent
        className="z-[110] flex max-h-[85svh] flex-col gap-0 sm:max-w-md"
        overlayClassName="z-[110]"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("subtitle", { name: agentName, count: instances.length, hosts: distinctHosts })}
          </DialogDescription>
        </DialogHeader>
        {/* The ONLY scroll region — keeps the header + footer pinned and reachable
            even when the instance list is tall or the soft keyboard shrinks the
            viewport. `min-h-0` lets this flex child shrink below its content height
            so it actually scrolls instead of pushing the footer off-screen. */}
        <div
          className="min-h-0 flex-1 overflow-y-auto py-3"
          onKeyDown={handleListKeyDown}
        >
          <InstancePicker
            instances={instances}
            selectedConnectionUuid={selected?.connectionUuid ?? null}
            onSelect={setSelected}
            ariaLabel={t("title")}
          />
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button
            disabled={!selected}
            onClick={() => {
              if (selected) onConfirm(selected);
            }}
          >
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Confirm handler (extracted + pure, for testability) ────────────────────
//
// Runs when the owner taps "Pin instance" in the secondary picker. The ORDER here
// is the fix for "tapped Pin but the modal didn't close" on mobile: it closes the
// modal FIRST (always), then performs the mention insert deferred + guarded so a
// failing insert can never leave the dialog stuck open. See the call site comment.
interface PendingPick {
  item: Mentionable;
  onlineInstances: InstanceCandidate[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  command: (attrs: any) => void;
}
export function handleInstancePickConfirm(
  pick: PendingPick | null,
  instance: InstanceCandidate,
  deps: {
    close: () => void;
    insert: (pick: PendingPick, instance: InstanceCandidate) => void;
    // Schedule the deferred insert (rAF in the app; synchronous in tests).
    defer: (fn: () => void) => void;
    focusEditor: () => void;
    onError: (err: unknown) => void;
  },
): void {
  // 1. Close the modal unconditionally, before anything that can throw.
  deps.close();
  if (!pick) return;
  // 2. Insert deferred + guarded — never let a failed insert resurface as a stuck modal.
  deps.defer(() => {
    try {
      deps.focusEditor();
      deps.insert(pick, instance);
    } catch (err) {
      deps.onError(err);
    }
  });
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
        // withInstances=1 → candidates carry their live (host, cwd) instances so
        // an agent with 2+ surfaces the secondary picker (cwd-addressable
        // instances, T3). Additive; the suggestion-row rendering is unchanged.
        const res = await fetch(
          `/api/mentionables?q=${encodeURIComponent(query)}&limit=10&withInstances=1`
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

    // ── Secondary instance picker (cwd-addressable instances, T3) ──────────
    //
    // When an agent with 2+ live instances is chosen, defer the mention insert
    // and open this picker so the owner pins which (host, cwd) the wake targets.
    // A single live instance auto-selects (no extra click) — handled inline so
    // we never open the picker for it. An agent with 0/1 instances, or a user,
    // inserts immediately and un-pinned (behaves exactly as before this change).
    const [pendingPick, setPendingPick] = useState<{
      item: Mentionable;
      // The ONLINE instances to offer in the picker (offline is never a wake
      // target, so it is filtered out before the dialog opens).
      onlineInstances: InstanceCandidate[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      command: (attrs: any) => void;
    } | null>(null);

    const insertMention = useCallback(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (item: Mentionable, command: (attrs: any) => void, pin?: InstanceCandidate) => {
        command({
          id: item.uuid,
          label: item.name,
          mentionType: item.type,
          // A pin carries the durable (host, cwd) "place"; null for an un-pinned
          // mention. host "" is preserved (unknown-host instance).
          pinnedHost: pin ? pin.host : null,
          pinnedCwd: pin ? pin.cwd : null,
        });
      },
      [],
    );

    // The renderer calls this when a candidate is chosen. Kept in a ref so the
    // long-lived Tiptap suggestion callbacks always see the current closure.
    const selectMentionableRef = useRef<
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (item: Mentionable, command: (attrs: any) => void) => void
    >(() => {});
    selectMentionableRef.current = (item, command) => {
      const liveInstances =
        item.type === "agent"
          ? (item.instances ?? []).filter((i) => i.effectiveStatus === "online")
          : [];
      if (liveInstances.length >= 2) {
        // Multiple live (online) instances: open the picker over the online set,
        // defer the insert.
        setPendingPick({ item, onlineInstances: liveInstances, command });
        return;
      }
      if (liveInstances.length === 1) {
        // Exactly one live instance: auto-select it, no extra interaction.
        insertMention(item, command, liveInstances[0]);
        return;
      }
      // No live instances (or a user): un-pinned mention, exactly as before.
      insertMention(item, command);
    };

    // Stable wrapper passed to the (long-lived) renderer; always dispatches to
    // the current selectMentionableRef closure so there is no stale capture.
    const selectMentionable = useCallback(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (item: Mentionable, command: (attrs: any) => void) =>
        selectMentionableRef.current(item, command),
      [],
    );

    // Re-render popup when items change
    useEffect(() => {
      if (popupRef.current && currentCommandRef.current) {
        createSuggestionPopupRenderer(
          suggestionItemsRef.current,
          suggestionLoadingRef.current,
          currentCommandRef.current,
          keyDownRef,
          popupRef.current,
          labelsRef.current,
          selectMentionable
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
                    labelsRef.current,
                    selectMentionable
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
                      labelsRef.current,
                      selectMentionable
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
        {/* Secondary instance picker — opened only for an agent with 2+ ONLINE
            instances (cwd-addressable instances). Offline instances are filtered
            out before the dialog opens (never a wake target). */}
        <MentionInstancePickerDialog
          open={pendingPick !== null}
          agentName={pendingPick?.item.name ?? ""}
          instances={pendingPick?.onlineInstances ?? []}
          onConfirm={(instance) => {
            // Close the modal FIRST and unconditionally, then insert deferred +
            // guarded. The insert runs the Tiptap suggestion `command` captured when
            // the picker opened; by now the editor has blurred (the Radix dialog
            // stole focus) so that command can throw or no-op — especially on mobile
            // Safari. If the insert ran before the close and threw, the dialog would
            // stay open after a successful tap (looks like "Pin does nothing").
            // handleInstancePickConfirm enforces close-first + guarded-deferred-insert.
            handleInstancePickConfirm(pendingPick, instance, {
              close: () => setPendingPick(null),
              insert: (pick, inst) => insertMention(pick.item, pick.command, inst),
              defer: (fn) => requestAnimationFrame(fn),
              focusEditor: () => editor?.commands.focus(),
              onError: (err) =>
                clientLogger.error(
                  "MentionEditor: cwd-pinned mention insert failed",
                  err,
                ),
            });
          }}
          onCancel={() => setPendingPick(null)}
        />
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
