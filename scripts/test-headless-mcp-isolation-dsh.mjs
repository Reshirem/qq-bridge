// Optional installed-DSH regression: intentionally inherited manager/QQ entries
// must be disabled by both task patches. Uses only a loopback fake model and
// fake MCP processes in a temporary DSH_HOME; no real model, QQ or memories.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { learningPatch } from '../src/learning-runner.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const executable = process.env.DSH_DESKTOP_EXECUTABLE || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
const cli = process.env.DSH_CLI_ENTRY || path.join(path.dirname(executable), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
if (!fs.existsSync(executable)) throw new Error('This optional check requires installed DSH Desktop');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-headless-mcp-isolation-'));
const fakeServer = path.join(root, 'scripts', 'fixtures', 'dsh-managed-mcp-server.mjs');
const forbiddenAudit = path.join(temporary, 'forbidden-starts.jsonl');
const ownAudit = path.join(temporary, 'allowed-starts.jsonl');
const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'isolated fixture complete' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const model = { provider: 'fixture', model: 'fixture' };
const provider = { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', disabled: false, config: { providers: { fixture: {
  api: 'openai-completions', apiKeyEnv: 'QQ_ISOLATION_FIXTURE_KEY', baseURL: `http://127.0.0.1:${server.address().port}/v1`,
  models: [{ id: 'fixture', contextWindow: 32000, maxTokens: 2000, input: ['text'] }],
} } } };
const entry = name => ({ transport: 'stdio', command: process.execPath, args: [fakeServer, forbiddenAudit, name], toolCallTimeoutMs: 30000 });
const inherited = [{ insert: [
  { id: 'mcp-manager', name: '@deepseek-ai/dsh-mcp-manager', config: { servers: { inherited: entry('inherited-manager') } } },
  ...[['mcp-qq', 'qq'], ['mcp-qq-memory', 'qq-memory']].map(([id, serverName]) => ({ id, name: path.join(root, 'plugins', 'qq-agent-presets', 'managed-mcp.mjs'), config: { serverName, ...entry(id) } })),
  ...['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe'].map(id => ({ id, name: '@deepseek-ai/dsh-mcp-client', config: { serverName: id, ...entry(id) } })),
] }];
const h = await bridgeHarness();
try {
  for (const mode of ['learning', 'memory']) {
    const operations = mode === 'learning'
      ? yaml.load(learningPatch({ model, imageServer: fakeServer, imageManifest: ownAudit }))
      : yaml.load(h.memoryOrganizerPatchText(model));
    const ownId = mode === 'learning' ? 'qq-learning-images' : 'qq-bridge-memory-organizer';
    const namespace = mode === 'learning' ? 'qq-learning-images' : 'qq-memory-organizer';
    const leaf = mode === 'learning' ? 'learning_images' : 'memory_search';
    for (const operation of operations) {
      for (const row of operation.insert || []) {
        if (row.id === ownId) row.config = { serverName: namespace, transport: 'stdio', command: process.execPath, args: [fakeServer, ownAudit, mode, leaf], toolCallTimeoutMs: 30000 };
        if (row.id === 'qq-memory-organizer-tool-guard') row.name = path.join(root, 'src', 'memory-organizer-tool-guard.mjs');
      }
    }
    const patch = path.join(temporary, mode + '.yml');
    fs.writeFileSync(patch, yaml.dump([...inherited, ...operations, provider], { lineWidth: -1, noRefs: true }));
    const env = {};
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'ComSpec']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: path.join(temporary, mode + '-home'), QQ_ISOLATION_FIXTURE_KEY: 'fixture-only' });
    const before = requests.length;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, ['--expose-internals', cli, '--profile', 'headless', '--patch', patch, '--json', '-'], { cwd: temporary, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(mode + ' isolated check timed out\n' + output)); }, 45000);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-16000); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, output }); });
      child.stdin.end('Return a short final answer without invoking tools.');
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(requests.length, before + 1, result.output);
    const tools = requests.at(-1).tools?.map(tool => tool.function.name).sort() || [];
    assert.deepEqual(tools, [`mcp__${namespace}__${leaf}`], mode + ' exposed tools');
    assert.equal(fs.existsSync(forbiddenAudit), false, 'inherited manager and QQ clients must not even start');
    console.log('PASS ' + mode + ' ignores inherited managed/legacy QQ registrations and exposes only its intended tool');
  }
} finally {
  await h.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('qq-headless-mcp-isolation-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
