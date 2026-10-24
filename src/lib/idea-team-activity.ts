import type { Prisma } from "@/generated/prisma/client";

export function publicActivityValue(value: Prisma.JsonValue): Prisma.JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "ideaTeamFences"));
}
