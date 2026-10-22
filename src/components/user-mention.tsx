"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useOptionalAuth } from "@/contexts/auth-context";
import { extractMentions } from "@/components/mention-renderer";

const UserMentionNames = createContext<ReadonlyMap<string, string>>(new Map());

export function UserMentionProvider({
  targetType,
  targetUuid,
  comments,
  children,
}: {
  targetType: "idea" | "proposal" | "task" | "document";
  targetUuid: string;
  comments: readonly { content: string }[];
  children: ReactNode;
}) {
  const auth = useOptionalAuth();
  const actorUuid = auth?.user?.uuid;
  const companyUuid = auth?.company?.uuid;
  const ownName = auth?.user?.name?.trim() || auth?.user?.email;
  const ownNameRef = useRef(ownName);
  useEffect(() => { ownNameRef.current = ownName; }, [ownName]);
  const scope = JSON.stringify([companyUuid, actorUuid, targetType, targetUuid]);
  const request = useMemo(() => ({ scope, userUuids: [...new Set(comments.flatMap(comment =>
    extractMentions(comment.content)
      .filter(mention => mention.type === "user")
      .map(mention => mention.uuid),
  ))].sort() }), [comments, scope]);
  const { userUuids } = request;
  const [resolved, setResolved] = useState<{ scope: string; userUuids: string[]; ownNameAtStart: string | undefined; names: Map<string, string> } | null>(null);

  useEffect(() => {
    if (!actorUuid || !companyUuid || userUuids.length === 0) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const ownNameAtStart = ownNameRef.current;
    const resolve = async () => {
      const names = new Map<string, string>();
      try {
        for (let offset = 0; offset < userUuids.length; offset += 100) {
          const batch = userUuids.slice(offset, offset + 100);
          const response = await fetch("/api/mentionables/resolve", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userUuids: batch, entityType: targetType, entityUuid: targetUuid }),
          });
          if (!response.ok) throw new Error("Mention resolution failed");
          const result = await response.json();
          if (result?.success !== true || !Array.isArray(result.data?.users)) {
            throw new Error("Invalid mention resolution");
          }
          for (const user of result.data.users) {
            if (user && batch.includes(user.uuid) && typeof user.name === "string" && user.name.trim()) {
              names.set(user.uuid, user.name);
            }
          }
        }
        if (!controller.signal.aborted) setResolved({ scope, userUuids, ownNameAtStart, names });
      } catch {
        if (!controller.signal.aborted) setResolved({ scope, userUuids, ownNameAtStart, names: new Map() });
      } finally {
        clearTimeout(timeout);
      }
    };
    void resolve();
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [actorUuid, companyUuid, scope, targetType, targetUuid, userUuids]);

  const names = useMemo(() => {
    const current = new Map(resolved?.scope === scope && resolved.userUuids === userUuids ? resolved.names : []);
    if (actorUuid && current.has(actorUuid) && ownName !== resolved?.ownNameAtStart) {
      if (ownName) current.set(actorUuid, ownName);
    }
    return current;
  }, [resolved, scope, userUuids, actorUuid, ownName]);

  return <UserMentionNames.Provider value={names}>{children}</UserMentionNames.Provider>;
}

export function UserMention({ uuid, fallback }: { uuid: string; fallback: string }) {
  const names = useContext(UserMentionNames);
  return <span className="text-primary font-medium" title={`user: ${uuid}`}>@{names.get(uuid) ?? fallback}</span>;
}
