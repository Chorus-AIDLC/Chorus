export function parseScopedAnchor(sessionId) {
  if (typeof sessionId !== "string") return null;
  const task = /^task:([^:\s]+)$/.exec(sessionId);
  if (task) return { kind: "task", entityType: "task", entityUuid: task[1] };
  const review = /^review:(task|proposal|idea):([^:\s]+)$/.exec(sessionId);
  return review
    ? { kind: "review", entityType: review[1], entityUuid: review[2] }
    : null;
}

export function executionKey(entityType, entityUuid, sessionId = "") {
  return `${entityType}:${entityUuid}${sessionId ? `|session:${sessionId}` : ""}`;
}
