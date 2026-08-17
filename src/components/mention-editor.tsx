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
import { getAgentAvatarDataUri } from "@/components/ui/agent-avatar";

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
      runtimeCwd: {
        default: false,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-runtime-cwd") === "true",
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.runtimeCwd ? { "data-runtime-cwd": "true" } : {},
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
  // Direct-idea entity-context enrichment (pin-cwd-before-wake, Part 2b), mirrored
  // from the service `Mentionable` shape (mention.service.ts). Populated for
  // `type: "agent"` candidates ONLY when the editor requests entity context
  // (entityType + entityUuid) AND that entity resolves to a DIRECT idea (the idea
  // the comment attaches to — for an idea entity itself, NOT its lineage root).
  // `isIdeaAssignee` is true iff this candidate agent is the owning agent of
  // that idea's assignee. `ideaPin` rides ONLY on the assignee candidate,
  // and only when that idea is instance-pinned — the editor inherits it with
  // NO picker (HARD pin: the wake is notify-only if offline, never re-routed).
  isIdeaAssignee?: boolean;
  ideaPin?: {
    host: string;
    cwd: string | null;
    agentInstanceUuid: string;
  };
  projectFixedCwd?: {
    host: string;
    cwd: string;
    availability: "ready" | "offline" | "invalid";
  };
}

// The durable (host, cwd) "place" a mention pins to. A structural subset of both
// InstanceCandidate (online picker candidate) and the direct idea's inherited
// `ideaPin` (which may be offline and has no connectionUuid) — the mention
// markup only ever needs host + cwd.
export interface MentionPin {
  host: string;
  cwd: string | null;
  runtimeCwd?: boolean;
}

// The decision the mention-selection precedence yields for a chosen candidate:
//   - "insert" → insert the mention now (pinned to `pin`, or un-pinned when null),
//   - "pick"   → defer the insert and open the secondary picker over `onlineInstances`.
export type MentionSelection =
  | { kind: "insert"; pin: MentionPin | null }
  | { kind: "pick"; onlineInstances: InstanceCandidate[] };

/**
 * Decide what happens when an @mention candidate is chosen (pin-cwd-before-wake,
 * Part 2b). Pure + exported so the precedence can be unit-tested without booting
 * a Tiptap editor. Precedence (first match wins):
 *
 *  1. The candidate IS the direct idea's assignee agent AND that idea is
 *     instance-pinned (`ideaPin`) → INSERT pinned to the inherited
 *     `(host, cwd)`, with NO picker — EVEN IF that place is currently offline /
 *     not among the agent's online instances. This is a HARD inherited pin: the
 *     resulting wake is notify-only if offline, never re-routed to another cwd.
 *     Not gated by online status.
 *  2. The candidate IS the direct idea's assignee agent, has NO inherited pin, and
 *     has ≥2 online instances → PICK (open the picker; the idea is unpinned so we
 *     prompt on genuine ambiguity).
 *  3. Otherwise (NOT the assignee, or ≤1 online) → the existing online-instance
 *     rule: ≥2 online → PICK; exactly 1 online → INSERT auto-pinned to it; 0
 *     online (or a user candidate) → INSERT un-pinned. This choice is NOT
 *     persisted to the idea.
 */
export function resolveMentionSelection(item: Mentionable): MentionSelection {
  // A project-level preference takes over historical per-Idea assignments. The
  // runtime marker is required so the server routes by host and runs in the
  // configured cwd instead of treating the value as an exact daemon instance.
  if (item.type === "agent" && item.projectFixedCwd) {
    return {
      kind: "insert",
      pin: {
        host: item.projectFixedCwd.host,
        cwd: item.projectFixedCwd.cwd,
        runtimeCwd: true,
      },
    };
  }

  // Rule 1: inherit the direct idea's pin (HARD) — not filtered by online status.
  if (item.isIdeaAssignee && item.ideaPin) {
    return {
      kind: "insert",
      pin: { host: item.ideaPin.host, cwd: item.ideaPin.cwd },
    };
  }

  const onlineInstances =
    item.type === "agent"
      ? (item.instances ?? []).filter((i) => i.effectiveStatus === "online")
      : [];

  // Rules 2 + 3 share the same online-instance rule; the assignee-vs-not
  // distinction only mattered for the inherited-pin fast path above. With no
  // inheritable pin, an assignee with ≥2 online instances and any other agent
  // with ≥2 online instances both open the picker.
  if (onlineInstances.length >= 2) {
    return { kind: "pick", onlineInstances };
  }
  if (onlineInstances.length === 1) {
    return { kind: "insert", pin: onlineInstances[0] };
  }
  return { kind: "insert", pin: null };
}

export interface MentionEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  onSubmit?: () => void;
  // Optional comment entity context (pin-cwd-before-wake, Part 2b). When BOTH
  // are supplied they are forwarded to `/api/mentionables` (alongside
  // withInstances=1) so agent candidates carry the comment's direct-idea
  // assignee/pin annotation, letting the editor inherit the idea's pin instead
  // of prompting. Threaded in by the single production caller (UnifiedComments),
  // which already knows the comment's targetType/targetUuid.
  entityType?: "idea" | "proposal" | "task" | "document";
  entityUuid?: string;
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
      const attrs = node.attrs as Record<string, string | boolean | null> | undefined;
      if (attrs) {
        // Serialize via the shared codec so the optional pinned (host, cwd)
        // suffix matches what the service parser reads. Un-pinned (both null) →
        // byte-identical to the legacy `@[Name](type:uuid)` form.
        return buildMentionMarker(
          (attrs.label || attrs.id) as string,
          ((attrs.mentionType as string) || "user") as "user" | "agent",
          attrs.id as string,
          (attrs.pinnedHost as string | null) ?? null,
          (attrs.pinnedCwd as string | null) ?? null,
          attrs.runtimeCwd === true,
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

      const { pinnedHost, pinnedCwd, runtimeCwd } = decodePinSuffix(match[4]);
      inlineContent.push({
        type: "mention",
        attrs: {
          id: match[3],
          label: match[1],
          mentionType: match[2],
          pinnedHost,
          pinnedCwd,
          runtimeCwd: runtimeCwd === true,
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
    empty.className = "py-2 px-3 text-xs text-muted-foreground";
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
          ? "bg-background text-foreground"
          : "text-muted-foreground hover:bg-background"
      }`;
      btn.onclick = () => doCommand(item);

      // Avatar wrapped in a relative container so the agent presence dot can sit
      // at the bottom-right corner of the avatar (the conventional presence-dot
      // position), rather than on a separate status line.
      const avatarWrap = document.createElement("div");
      avatarWrap.className = "relative shrink-0";

      // Agents render the shared DiceBear Voxel Bot avatar (same seed = name as the
      // React <AgentAvatar>). This is raw-DOM, so we mount the generated data URI
      // on an <img>; on a generation failure we fall back to the Bot glyph. Users
      // keep the plain User-icon avatar tile, unchanged. Reduced-motion is read
      // synchronously here (client-only render path) to pick the static form.
      if (item.type === "agent") {
        const prefersReducedMotion =
          typeof window !== "undefined" &&
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const uri = getAgentAvatarDataUri(
          item.name,
          prefersReducedMotion ? "static" : "animated",
        );
        if (uri) {
          // Clip box so the face-zoom (scale + origin-top, mirroring
          // FACE_ZOOM_CLASS in <AgentAvatar>) is cropped to the head; the presence
          // dot stays on avatarWrap (outside this box) so it is not clipped.
          const imgBox = document.createElement("div");
          imgBox.className = "h-6 w-6 overflow-hidden rounded-full bg-muted";
          const img = document.createElement("img");
          img.src = uri;
          img.alt = item.name;
          img.draggable = false;
          img.className = "h-full w-full origin-top scale-[1.5]";
          imgBox.appendChild(img);
          avatarWrap.appendChild(imgBox);
        } else {
          const avatar = document.createElement("div");
          avatar.className =
            "flex h-6 w-6 items-center justify-center rounded-full bg-primary text-white";
          avatar.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';
          avatarWrap.appendChild(avatar);
        }
      } else {
        const avatar = document.createElement("div");
        avatar.className =
          "flex h-6 w-6 items-center justify-center rounded-full bg-border text-muted-foreground";
        avatar.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
        avatarWrap.appendChild(avatar);
      }

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
        emailEl.className = "truncate text-[10px] text-muted-foreground";
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
            "mt-0.5 truncate text-[10px] font-medium text-[#15803D] dark:text-[#4FD07A]";
          statusEl.textContent = `▶ ${labels.activeCount(count)}`;
        } else {
          statusEl.className = "mt-0.5 truncate text-[10px] text-muted-foreground";
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
  (
    {
      value,
      onChange,
      placeholder,
      className,
      disabled,
      onSubmit,
      entityType,
      entityUuid,
    },
    ref,
  ) => {
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
        //
        // entityType/entityUuid (pin-cwd-before-wake, Part 2b) ride alongside
        // withInstances when both are known, so agent candidates carry the
        // comment's direct-idea assignee/pin annotation (isIdeaAssignee /
        // ideaPin). Appended only when both are present — otherwise the query
        // is byte-identical to before and the search is unchanged.
        let url = `/api/mentionables?q=${encodeURIComponent(query)}&limit=10&withInstances=1`;
        if (entityType && entityUuid) {
          url += `&entityType=${encodeURIComponent(entityType)}&entityUuid=${encodeURIComponent(entityUuid)}`;
        }
        const res = await fetch(url);
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
    }, [entityType, entityUuid]);

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
      // The pin only needs the durable (host, cwd) "place" for the mention markup
      // — NOT the full InstanceCandidate. Widened to `{ host, cwd }` so BOTH an
      // online InstanceCandidate (secondary picker / auto-pin) AND the direct idea's
      // inherited `ideaPin` (which has no connectionUuid — it may be offline)
      // satisfy it structurally.
      (
        item: Mentionable,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        command: (attrs: any) => void,
        pin?: { host: string; cwd: string | null; runtimeCwd?: boolean },
      ) => {
        command({
          id: item.uuid,
          label: item.name,
          mentionType: item.type,
          // A pin carries the durable (host, cwd) "place"; null for an un-pinned
          // mention. host "" is preserved (unknown-host instance).
          pinnedHost: pin ? pin.host : null,
          pinnedCwd: pin ? pin.cwd : null,
          runtimeCwd: pin?.runtimeCwd === true,
        });
      },
      [],
    );

    // The renderer calls this when a candidate is chosen. Kept in a ref so the
    // long-lived Tiptap suggestion callbacks always see the current closure. It
    // delegates the decision to the exported pure `resolveMentionSelection`
    // (below) and performs the resulting effect (insert vs. open picker).
    const selectMentionableRef = useRef<
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (item: Mentionable, command: (attrs: any) => void) => void
    >(() => {});
    selectMentionableRef.current = (item, command) => {
      const decision = resolveMentionSelection(item);
      if (decision.kind === "pick") {
        // Open the picker over the online set, defer the insert.
        setPendingPick({ item, onlineInstances: decision.onlineInstances, command });
        return;
      }
      // insert (pinned to decision.pin, or un-pinned when pin is null).
      insertMention(item, command, decision.pin ?? undefined);
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
                    "z-[100] rounded-md border border-border bg-card shadow-md min-w-[200px] max-w-[300px] overflow-hidden";
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
