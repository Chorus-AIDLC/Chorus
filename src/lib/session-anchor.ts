// Shared session business keys. Idea and ad-hoc keys remain unchanged.
export type SessionAnchorEntityType = "task" | "proposal" | "idea";
export type SessionAnchor =
  | { kind: "idea"; sessionId: string }
  | { kind: "task"; sessionId: string; entityType: "task"; entityUuid: string }
  | { kind: "review"; sessionId: string; entityType: SessionAnchorEntityType; entityUuid: string }
  | { kind: "adhoc"; sessionId: string };

export function formatSessionAnchor(
  kind: "idea" | "task" | "review",
  entityType: SessionAnchorEntityType,
  entityUuid: string,
): string {
  if (kind === "idea") return entityUuid;
  return kind === "task" ? `task:${entityUuid}` : `review:${entityType}:${entityUuid}`;
}

export function parseSessionAnchor(sessionId: string, directIdeaUuid?: string | null): SessionAnchor {
  const task = /^task:([^:\s]+)$/.exec(sessionId);
  if (task) return { kind: "task", sessionId, entityType: "task", entityUuid: task[1] };
  const review = /^review:(task|proposal|idea):([^:\s]+)$/.exec(sessionId);
  if (review) return { kind: "review", sessionId, entityType: review[1] as SessionAnchorEntityType, entityUuid: review[2] };
  return { kind: sessionId === directIdeaUuid ? "idea" : "adhoc", sessionId };
}
