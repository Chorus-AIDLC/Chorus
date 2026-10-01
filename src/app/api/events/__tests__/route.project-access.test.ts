import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
// A real EventEmitter-backed bus so on/emit/off behave like the production bus.
const { bus } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return { bus: emitter };
});

const mockGetAuthContext = vi.fn();
const mockAccessibleProjectUuids = vi.fn();
const mockGetGroupAccess = vi.fn();
vi.mock("@/services/project-group-access.service", () => ({
  getGroupAccess: (...args: unknown[]) => mockGetGroupAccess(...args),
}));

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

vi.mock("@/lib/event-bus", () => ({ eventBus: bus }));

// idea → project (current); session activity / execution rows resolve through it.
const ideaProjects = new Map<string, string>();
const failingIdeas = new Set<string>();

vi.mock("@/services/project-access.service", () => ({
  accessibleProjectUuids: (...args: unknown[]) => mockAccessibleProjectUuids(...args),
  resolveEntityProjectUuid: async (_c: string, _t: string, uuid: string) => {
    if (failingIdeas.has(uuid)) throw new Error("db down");
    return ideaProjects.get(uuid) ?? null;
  },
  // Faithful stand-in for the shared rule (its real implementation is unit-tested in
  // project-access.service.test.ts): drop rows whose own project is hidden, redact
  // hidden direct/root anchors.
  filterExecutionViewsByAccess: async (
    _auth: unknown,
    rows: { projectUuid: string | null; directIdeaUuid: string | null; rootIdeaUuid: string | null }[],
    visible: ReadonlySet<string>,
  ) => {
    const ok = (idea: string | null) => (idea ? visible.has(ideaProjects.get(idea) ?? "") : null);
    return rows.flatMap((r) => {
      const d = ok(r.directIdeaUuid), root = ok(r.rootIdeaUuid);
      const own = r.projectUuid ? visible.has(r.projectUuid) : d ?? root ?? true;
      if (!own) return [];
      return [{ ...r, ...(d === false ? { directIdeaUuid: null } : {}), ...(root === false ? { rootIdeaUuid: null, rootIdeaTitle: null } : {}) }];
    });
  },
  membershipPrincipal: (auth: { type: string; actorUuid: string; ownerUuid?: string }) =>
    auth.type === "user" ? auth.actorUuid : auth.type === "agent" ? (auth.ownerUuid ?? null) : null,
}));

vi.mock("@/services/daemon-connection.service", () => ({
  parseSelfReport: () => null,
  registerConnection: async () => null,
  isConnectionConflict: () => false,
  touchConnection: vi.fn(),
  markDisconnected: vi.fn(),
  STALE_THRESHOLD_MS: 90_000,
}));

vi.mock("@/services/daemon-execution.service", () => ({
  reconcileOffline: vi.fn(async () => 0),
  publishExecutionChange: vi.fn(async () => undefined),
  listVisibleConnectionUuids: vi.fn(async () => []),
  executionEventName: (uuid: string) => `execution:${uuid}`,
}));

vi.mock("@/services/daemon-session.service", () => ({
  isSessionVisibleToCaller: vi.fn(async () => false),
  listVisibleRunningSessionActivities: vi.fn(async () => []),
  SESSION_ACTIVITY_EVENT_NAME: "session_activity",
  transcriptEventName: (uuid: string) => `transcript:${uuid}`,
  reconcileOrphanTurns: vi.fn(async () => 0),
}));

import { GET } from "@/app/api/events/route";

// ===== Fixtures =====
const companyUuid = "company-1";
const memberUuid = "user-member";
const outsiderUuid = "user-outsider";
const ownerUuid = memberUuid;
const PUBLIC_P = "proj-public";
const PRIVATE_P = "proj-private";

const memberAuth = { type: "user", companyUuid, actorUuid: memberUuid, permissions: [] };
const outsiderAuth = { type: "user", companyUuid, actorUuid: outsiderUuid, permissions: [] };
const ownedAgentAuth = {
  type: "agent",
  companyUuid,
  actorUuid: "agent-1",
  ownerUuid,
  permissions: [],
};

// Simulated access model: public projects + private memberships keyed by user.
let publicProjects: Set<string>;
let privateMembers: Map<string, Set<string>>;

function principalOf(auth: { type: string; actorUuid: string; ownerUuid?: string }) {
  return auth.type === "user" ? auth.actorUuid : (auth.ownerUuid ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
  bus.removeAllListeners();
  publicProjects = new Set([PUBLIC_P]);
  privateMembers = new Map([[PRIVATE_P, new Set([memberUuid])]]);
  mockGetGroupAccess.mockResolvedValue({ group: { uuid: "g1" } });
  mockAccessibleProjectUuids.mockImplementation(
    async (auth: { type: string; actorUuid: string; ownerUuid?: string }) => {
      const p = principalOf(auth);
      const out = [...publicProjects];
      for (const [proj, members] of privateMembers) {
        if (p && members.has(p)) out.push(proj);
      }
      return out;
    },
  );
});

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

async function connect(auth: object, query = "") {
  mockGetAuthContext.mockResolvedValue(auth);
  const ac = new AbortController();
  const url = `http://localhost:3000/api/events${query ? `?${query}` : ""}`;
  const res = await GET(new NextRequest(new URL(url), { signal: ac.signal }));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // closed
    }
  })();
  await flush();
  const dataEvents = () =>
    chunks
      .join("")
      .split("\n\n")
      .filter((c) => c.startsWith("data: "))
      .map((c) => JSON.parse(c.slice(6)) as Record<string, unknown>);
  return { ac, dataEvents };
}

function change(projectUuid: string, extra: Record<string, unknown> = {}) {
  return {
    companyUuid,
    projectUuid,
    entityType: "task",
    entityUuid: `task-${projectUuid}`,
    action: "updated",
    ...extra,
  };
}

function presence(projectUuid: string) {
  return {
    companyUuid,
    projectUuid,
    entityType: "task",
    entityUuid: `task-${projectUuid}`,
    agentUuid: "agent-x",
    agentName: "X",
    action: "view",
    timestamp: 1,
  };
}

describe("GET /api/events — private project isolation", () => {
  it("non-member receives no change/presence events for a private project", async () => {
    const { dataEvents } = await connect(outsiderAuth);
    bus.emit("change", change(PRIVATE_P));
    bus.emit("presence", presence(PRIVATE_P));
    await flush();
    expect(dataEvents()).toEqual([]);
  });

  it("member receives change/presence events for a private project", async () => {
    const { dataEvents } = await connect(memberAuth);
    bus.emit("change", change(PRIVATE_P));
    bus.emit("presence", presence(PRIVATE_P));
    await flush();
    const evs = dataEvents();
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ projectUuid: PRIVATE_P, entityType: "task" });
    expect(evs[1]).toMatchObject({ type: "presence", projectUuid: PRIVATE_P });
  });

  it("agent inherits its owner's private-project access", async () => {
    const { dataEvents } = await connect(ownedAgentAuth);
    bus.emit("change", change(PRIVATE_P));
    await flush();
    expect(dataEvents()).toHaveLength(1);
    expect(mockAccessibleProjectUuids).toHaveBeenCalledWith(ownedAgentAuth);
  });

  it("public-project events are delivered to everyone (members, outsiders, agents)", async () => {
    const a = await connect(memberAuth);
    const b = await connect(outsiderAuth);
    const c = await connect(ownedAgentAuth);
    bus.emit("change", change(PUBLIC_P));
    bus.emit("presence", presence(PUBLIC_P));
    await flush();
    for (const s of [a, b, c]) expect(s.dataEvents()).toHaveLength(2);
  });

  it("Redis-relayed (_remote) events are filtered identically", async () => {
    const { dataEvents } = await connect(outsiderAuth);
    bus.emit("change", { ...change(PRIVATE_P), _remote: true });
    bus.emit("change", { ...change(PUBLIC_P), _remote: true });
    await flush();
    expect(dataEvents().map((e) => e.projectUuid)).toEqual([PUBLIC_P]);
  });

  it("discovery-checks projectless group events and preserves unscoped company events", async () => {
    const { dataEvents } = await connect(outsiderAuth);
    bus.emit("change", {
      companyUuid,
      projectUuid: "group-uuid-not-a-project",
      entityType: "project_group",
      entityUuid: "g1",
      action: "updated",
    });
    bus.emit("change", { companyUuid, entityType: "task", entityUuid: "t", action: "updated" });
    bus.emit("change", {
      companyUuid: "other-company",
      entityType: "project_group",
      entityUuid: "g2",
      action: "updated",
    });
    await flush();
    expect(dataEvents()).toHaveLength(2);
    expect(mockGetGroupAccess).toHaveBeenCalledWith(outsiderAuth, "g1");
  });

  it("withholds hidden private-group metadata even with an empty projectUuid", async () => {
    mockGetGroupAccess.mockResolvedValue({ group: null });
    const { dataEvents } = await connect(outsiderAuth);
    bus.emit("change", change("", { entityType: "project_group", entityUuid: "hidden-group", name: "Secret" }));
    await flush();
    expect(dataEvents()).toEqual([]);
  });

  it("delivers project-only group metadata after fresh discovery", async () => {
    mockGetGroupAccess.mockResolvedValue({ group: { uuid: "g1" }, level: "viewer", explicitRole: null, canManage: false });
    const { dataEvents } = await connect(memberAuth);
    bus.emit("change", change("", { entityType: "project_group", entityUuid: "g1" }));
    await flush();
    expect(dataEvents()).toHaveLength(1);
  });

  it("rechecks discovery when group revocation races an in-flight group delivery", async () => {
    const { dataEvents } = await connect(ownedAgentAuth);
    let release!: () => void;
    mockGetGroupAccess.mockImplementationOnce(() =>
      new Promise((resolve) => { release = () => resolve({ group: { uuid: "g1" } }); }),
    );
    mockGetGroupAccess.mockResolvedValue({ group: null });
    bus.emit("change", change("", { entityType: "project_group", entityUuid: "g1" }));
    await flush();
    privateMembers.get(PRIVATE_P)!.delete(ownerUuid);
    bus.emit("project_access_changed", { companyUuid, projectUuid: PRIVATE_P, userUuids: [ownerUuid] });
    bus.emit("change", change(PRIVATE_P));
    release();
    await flush();
    expect(dataEvents()).toEqual([]);
    expect(mockGetGroupAccess).toHaveBeenCalledTimes(2);
  });

  it("rechecks a racing revoke in an empty group even when no child refresh exists", async () => {
    const { dataEvents } = await connect(ownedAgentAuth);
    let release!: () => void;
    mockGetGroupAccess.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ group: { uuid: "empty-group" } });
    }));
    mockGetGroupAccess.mockResolvedValue({ group: null });
    bus.emit("change", change("", { entityType: "project_group", entityUuid: "empty-group" }));
    await flush();
    bus.emit("change", change("", { entityType: "project_group", entityUuid: "empty-group" }));
    release();
    await flush();
    expect(dataEvents()).toEqual([]);
  });

  it("fails closed on a failed group discovery and continues with later visible events", async () => {
    const { dataEvents } = await connect(memberAuth);
    mockGetGroupAccess.mockRejectedValueOnce(new Error("database unavailable"));
    bus.emit("change", change("", { entityType: "project_group", entityUuid: "g1" }));
    bus.emit("change", change(PUBLIC_P));
    await flush();
    expect(dataEvents().map((e) => e.projectUuid)).toEqual([PUBLIC_P]);
  });

  it("withholds delayed browser notifications after an inherited grant is revoked", async () => {
    const { dataEvents } = await connect(memberAuth);
    privateMembers.get(PRIVATE_P)!.delete(memberUuid);
    bus.emit("project_access_changed", { companyUuid, projectUuid: PRIVATE_P, userUuids: [memberUuid] });
    bus.emit(`notification:user:${memberUuid}`, { type: "new_notification", projectUuid: PRIVATE_P, entityTitle: "Secret" });
    await flush();
    expect(dataEvents()).toEqual([]);
  });

  it("keeps the ?projectUuid= client filter on top of the access gate", async () => {
    const { dataEvents } = await connect(memberAuth, `projectUuid=${PRIVATE_P}`);
    bus.emit("change", change(PUBLIC_P));
    bus.emit("change", change(PRIVATE_P));
    await flush();
    expect(dataEvents().map((e) => e.projectUuid)).toEqual([PRIVATE_P]);
  });

  it("after removal (project_access_changed) the open stream stops receiving that project", async () => {
    const { dataEvents } = await connect(memberAuth);
    bus.emit("change", change(PRIVATE_P));
    await flush();
    expect(dataEvents()).toHaveLength(1);

    privateMembers.get(PRIVATE_P)!.delete(memberUuid);
    bus.emit("project_access_changed", { companyUuid, projectUuid: PRIVATE_P, userUuids: [memberUuid] });
    // Emitted synchronously behind the access change (as project-member.service does):
    // must be decided against the NEW set, not the stale one.
    bus.emit("change", change(PRIVATE_P, { entityType: "project", entityUuid: PRIVATE_P }));
    await flush();
    bus.emit("change", change(PRIVATE_P));
    bus.emit("presence", presence(PRIVATE_P));
    await flush();
    expect(dataEvents()).toHaveLength(1);
  });

  it("a removal that lands while the initial set is being computed is not missed", async () => {
    // First (connect-time) computation is held open; the removal happens inside it
    // and is emitted before the stream has attached its own listener.
    let releaseInitial!: () => void;
    const initialHeld = new Promise<void>((r) => (releaseInitial = r));
    mockAccessibleProjectUuids.mockImplementationOnce(async () => {
      const snapshot = [PUBLIC_P, PRIVATE_P]; // computed BEFORE the removal
      await initialHeld;
      return snapshot;
    });
    const pending = connect(memberAuth);
    await flush();
    privateMembers.get(PRIVATE_P)!.delete(memberUuid);
    bus.emit("project_access_changed", { companyUuid, projectUuid: PRIVATE_P, userUuids: [memberUuid] });
    releaseInitial();
    const { dataEvents } = await pending;
    await flush();

    bus.emit("change", change(PRIVATE_P));
    bus.emit("change", change(PUBLIC_P));
    await flush();
    expect(dataEvents().map((e) => e.projectUuid)).toEqual([PUBLIC_P]);
    // The temporary connect-window listener is gone; only the stream's remains.
    expect(bus.listenerCount("project_access_changed")).toBe(1);
  });

  it("after being added, the open stream starts receiving that project (incl. the in-flight event)", async () => {
    const { dataEvents } = await connect(outsiderAuth);
    bus.emit("change", change(PRIVATE_P));
    await flush();
    expect(dataEvents()).toHaveLength(0);

    privateMembers.get(PRIVATE_P)!.add(outsiderUuid);
    bus.emit("project_access_changed", { companyUuid, projectUuid: PRIVATE_P, userUuids: [outsiderUuid] });
    bus.emit("change", change(PRIVATE_P, { entityType: "project", entityUuid: PRIVATE_P }));
    await flush();
    bus.emit("presence", presence(PRIVATE_P));
    await flush();
    const evs = dataEvents();
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ entityType: "project" });
    expect(evs[1]).toMatchObject({ type: "presence" });
  });

  it("recomputes on a visibility flip (empty userUuids) for every subscriber", async () => {
    const { dataEvents } = await connect(outsiderAuth);
    publicProjects.add(PRIVATE_P); // made public
    bus.emit("project_access_changed", { companyUuid, projectUuid: PRIVATE_P, userUuids: [] });
    bus.emit("change", change(PRIVATE_P));
    await flush();
    expect(dataEvents()).toHaveLength(1);
  });

  it("ignores access changes for other users and other companies (no recompute)", async () => {
    await connect(memberAuth);
    expect(mockAccessibleProjectUuids).toHaveBeenCalledTimes(1);
    bus.emit("project_access_changed", { companyUuid, projectUuid: PRIVATE_P, userUuids: ["someone-else"] });
    bus.emit("project_access_changed", { companyUuid: "other", projectUuid: PRIVATE_P, userUuids: [] });
    await flush();
    expect(mockAccessibleProjectUuids).toHaveBeenCalledTimes(1);
  });

  it("an agent recomputes when its owner's membership changes", async () => {
    const { dataEvents } = await connect(ownedAgentAuth);
    privateMembers.get(PRIVATE_P)!.delete(ownerUuid);
    bus.emit("project_access_changed", { companyUuid, projectUuid: PRIVATE_P, userUuids: [ownerUuid] });
    bus.emit("change", change(PRIVATE_P));
    await flush();
    expect(dataEvents()).toHaveLength(0);
    expect(mockAccessibleProjectUuids).toHaveBeenCalledTimes(2);
  });

  it("preserves event order while a recompute is in flight", async () => {
    const { dataEvents } = await connect(memberAuth);
    let release!: () => void;
    mockAccessibleProjectUuids.mockImplementationOnce(
      () => new Promise<string[]>((r) => (release = () => r([PUBLIC_P, PRIVATE_P]))),
    );
    bus.emit("project_access_changed", { companyUuid, projectUuid: PRIVATE_P, userUuids: [] });
    bus.emit("change", change(PUBLIC_P, { entityUuid: "first" }));
    bus.emit("change", change(PRIVATE_P, { entityUuid: "second" }));
    await flush();
    expect(dataEvents()).toHaveLength(0); // held until the new set resolves
    release();
    await flush();
    bus.emit("change", change(PUBLIC_P, { entityUuid: "third" }));
    await flush();
    expect(dataEvents().map((e) => e.entityUuid)).toEqual(["first", "second", "third"]);
  });

  it("fails closed for the triggering project when a recompute errors", async () => {
    const { dataEvents } = await connect(memberAuth);
    mockAccessibleProjectUuids.mockRejectedValueOnce(new Error("db down"));
    bus.emit("project_access_changed", { companyUuid, projectUuid: PRIVATE_P, userUuids: [memberUuid] });
    bus.emit("change", change(PRIVATE_P));
    bus.emit("change", change(PUBLIC_P));
    await flush();
    expect(dataEvents().map((e) => e.projectUuid)).toEqual([PUBLIC_P]);
  });

  it("a project created after connect is delivered when visible, dropped when private to others", async () => {
    const { dataEvents } = await connect(outsiderAuth);
    const NEW_PUBLIC = "proj-new-public";
    const NEW_PRIVATE = "proj-new-private";
    publicProjects.add(NEW_PUBLIC);
    privateMembers.set(NEW_PRIVATE, new Set([memberUuid]));
    const created = (p: string) => ({
      companyUuid,
      projectUuid: p,
      entityType: "project",
      entityUuid: p,
      action: "created",
    });
    bus.emit("change", created(NEW_PUBLIC));
    bus.emit("change", created(NEW_PRIVATE));
    await flush();
    bus.emit("change", change(NEW_PUBLIC));
    await flush();
    expect(dataEvents().map((e) => [e.projectUuid, e.action])).toEqual([
      [NEW_PUBLIC, "created"],
      [NEW_PUBLIC, "updated"],
    ]);
  });

  it("removes the project_access_changed listener (and change/presence) on close", async () => {
    const { ac } = await connect(memberAuth);
    expect(bus.listenerCount("project_access_changed")).toBe(1);
    expect(bus.listenerCount("change")).toBe(1);
    expect(bus.listenerCount("presence")).toBe(1);
    ac.abort();
    await flush();
    expect(bus.listenerCount("project_access_changed")).toBe(0);
    expect(bus.listenerCount("change")).toBe(0);
    expect(bus.listenerCount("presence")).toBe(0);
  });
});

// ===== Session activity + execution channels (not RealtimeEvents) =====
import * as daemonSession from "@/services/daemon-session.service";
import * as daemonExecution from "@/services/daemon-execution.service";

describe("GET /api/events — session activity / execution isolation", () => {
  const activity = (ideaUuid: string | null, extra: Record<string, unknown> = {}) => ({
    type: "session_started",
    companyUuid,
    sessionUuid: `s-${ideaUuid ?? "adhoc"}`,
    activityUuid: `t-${ideaUuid ?? "adhoc"}`,
    directIdeaUuid: ideaUuid,
    agentUuid: "agent-x",
    originConnectionUuid: "conn-x",
    agentOwnerUuid: "someone-else",
    ...extra,
  });

  beforeEach(() => {
    failingIdeas.clear();
    ideaProjects.clear();
    ideaProjects.set("idea-private", PRIVATE_P);
    ideaProjects.set("idea-public", PUBLIC_P);
  });

  it("live activity for a private-project idea is hidden from outsiders, shown to members", async () => {
    const outsider = await connect(outsiderAuth);
    const member = await connect(memberAuth);
    bus.emit("session_activity", activity("idea-private"));
    bus.emit("session_activity", activity("idea-public"));
    bus.emit("session_activity", activity(null)); // ad-hoc: unchanged scoping
    await flush();
    const ids = (evs: Record<string, unknown>[]) => evs.map((e) => e.directIdeaUuid);
    expect(ids(outsider.dataEvents())).toEqual(["idea-public", null]);
    expect(ids(member.dataEvents())).toEqual(["idea-private", "idea-public", null]);
    expect(JSON.stringify(outsider.dataEvents())).not.toContain("s-idea-private");
  });

  it("bootstrap snapshot is filtered the same way", async () => {
    vi.mocked(daemonSession.listVisibleRunningSessionActivities).mockResolvedValueOnce([
      { ...activity("idea-private"), canOpen: false },
      { ...activity("idea-public"), canOpen: false },
    ] as never);
    const outsider = await connect(outsiderAuth);
    await flush();
    expect(outsider.dataEvents().map((e) => e.directIdeaUuid)).toEqual(["idea-public"]);
  });

  it("a member removed later stops receiving that project's session activity", async () => {
    const member = await connect(memberAuth);
    privateMembers.get(PRIVATE_P)!.delete(memberUuid);
    bus.emit("project_access_changed", { companyUuid, projectUuid: PRIVATE_P, userUuids: [memberUuid] });
    bus.emit("session_activity", activity("idea-private"));
    await flush();
    expect(member.dataEvents()).toEqual([]);
  });

  it("an idea moved into a private project is judged by its CURRENT project", async () => {
    const outsider = await connect(outsiderAuth);
    bus.emit("session_activity", activity("idea-public"));
    await flush();
    ideaProjects.set("idea-public", PRIVATE_P); // moved
    bus.emit("session_activity", activity("idea-public", { type: "session_ended" }));
    await flush();
    expect(outsider.dataEvents()).toHaveLength(1);
  });

  it("execution rows for projects the caller cannot see are dropped (titles never sent)", async () => {
    vi.mocked(daemonExecution.listVisibleConnectionUuids).mockResolvedValueOnce(["conn-1"]);
    const outsider = await connect(outsiderAuth);
    const row = (uuid: string, projectUuid: string | null, idea: string | null, title: string) => ({
      uuid, agentUuid: "a", connectionUuid: "conn-1", entityType: projectUuid ? "task" : "daemon_session",
      entityUuid: uuid, rootIdeaUuid: idea, directIdeaUuid: idea, status: "running", interruptedReason: null,
      startedAt: null, createdAt: "", updatedAt: "", entityTitle: title, projectUuid, rootIdeaTitle: title,
    });
    bus.emit("execution:conn-1", {
      companyUuid,
      connectionUuid: "conn-1",
      executions: [
        row("e-priv-task", PRIVATE_P, null, "CONFIDENTIAL EXECUTION"),
        row("e-priv-session", null, "idea-private", "CONFIDENTIAL ROOT"),
        row("e-pub", PUBLIC_P, null, "Public work"),
        row("e-adhoc", null, null, "adhoc"),
      ],
    });
    await flush();
    const [ev] = outsider.dataEvents();
    expect(ev.type).toBe("execution");
    expect((ev.executions as { uuid: string }[]).map((e) => e.uuid)).toEqual(["e-pub", "e-adhoc"]);
    expect(JSON.stringify(ev)).not.toContain("CONFIDENTIAL");
  });

  it("a failed lookup during snapshot replay hides that row but never stalls live activity", async () => {
    failingIdeas.add("idea-broken");
    vi.mocked(daemonSession.listVisibleRunningSessionActivities).mockResolvedValueOnce([
      { ...activity("idea-broken"), canOpen: false },
      { ...activity("idea-public"), canOpen: false },
    ] as never);
    const member = await connect(memberAuth);
    await flush();
    bus.emit("session_activity", activity("idea-private"));
    await flush();
    expect(member.dataEvents().map((e) => e.directIdeaUuid)).toEqual(["idea-public", "idea-private"]);
  });

  it("activity buffered during the snapshot is re-checked at flush (removal while the snapshot is held)", async () => {
    let releaseSnapshot!: (v: unknown[]) => void;
    vi.mocked(daemonSession.listVisibleRunningSessionActivities).mockReturnValueOnce(
      new Promise((r) => (releaseSnapshot = r)) as never,
    );
    const member = await connect(memberAuth);
    bus.emit("session_activity", activity("idea-private")); // passes the gate, buffered
    await flush();
    expect(member.dataEvents()).toEqual([]);
    privateMembers.get(PRIVATE_P)!.delete(memberUuid);
    bus.emit("project_access_changed", { companyUuid, projectUuid: PRIVATE_P, userUuids: [memberUuid] });
    await flush();
    releaseSnapshot([]);
    await flush();
    expect(member.dataEvents()).toEqual([]);
  });

  it("a visible public execution row has its hidden private root/direct anchors redacted", async () => {
    vi.mocked(daemonExecution.listVisibleConnectionUuids).mockResolvedValueOnce(["conn-1"]);
    const outsider = await connect(outsiderAuth);
    bus.emit("execution:conn-1", {
      companyUuid,
      connectionUuid: "conn-1",
      executions: [{
        uuid: "e-mixed", agentUuid: "a", connectionUuid: "conn-1", entityType: "idea", entityUuid: "idea-public",
        rootIdeaUuid: "idea-private", directIdeaUuid: "idea-public", status: "running", interruptedReason: null,
        startedAt: null, createdAt: "", updatedAt: "", entityTitle: "Public idea", projectUuid: PUBLIC_P,
        rootIdeaTitle: "CONFIDENTIAL ROOT",
      }],
    });
    await flush();
    const [ev] = outsider.dataEvents();
    const [row] = ev.executions as Record<string, unknown>[];
    expect(row).toMatchObject({ uuid: "e-mixed", entityTitle: "Public idea", directIdeaUuid: "idea-public", rootIdeaUuid: null, rootIdeaTitle: null });
    expect(JSON.stringify(ev)).not.toContain("CONFIDENTIAL");
    expect(JSON.stringify(ev)).not.toContain("idea-private");
  });
});
