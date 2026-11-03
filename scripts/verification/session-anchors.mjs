import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { format } from 'node:util';
import pg from 'pg';
import { buildDaemon } from '../../cli/daemon.mjs';
import { ChorusClient } from '../../cli/chorus-client.mjs';

pg.types.setTypeParser(1114, value => new Date(`${value.replace(' ', 'T')}Z`));
const url = 'http://127.0.0.1:8637';
const output = resolve(process.env.ANCHOR_E2E_OUTPUT ?? await mkdtemp(join(tmpdir(), 'chorus-anchor-e2e-')));
const log = (...messages) => process.stdout.write(`${format(...messages)}\n`);
assert.equal(new URL(process.env.DATABASE_URL).port, '5433');
assert.equal(new URL(process.env.DATABASE_URL).hostname, '127.0.0.1');
assert.ok(process.env.ANCHOR_E2E_PASSWORD, 'Set the isolated server login password');
await mkdir(output, { recursive: true });
const database = new pg.Client({ connectionString: process.env.DATABASE_URL });
await database.connect();
let cookie;
async function request(path, body) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.ok(response.ok && result.success !== false, JSON.stringify(result));
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return result.data;
}
async function insert(table, fields) {
  const columns = Object.keys(fields);
  await database.query(`INSERT INTO "${table}" (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map((column, index) => `$${index + 1}`).join(',')})`, Object.values(fields));
}
async function until(label, probe, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`);
}
const { user } = await request('/api/auth/default-login', {
  email: process.env.ANCHOR_E2E_EMAIL ?? 'anchors@isolated.local',
  password: process.env.ANCHOR_E2E_PASSWORD,
});
const suffix = randomUUID().slice(0, 8);
const worker = await request('/api/agents', {
  name: `Anchor E2E worker ${suffix}`, roles: ['developer_agent'],
  systemPrompt: 'This is an isolated session-routing verification, not production development. Read only. Read the task once using Chorus, then output SESSION_ANCHOR_CHECK_COMPLETE. Never change files, claim tasks, assign work, post comments, or change resource states. A review wake is only a routing probe, not a real quality verdict.',
});
const controller = await request('/api/agents', { name: `Anchor E2E controller ${suffix}`, roles: ['admin_agent', 'pm_agent'] });
const workerKey = await request('/api/api-keys', { agentUuid: worker.uuid });
const controllerKey = await request('/api/api-keys', { agentUuid: controller.uuid });
const projectUuid = randomUUID();
const ideaUuid = randomUUID();
const proposalUuid = randomUUID();
const tasks = [randomUUID(), randomUUID()];
const common = { companyUuid: user.companyUuid, projectUuid };
await insert('Project', { uuid: projectUuid, companyUuid: user.companyUuid, name: `Session anchor E2E ${suffix}`, updatedAt: new Date(), createdByUuid: user.uuid });
await insert('Idea', { ...common, uuid: ideaUuid, title: 'Isolated session anchor verification', status: 'elaborated', elaborationStatus: 'resolved', assigneeType: 'agent', assigneeUuid: controller.uuid, createdByUuid: user.uuid, updatedAt: new Date() });
await insert('Proposal', { ...common, uuid: proposalUuid, title: 'Session anchor verification', inputType: 'idea', inputUuids: JSON.stringify([ideaUuid]), status: 'approved', createdByUuid: controller.uuid, updatedAt: new Date() });
for (const [index, taskUuid] of tasks.entries()) {
  await insert('Task', { ...common, uuid: taskUuid, title: `Read-only routing probe ${index + 1}`, description: 'Isolated verification only. Read this task then output SESSION_ANCHOR_CHECK_COMPLETE. Do not claim, edit, comment, or change status.', proposalUuid, createdByUuid: controller.uuid, updatedAt: new Date() });
}
const nativeSettings = JSON.parse(await readFile(`${process.env.HOME}/.claude/settings.json`, 'utf8'));
const configDir = resolve(output, `claude-${suffix}`);
const cwd = resolve(output, `workspace-${suffix}`);
await mkdir(configDir, { recursive: true, mode: 0o700 });
await mkdir(cwd, { recursive: true });
const providerEnv = Object.fromEntries(Object.entries(nativeSettings.env ?? {}).filter(([name]) => name.startsWith('ANTHROPIC_')));
await writeFile(`${configDir}/settings.json`, JSON.stringify({ env: providerEnv }), { mode: 0o600 });
const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (...messages) => log(new Date().toISOString(), level, ...messages)]));
const daemon = buildDaemon({ url, apiKey: workerKey.key, agentUuid: worker.uuid }, {
  cwd, browseRoots: [output], maxConcurrency: 2, logger, verbose: true,
  cliConfig: { args: ['--max-turns=3'] },
  env: { ...process.env, ...providerEnv, CLAUDE_CONFIG_DIR: configDir, CHORUS_URL: url, CHORUS_API_KEY: workerKey.key, CHORUS_AGENT_PROFILE: 'anchor-e2e', CLAUDECODE: '' },
});
const control = new ChorusClient({ url, apiKey: controllerKey.key, logger });
const anchors = tasks.map(taskUuid => `task:${taskUuid}`);
const reviewAnchor = `review:task:${tasks[0]}`;
async function turns() {
  return (await database.query('SELECT session."sessionId", turn."backendSessionId", turn.status, turn."startedAt", turn."endedAt", turn."wakeError" FROM "DaemonSessionTurn" turn JOIN "DaemonSession" session ON session.uuid = turn."sessionUuid" WHERE session."agentUuid" = $1 ORDER BY turn."createdAt"', [worker.uuid])).rows;
}
try {
  await daemon.start();
  await until('registered daemon', async () => (await database.query('SELECT uuid FROM "DaemonConnection" WHERE "agentUuid" = $1 AND status = $2', [worker.uuid, 'online'])).rows.length);
  for (const taskUuid of tasks) {
    const result = await control.callTool('chorus_pm_assign_task', { taskUuid, agentUuid: worker.uuid });
    assert.ok(!result.error, JSON.stringify(result));
  }
  await until('two native task sessions running concurrently', async () => {
    const rows = await turns();
    return anchors.every(anchor => rows.some(row => row.sessionId === anchor && row.status === 'running'));
  });
  log('CONCURRENT_TASK_TURNS', JSON.stringify(await turns()));
  await until('task wakes finished', async () => {
    const rows = await turns();
    return anchors.every(anchor => rows.some(row => row.sessionId === anchor && row.status === 'ended' && row.backendSessionId));
  });
  for (const round of [1, 2]) {
    const result = await control.callTool('chorus_add_comment', {
      targetType: 'task', targetUuid: tasks[0],
      content: `Team review request — task, round ${round}\nTarget UUID: ${tasks[0]}. Isolated read-only routing probe, not a quality gate. Read task once and finish without posting a verdict or mutating anything. @[Worker](agent:${worker.uuid})`,
    });
    assert.ok(!result.error, JSON.stringify(result));
    await until(`review round ${round} ended`, async () => (await turns()).filter(row => row.sessionId === reviewAnchor && row.status === 'ended' && row.backendSessionId).length === round);
  }
  const rows = await turns();
  const taskRows = anchors.map(anchor => rows.find(row => row.sessionId === anchor));
  const reviewRows = rows.filter(row => row.sessionId === reviewAnchor);
  assert.notEqual(taskRows[0].backendSessionId, taskRows[1].backendSessionId);
  assert.notEqual(taskRows[0].backendSessionId, reviewRows[0].backendSessionId);
  assert.equal(reviewRows[0].backendSessionId, reviewRows[1].backendSessionId);
  assert.ok(Math.max(...taskRows.map(row => +row.startedAt)) < Math.min(...taskRows.map(row => +row.endedAt)));
  assert.ok(rows.every(row => !row.wakeError), JSON.stringify(rows));
  const evidence = { checkedAt: new Date().toISOString(), url, nativeBackend: 'Claude Code (real subprocess, no fixture)', workerUuid: worker.uuid, projectUuid, ideaUuid, proposalUuid, tasks, turns: rows };
  await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
  log('PASS', JSON.stringify(evidence));
  log('Evidence:', `${output}/evidence.json`);
} finally {
  await daemon.stop();
  await control.disconnect();
  await database.end();
  await rm(`${configDir}/settings.json`, { force: true });
}
