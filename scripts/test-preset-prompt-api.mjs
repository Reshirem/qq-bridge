import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('prompt editor saves and restores arbitrary content and disabled modules', async () => {
  const dir = 'dsh/agent-presets/desktop-agent';
  const h = await bridgeHarness({ files: {
    [`${dir}/agent.cordis.yml`]: fs.readFileSync(`${dir}/agent.cordis.yml`, 'utf8'),
    [`${dir}/prompt-modules.json`]: fs.readFileSync(`${dir}/prompt-modules.json`, 'utf8'),
  } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-console-token': 'fixture-console-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const endpoint = '/api/preset/desktop-agent-prompt/modules';
    let current = await call(endpoint);
    assert.equal(current.status, 200);
    assert.deepEqual(current.body.warnings, []);
    const empty = current.body.modules.map((m) => ({ ...m, enabled: false, content: '' }));
    let result = await call(endpoint, { preset: 'desktop-agent', modules: empty });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    current = await call(endpoint);
    assert.equal(current.body.content, '');
    assert.ok(current.body.modules.every((m) => !m.enabled));
    const next = empty.map((m, i) => i === 0 ? { ...m, enabled: true, content: '随意自定义' } : m);
    result = await call(endpoint, { preset: 'desktop-agent', modules: next });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const backups = (await call('/api/preset/desktop-agent-prompt/backups')).body.backups;
    const emptyBackup = backups.find((b) => {
      const file = path.join(h.temp, 'state', 'preset-backups', b.file);
      return fs.existsSync(`${file}.modules.json`) && JSON.parse(fs.readFileSync(`${file}.modules.json`, 'utf8')).modules.every((m) => !m.enabled);
    });
    assert.ok(emptyBackup, 'expected an empty prompt backup');
    result = await call('/api/preset/desktop-agent-prompt/restore', { preset: 'desktop-agent', file: emptyBackup.file });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal((await call(endpoint)).body.content, '');
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

test('runtime templates accept empty text and arbitrary placeholders', async () => {
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (body) => {
    const response = await fetch(`${base}/api/desktop-agent/prompt-templates`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const templates = (await call()).body.templates;
    const saved = await call({ templates: { ...templates, roleCard: '', qqAttention: '自定义 {anything}' } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await call()).body.templates.roleCard, '');
    assert.equal((await call()).body.templates.qqAttention, '自定义 {anything}');
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/current-role.json'), 'utf8')).roleCardTemplate, '');
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

test('the role card provider honors an empty or custom template', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-role-template-'));
  try {
    const pluginDir = path.join(temp, 'plugins', 'qq-agent-presets', 'lib');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(path.join(temp, 'state'));
    fs.mkdirSync(path.join(temp, 'roles'));
    fs.writeFileSync(path.join(temp, 'roles', 'test.md'), 'card content');
    const requireFromPlugin = createRequire(new URL('../plugins/qq-agent-presets/lib/index.js', import.meta.url));
    const schemaUrl = pathToFileURL(requireFromPlugin.resolve('@deepseek-ai/schemastery')).href;
    const source = fs.readFileSync('plugins/qq-agent-presets/lib/index.js', 'utf8')
      .replace("'@deepseek-ai/schemastery'", JSON.stringify(schemaUrl));
    const pluginFile = path.join(pluginDir, 'index.mjs');
    fs.writeFileSync(pluginFile, source);
    const plugin = await import(pathToFileURL(pluginFile).href);
    let provider;
    plugin.apply({ systemPrompt: { variable: (_name, fn) => { provider = fn; } } });
    const stateFile = path.join(temp, 'state', 'current-role.json');
    fs.writeFileSync(stateFile, JSON.stringify({ role: 'test', roleCardTemplate: '' }));
    assert.equal(provider(), '');
    fs.writeFileSync(stateFile, JSON.stringify({ role: 'test', roleCardTemplate: 'hello {roleName}' }));
    assert.equal(provider(), 'hello test');
  } finally {
    const target = path.resolve(temp);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('qq-role-template-')) {
      throw new Error('refusing to remove an unexpected role template fixture directory');
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});
