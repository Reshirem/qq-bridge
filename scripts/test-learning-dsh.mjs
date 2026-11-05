// Optional integration: installed DSH CLI + loopback fake LLM, isolated DSH_HOME.
// No real model, QQ, account credentials or production state are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { runLearningHeadless } from '../src/learning-runner.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const install = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness');
const executable = path.join(install, 'DeepSeek Harness.exe');
const entry = path.join(install, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
if (!fs.existsSync(executable)) throw new Error('This optional check requires installed Windows DSH Desktop');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-learning-dsh-'));
const requests = [];
let diagnostic = '';
const imageId = 'learned:' + 'a'.repeat(64);
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
const fixturePng = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.from([0, 120, 180, 220]))), pngChunk('IEND', Buffer.alloc(0))]).toString('base64');
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push(body);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
  emit({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  if (requests.length === 1) {
    emit({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'test_image_call', type: 'function', function: { name: 'mcp__qq-learning-images__learning_images', arguments: '{}' } }] }, finish_reason: null }] });
    emit({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    const content = JSON.stringify({ slang: [], stickers: [{ id: imageId, isSticker: true, description: '测试图像', tags: ['测试'], usage: '离线验证' }] });
    emit({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
    emit({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  }
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const model = { provider: 'qq-learning-fixture', model: 'fixture-model' };
  const provider = { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', disabled: false, config: { providers: { [model.provider]: {
    api: 'openai-completions', apiKeyEnv: 'QQ_LEARNING_FIXTURE_KEY', baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{ id: model.model, contextWindow: 32000, maxTokens: 2000, input: ['text', 'image'] }],
  } } } };
  const result = await runLearningHeadless({
    cli: { command: executable, args: ['--expose-internals', entry], shell: false, env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: path.join(temp, 'home'), QQ_LEARNING_FIXTURE_KEY: 'fixture-only' } },
    approvalPolicy: false, root, stateDir: temp, model, provider, task: '{"messages":[],"images":[{"id":"' + imageId + '"}]}',
    images: [{ id: imageId, evidence: {}, mimeType: 'image/png', data: fixturePng }],
    timeoutMs: 60000,
    spawnProcess: (...args) => {
      const child = spawn(...args);
      for (const stream of [child.stderr, child.stdout]) stream.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-16000); });
      return child;
    },
  });
  assert.equal(result.stickers[0].description, '测试图像');
  assert.ok(requests.length >= 2 && requests.length <= 4);
  assert.ok(requests.some(request => JSON.stringify(request.messages).includes('data:image/png;base64,')), 'model receives actual image bytes');
  const tools = requests[0].tools?.map(t => t.function?.name) || [];
  for (const forbidden of ['pwsh', 'bash', 'read', 'write', 'plugin_manager', 'web_fetch', 'subagent']) assert.ok(!tools.includes(forbidden), `unexpected tool ${forbidden}`);
  console.log('PASS installed DSH headless loads guard, calls image MCP and returns validated JSON through a loopback fixture');
} catch (error) {
  console.error(diagnostic);
  throw error;
} finally {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith('qq-learning-dsh-'));
  fs.rmSync(temp, { recursive: true, force: true });
}
