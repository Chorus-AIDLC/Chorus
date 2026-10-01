import { vi } from "vitest";

// Stateful query/transaction fixture. Services, permission resolution, previews,
// API wrappers and mutations remain real; only persistence/event adapters vary.
type Row = Record<string, any>;
const tables = ["projectGroup", "projectGroupMember", "project", "projectMember", "user", "task", "idea", "proposal", "activity", "comment", "agentInstance", "projectAgentCwdPreference"] as const;
type Table = typeof tables[number];
type State = Record<Table, Row[]>;
const empty = () => Object.fromEntries(tables.map((t) => [t, []])) as unknown as State;
export const fixture = {
  state: empty(), locks: [] as { table: string; uuid: string; companyUuid: string }[],
  writes: [] as { table: string; data: Row }[], events: [] as { type: string; data: Row; inTransaction: boolean }[],
  inTransaction: false, onLock: null as null | (() => void), failWrite: null as string | null,
  prisma: {} as Record<string, any>, sequence: 0,
  reset() {
    this.state = empty(); this.locks = []; this.writes = []; this.events = [];
    this.inTransaction = false; this.onLock = null; this.failWrite = null; this.sequence = 0;
    for (const uuid of ["admin", "editor", "viewer", "local", "outside"]) this.state.user.push({ uuid, companyUuid: "c", name: uuid, email: `${uuid}@test.local` });
  },
};

function matches(table: Table, row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (key === "AND") return (Array.isArray(expected) ? expected : [expected]).every((w: Row) => matches(table, row, w));
    if (key === "OR") return expected.some((w: Row) => matches(table, row, w));
    if (key === "NOT") return !matches(table, row, expected);
    if (key === "groupUuid_userUuid" || key === "projectUuid_userUuid") return matches(table, row, expected);
    if (key === "members") {
      const memberTable = table === "project" ? "projectMember" : "projectGroupMember";
      const link = table === "project" ? "projectUuid" : "groupUuid";
      return fixture.state[memberTable].some((m) => m[link] === row.uuid && matches(memberTable, m, expected.some));
    }
    if (key === "projects") return fixture.state.project.some((p) => p.groupUuid === row.uuid && matches("project", p, expected.some));
    if (key === "group") {
      const group = fixture.state.projectGroup.find((g) => g.uuid === row.groupUuid);
      return !!group && matches("projectGroup", group, expected);
    }
    if (expected !== null && typeof expected === "object") {
      if ("in" in expected) return expected.in.includes(row[key]);
      if ("not" in expected) return row[key] !== expected.not;
      if ("gte" in expected) return row[key] >= expected.gte;
    }
    return row[key] === expected;
  });
}
function write(table: Table, data: Row) {
  fixture.writes.push({ table, data: structuredClone(data) });
  if (fixture.failWrite === table) throw new Error(`forced ${table} failure`);
}
function update(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === "object" && "increment" in value ? row[key] + value.increment : value;
  row.updatedAt = new Date(); return structuredClone(row);
}
for (const table of tables) {
  const rows = (where?: Row) => fixture.state[table].filter((r) => matches(table, r, where));
  fixture.prisma[table] = {
    findFirst: vi.fn(async ({ where }: Row = {}) => structuredClone(rows(where)[0] ?? null)),
    findUnique: vi.fn(async ({ where }: Row) => structuredClone(rows(where)[0] ?? null)),
    findMany: vi.fn(async ({ where, orderBy, take }: Row = {}) => {
      let found = structuredClone(rows(where));
      for (const order of (Array.isArray(orderBy) ? orderBy : [orderBy]).filter(Boolean).reverse()) {
        const [key, direction] = Object.entries(order)[0];
        found.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (direction === "desc" ? -1 : 1));
      }
      if (take) found = found.slice(0, take);
      return found;
    }),
    count: vi.fn(async ({ where }: Row) => rows(where).length),
    create: vi.fn(async ({ data }: Row) => {
      write(table, data);
      const row = { uuid: `${table}-${++fixture.sequence}`, createdAt: new Date(), updatedAt: new Date(), accessVersion: 0, description: null, ...data };
      fixture.state[table].push(row); return structuredClone(row);
    }),
    update: vi.fn(async ({ where, data }: Row) => {
      write(table, data); const row = rows(where)[0]; if (!row) throw new Error("missing row"); return update(row, data);
    }),
    updateMany: vi.fn(async ({ where, data }: Row) => { write(table, data); const found = rows(where); found.forEach((r) => update(r, data)); return { count: found.length }; }),
    delete: vi.fn(async ({ where }: Row) => { write(table, { delete: true }); const row = rows(where)[0]; fixture.state[table] = fixture.state[table].filter((r) => r !== row); return row; }),
    deleteMany: vi.fn(async ({ where }: Row) => { write(table, { delete: true }); const found = rows(where); fixture.state[table] = fixture.state[table].filter((r) => !found.includes(r)); return { count: found.length }; }),
    upsert: vi.fn(async ({ where, create, update: data }: Row) => {
      const existing = rows(where)[0];
      return existing ? fixture.prisma[table].update({ where, data }) : fixture.prisma[table].create({ data: create });
    }),
    groupBy: vi.fn(async ({ where, by }: Row) => {
      const counts = new Map<string, number>();
      rows(where).forEach((r) => counts.set(r[by[0]], (counts.get(r[by[0]]) ?? 0) + 1));
      return [...counts].map(([key, count]) => ({ [by[0]]: key, _count: { _all: count } }));
    }),
  };
}
let baseline: State;
fixture.prisma.$queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: string[]) => {
  fixture.locks.push({ table: strings.join("").includes('"ProjectGroup"') ? "group" : "project", uuid: values[0], companyUuid: values[1] });
  if (fixture.onLock) { const hook = fixture.onLock; fixture.onLock = null; hook(); baseline = structuredClone(fixture.state); }
  return [];
});
fixture.prisma.$transaction = vi.fn(async (fn: (client: typeof fixture.prisma) => Promise<any>) => {
  baseline = structuredClone(fixture.state); fixture.inTransaction = true;
  try { return await fn(fixture.prisma); }
  catch (error) { fixture.state = baseline; throw error; }
  finally { fixture.inTransaction = false; }
});
export const events = {
  emitChange: vi.fn((data: Row) => fixture.events.push({ type: "change", data, inTransaction: fixture.inTransaction })),
  emitProjectAccessChanged: vi.fn((data: Row) => fixture.events.push({ type: "access", data, inTransaction: fixture.inTransaction })),
  emit: vi.fn(),
};
export function group(uuid = "g", visibility = "private", initialized = true) {
  fixture.state.projectGroup.push({ id: 1, uuid, companyUuid: "c", name: uuid, description: "group", visibility, createdByUuid: initialized ? "admin" : null, accessVersion: initialized ? 1 : 0, createdAt: new Date(), updatedAt: new Date() });
  if (initialized) groupMember(uuid, "admin", "admin");
  return uuid;
}
export function groupMember(groupUuid: string, userUuid: string, role: string) {
  fixture.state.projectGroupMember.push({ uuid: `${groupUuid}-${userUuid}`, companyUuid: "c", groupUuid, userUuid, role, addedByUuid: "admin", createdAt: new Date(), updatedAt: new Date() });
}
export function project(uuid = "p", groupUuid: string | null = "g", visibility = "private") {
  fixture.state.project.push({ id: 1, uuid, companyUuid: "c", name: uuid, description: "project", visibility, groupUuid, createdByUuid: null, createdAt: new Date(), updatedAt: new Date() });
  return uuid;
}
export function localMember(projectUuid: string, userUuid: string, role: string) {
  fixture.state.projectMember.push({ uuid: `${projectUuid}-${userUuid}`, companyUuid: "c", projectUuid, userUuid, role, addedByUuid: "admin", createdAt: new Date(), updatedAt: new Date() });
}
export const auth = (actorUuid = "admin") => ({ type: "user" as const, companyUuid: "c", actorUuid });
