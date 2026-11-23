// Installed Desktop integration. All sessions, images, credentials and model replies are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-background-presets-'));
const executable = process.env.DSH_DESKTOP_EXECUTABLE || path.join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness/DeepSeek Harness.exe');
const cli = process.env.DSH_CLI_ENTRY || path.join(path.dirname(executable), 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
let requestedTool, finalText;
const seenTools = [], sawImages = [];
const modelServer = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks));
  seenTools.push(request.tools?.map(t => t.function.name).sort() ?? []);
  sawImages.push(JSON.stringify(request.messages).includes('image_url'));
  const tool = requestedTool;
  requestedTool = null;
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function',
    function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: 'assistant', content: finalText };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
});
const sourceJob = { jobId: 'fixture', status: 'queued', sourceSessionId: 'source', fromSeq: -1, throughSeq: 0,
  day: '2026-11-20', modelSelection: { provider: 'fixture', model: 'fixture' } };
const h = await bridgeHarness({ config: { dsh: { provider: 'fixture', model: 'fixture' } },
  files: { 'state/desktop-agent.json': { sessionId: 'fixture-main', agentToken: 'a'.repeat(64) }, 'state/memory-organizer.json': { version: 1, jobs: [sourceJob] } },
  globals: { createAMemorixGateway: () => ({ status: () => ({ configured: true }), save: async () => ({ storedIds: ['fixture-memory'], skippedIds: [] }) }) } });
const server = h.startConsoleServer();
let child, exited, output = '';
try {
  if (!server.listening) await once(server, 'listening');
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  fs.cpSync(path.join(root, 'src'), path.join(temp, 'src'), { recursive: true });
  fs.cpSync(path.join(root, 'plugins/qq-agent-presets'), path.join(temp, 'plugins/qq-agent-presets'), {
    recursive: true, filter: file => path.basename(file) !== 'node_modules',
  });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(temp, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), 'junction');
  fs.symlinkSync(path.join(h.temp, 'state'), path.join(temp, 'state'), 'junction');
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ consoleToken: 'fixture-console-token', consolePort: server.address().port }));
  const profile = path.join(temp, 'home/profiles/web');
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(temp, 'plugins/qq-agent-presets'), path.join(profile, 'node_modules/qq-agent-presets'), 'junction');
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'fixture-web', private: true,
    dependencies: { 'qq-agent-presets': 'link:../../../plugins/qq-agent-presets' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'qq-agent-presets'] } },
  }));
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]');
  const patch = [
    { id: 'credentials', disabled: false }, { id: 'session-title-llm', disabled: true },
    { id: 'llm-pi-ai', config: { providers: { fixture: { api: 'openai-completions', apiKeyEnv: 'QQ_FIXTURE_MODEL_KEY',
      baseURL: `http://127.0.0.1:${modelServer.address().port}/v1`, models: [{ id: 'fixture', input: ['text', 'image'], reasoningEfforts: { max: 'high' }, contextWindow: 32000, maxTokens: 2048 }] } } } }];
  const patchFile = path.join(temp, 'fixture.yml');
  fs.writeFileSync(patchFile, yaml.dump(patch));
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'ComSpec']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  process.env.DSH_HOME = path.join(temp, 'home');
  child = spawn(executable, ['--expose-internals', cli, '--profile', 'web', '--patch', patchFile, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: temp, env: { ...env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: process.env.DSH_HOME, QQ_FIXTURE_MODEL_KEY: 'fixture' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  exited = once(child, 'close');
  for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { output = (output + d).slice(-32000); });
  let url;
  for (let i = 0; i < 400 && !url && child.exitCode === null; i++) {
    await delay(100);
    url = output.match(/http:\/\/127\.0\.0\.1:\d+\/?\?token=[\w-]+/)?.[0];
  }
  assert.ok(url, 'fixture Host did not start: ' + output.replace(/token=[\w-]+/g, 'token=<redacted>').slice(-4000));
  const api = new NodeApiClient(new URL(url).origin, 15000, { token: new URL(url).searchParams.get('token') });
  h.api.workspace = api.workspace;
  h.api.agentPresets = api.agentPresets;
  await h.refreshPresetList();
  h.api.sessions = api.sessions;
  h.api.callUnary = (method, args, ...rest) => method === 'session/page' && args.address.sessionId === 'source'
    ? { result: { ok: true, value: { records: [{ seq: 0, type: 'user/message', data: { content: 'fixture source', source: { kind: 'user' } } }], hasMore: false } } }
    : api.callUnary(method, args, ...rest);
  h.api.readSessionState = api.readSessionState.bind(api);
  h.api.readWorkspaceState = api.readWorkspaceState.bind(api);
  h.setReady(true);
  const imageTool = 'mcp__qq-learning-images__learning_images';
  const bridgePost = (route, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...headers },
    body: JSON.stringify(body),
  });
  for (const mode of ['chat', 'market']) {
    seenTools.length = sawImages.length = 0;
    requestedTool = { name: imageTool, args: mode === 'market' ? { page: 1 } : {} };
    finalText = '{"slang":[],"stickers":[{"id":1}]}';
    const result = await h.runVisualLearning(JSON.stringify({ key: 'group:123', pack: '样例' }), [
      { id: mode === 'market' ? 1 : 'learned:' + 'a'.repeat(64), mimeType: 'image/png', data: png },
    ], undefined, mode);
    assert.ok(result.sessionId);
    assert.equal((await bridgePost('/api/learning/session-images', { sessionId: result.sessionId, page: 1 })).status, 404);
    assert.ok(sawImages.includes(true), 'the fixture model received the image');
    assert.deepEqual(seenTools, [[imageTool], [imageTool]]);
    const ws = await api.readWorkspaceState({ timeoutMs: 8000 });
    const group = ws.items.find(w => w.title === (mode === 'chat' ? '后台黑话与表情学习' : '自定义学习分组'));
    assert.ok(group?.sessionIds.includes(result.sessionId));
    const session = unwrap(await api.callUnary('session/projections', { sessionId: result.sessionId }), 'session/projections').values;
    if (mode === 'chat') {
      assert.match(session.title, /^后台学习 · group:123 · /);
      unwrap(await api.workspace.rename({ workspaceId: group.workspaceId, title: '自定义学习分组' }), 'workspace/rename');
    } else {
      assert.equal(session.title, '商城表情分析 · 样例');
    }
  }
  seenTools.length = 0;
  requestedTool = { name: 'mcp__qq-memory-organizer__memory_save', args: {
    content: 'fixture memory', externalId: 'qq-bridge:organizer:fixture:chunk-1:item-1',
  } };
  finalText = 'MEMORY_ORGANIZER_DONE';
  await h.runMemoryOrganizerQueue();
  const job = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/memory-organizer.json'))).jobs[0];
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.result.newMemories, 1);
  const closed = await bridgePost('/api/desktop-agent/memory/save', { content: 'late fixture write' }, {
    'x-agent-call': '1', 'x-agent-token': 'a'.repeat(64), 'x-organizer-session-id': job.organizerSessionId,
  });
  assert.equal(closed.status, 403);
  assert.match((await closed.json()).error, /没有活动的记忆整理任务/);
  assert.deepEqual(seenTools[0], ['forget', 'read', 'replace', 'save', 'search'].map(s => 'mcp__qq-memory-organizer__memory_' + s));
  const ws = await api.readWorkspaceState({ timeoutMs: 8000 });
  assert.ok(ws.items.find(w => w.title === '长期记忆整理').sessionIds.includes(job.organizerSessionId));
  assert.ok(ws.archivedSessionIds.includes(job.organizerSessionId));
  seenTools.length = 0;
  finalText = '{"action":"keep","members":[],"content":"","reason":"fixture"}';
  const result = await h.analyzeCuratorGroup({ key: 'assistant/self',
    rows: ['first', 'second'].map(content => ({ content, metadata: {} })) });
  assert.equal(result.text, finalText);
  assert.deepEqual(seenTools, [[]]);
  const afterCurator = await api.readWorkspaceState({ timeoutMs: 8000 });
  assert.ok(afterCurator.items.some(w => w.title === '旧记忆回顾'));
  const archived = afterCurator.archivedSessionIds.filter(id => !ws.archivedSessionIds.includes(id));
  assert.equal(archived.length, 1);
  const projection = unwrap(await api.callUnary('session/projections', { sessionId: archived[0] }), 'session/projections');
  assert.equal(projection.values.agentPreset, 'memory-curator');
  console.log('PASS installed DSH ran all four background presets, delivered fixture images and archived the organizer and tool-free curator');
} catch (error) {
  console.error(output.split('\n').filter(l => !l.includes('tools.restrict()')).join('\n').replace(/token=[\w-]+/g, 'token=<redacted>').slice(-2500));
  throw error;
} finally {
  if (child && child.exitCode === null) child.kill();
  if (exited) await exited;
  await Promise.all([server, modelServer].map(s => new Promise(resolve => s.close(resolve))));
  await h.close();
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith('qq-background-presets-'));
  fs.rmSync(temp, { recursive: true, force: true });
}
