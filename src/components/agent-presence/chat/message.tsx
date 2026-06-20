"use client";

// One transcript message inside a turn band (子3 — chat-style daemon UI).
//
// Deliberately NOT a mirrored left/right chat bubble. The right pane is a session
// TRANSCRIPT — an execution record that reads top-to-bottom like a log — so every
// message is a quiet, left-aligned block: a small role label (`You` for the human
// `user` side, the agent's name for `assistant`), the text, and a monospace
// timestamp. The boldness budget is spent on the turn band's spine/eyebrow, not
// here, so this stays disciplined and uniform.
//
// Presentational + prop-driven (no fetching). Reuses the warm-deck vocabulary
// (#2C2C2C text, #9A9A9A muted, Geist Mono for the timestamp) so it reads as the
// same surface as the connections deck.

import { useTranslations } from "next-intl";
import { MarkdownContent } from "@/components/markdown-content";
import type { TranscriptMessageView } from "@/services/daemon-session.service";

// Locale-aware HH:MM:SS for a single message. The format itself carries no
// translatable copy (it's a clock), so it is derived from the ISO string via the
// platform formatter rather than an i18n key — same approach the duration mono
// uses for its tick. Guarded against an unparseable date (renders nothing rather
// than "Invalid Date").
function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function Message({
  message,
  agentName,
}: {
  message: TranscriptMessageView;
  // The owning agent's display name, used as the `assistant` role label so a
  // reader sees who replied (not a generic "Assistant").
  agentName: string;
}) {
  const t = useTranslations("daemonChat");
  const isUser = message.role === "user";
  const roleLabel = isUser ? t("roleYou") : agentName || t("roleAgent");
  const clock = formatClock(message.createdAt);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span
          className={`text-[11px] font-semibold uppercase tracking-wide ${
            isUser ? "text-[#C67A52]" : "text-[#6B6B6B]"
          }`}
        >
          {roleLabel}
        </span>
        {clock && (
          <span className="font-mono text-[10px] tabular-nums text-[#9A9A9A]">
            {clock}
          </span>
        )}
      </div>
      {isUser ? (
        // The human side is the literal instruction the user typed — render it
        // verbatim (pre-wrapped) so their exact text, whitespace, and any stray
        // markdown characters are shown as-typed, not reinterpreted.
        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[#2C2C2C]">
          {message.text}
        </p>
      ) : (
        // Agent replies are Markdown — render them with the shared Chorus
        // MarkdownContent (Streamdown: code blocks, lists, tables, mermaid) so a
        // transcript reads like the rest of the app, not a flat wall of text.
        // `prose prose-sm max-w-none` scopes typography to the compact transcript
        // size, matching the idea/comment renderers.
        <div className="prose prose-sm max-w-none break-words text-[13px] leading-relaxed text-[#2C2C2C]">
          <MarkdownContent>{message.text}</MarkdownContent>
        </div>
      )}
    </div>
  );
}
