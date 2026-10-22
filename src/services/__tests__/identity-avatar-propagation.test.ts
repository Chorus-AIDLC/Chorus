import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  user: { findMany: vi.fn() },
  agent: { findMany: vi.fn() },
  agentInstance: { findMany: vi.fn() },
  task: { findFirst: vi.fn() },
  comment: { findMany: vi.fn(), count: vi.fn() },
  activity: { findMany: vi.fn(), count: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: database }));
vi.mock("@/services/mention.service", () => ({}));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: vi.fn(), emit: vi.fn() } }));

import { batchResolveActorIdentities, formatCreatedBy } from "@/lib/uuid-resolver";
import { listComments } from "@/services/comment.service";
import { listActivitiesWithActorNames } from "@/services/activity.service";

const companyUuid = "tenant-visible";
const timestamp = new Date("2020-01-01T00:00:00Z");
const actors = [
  { type: "user", uuid: "shared" },
  { type: "agent", uuid: "shared" },
  { type: "user", uuid: "foreign" },
  { type: "user", uuid: "missing" },
];
let seed = "current-seed";

beforeEach(() => {
  vi.resetAllMocks();
  seed = "current-seed";
  database.user.findMany.mockImplementation(async ({ where }) => {
    const users = [
      { uuid: "shared", companyUuid, name: "Human", email: "human@example.com", avatarSeed: seed },
      { uuid: "foreign", companyUuid: "another-tenant", name: "Private", avatarSeed: "secret-seed" },
      { uuid: "unrequested", companyUuid, name: "Not returned", avatarSeed: "unrequested-seed" },
    ];
    return users.filter(user => user.companyUuid === where.companyUuid && where.uuid.in.includes(user.uuid));
  });
  database.agent.findMany.mockResolvedValue([{ uuid: "shared", name: "Agent" }]);
  database.task.findFirst.mockResolvedValue({ uuid: "task" });
  database.comment.findMany.mockResolvedValue(actors.map((actor, index) => ({
    uuid: `comment-${index}`, targetType: "task", targetUuid: "task", content: "Historical comment",
    authorType: actor.type, authorUuid: actor.uuid, createdAt: timestamp, updatedAt: timestamp,
  })));
  database.comment.count.mockResolvedValue(actors.length);
});

describe("authorized identity avatar propagation", () => {
  it("batches only supplied human IDs within their tenant and separates actor kinds", async () => {
    const result = await batchResolveActorIdentities(companyUuid, [...actors, actors[0]]);
    expect(database.user.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { companyUuid, uuid: { in: ["shared", "foreign", "missing"] } },
      select: { uuid: true, name: true, email: true, avatarSeed: true },
    });
    expect(result.get("user:shared")).toEqual({ type: "user", uuid: "shared", name: "Human", avatarSeed: seed });
    expect(result.get("agent:shared")).toEqual({ type: "agent", uuid: "shared", name: "Agent" });
    expect(result.has("user:foreign")).toBe(false);
    expect(result.has("user:missing")).toBe(false);
    expect(result.has("user:unrequested")).toBe(false);
    expect(database.agentInstance.findMany).not.toHaveBeenCalled();
  });

  it("does not query a directory for an empty or agent-only identity set", async () => {
    expect(await batchResolveActorIdentities(companyUuid, [])).toEqual(new Map());
    await batchResolveActorIdentities(companyUuid, [{ type: "agent", uuid: "shared" }]);
    expect(database.user.findMany).not.toHaveBeenCalled();
    expect(await formatCreatedBy("shared", "agent", companyUuid)).not.toHaveProperty("avatarSeed");
    expect(database.user.findMany).not.toHaveBeenCalled();
  });

  it.each([false, true])("reads current seeds for historical comments, cursor mode=%s", async cursor => {
    const params = { companyUuid, targetType: "task" as const, targetUuid: "task", ...(cursor ? { limit: 20 } : { skip: 0, take: 20 }) };
    const first = await listComments(params);
    expect(first.comments[0].author.avatarSeed).toBe("current-seed");
    expect(first.comments[0].createdAt).toBe(timestamp.toISOString());
    expect(first.comments[1].author).toEqual({ type: "agent", uuid: "shared", name: "Agent" });
    expect(first.comments[2].author.avatarSeed).toBeNull();
    expect(first.comments[3].author.avatarSeed).toBeNull();
    expect(database.user.findMany).toHaveBeenCalledTimes(1);
    seed = "newly-saved-seed";
    expect((await listComments(params)).comments[0].author.avatarSeed).toBe(seed);
    expect(database.user.findMany).toHaveBeenCalledTimes(2);
    expect(database.comment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyUuid, targetType: "task", targetUuid: "task" }),
    }));
  });

  it("does not resolve identities when the scoped comment target is missing", async () => {
    database.task.findFirst.mockResolvedValue(null);
    expect(await listComments({ companyUuid, targetType: "task", targetUuid: "foreign-task", skip: 0, take: 20 })).toEqual({ comments: [], total: 0 });
    expect(database.user.findMany).not.toHaveBeenCalled();
    expect(database.comment.findMany).not.toHaveBeenCalled();
  });

  it("enriches activity human actors in one batch without changing the project filter", async () => {
    database.activity.findMany.mockResolvedValue(actors.map((actor, index) => ({
      uuid: `activity-${index}`, targetType: "task", targetUuid: "task", action: "updated",
      actorType: actor.type, actorUuid: actor.uuid, createdAt: timestamp,
    })));
    database.activity.count.mockResolvedValue(actors.length);
    const result = await listActivitiesWithActorNames({ companyUuid, projectUuid: "authorized-project", skip: 0, take: 20 });
    expect(result.activities[0]).toMatchObject({ actorType: "user", actorUuid: "shared", actorAvatarSeed: seed });
    expect(result.activities[1]).not.toHaveProperty("actorAvatarSeed");
    expect(result.activities[2].actorAvatarSeed).toBeNull();
    expect(database.user.findMany).toHaveBeenCalledTimes(1);
    expect(database.activity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyUuid, projectUuid: "authorized-project" } }));
  });
});
