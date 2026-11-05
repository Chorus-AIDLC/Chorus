import { createHash } from "node:crypto";

const NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");

export function backendSessionKey(anchor, agentUuid) {
  if (typeof anchor !== "string" || !anchor || typeof agentUuid !== "string" || !agentUuid.trim()) return anchor;
  const digest = createHash("sha1")
    .update(NAMESPACE)
    .update(JSON.stringify(["chorus-backend-session", agentUuid, anchor]))
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
