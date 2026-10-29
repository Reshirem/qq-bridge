import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import http from 'node:http';

let failures = 0;
async function test(name, run) {
  const h = await bridgeHarness();
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}
await test('malformed HTTP request targets return 400 without hanging', async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: 'http://[', method: 'GET' }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(1500, () => request.destroy(new Error('request hung')));
      request.end();
    });
    assert.equal(status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
{
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  let body;
  const h = await bridgeHarness({ globals: {
    safeFetchBuffer: async () => ({ buffer: image }),
    validateFetchUrl: async () => { throw new Error('must fetch validated bytes instead of passing a URL'); },
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
    },
  } });
  try {
    h.setReady(true);
    await h.ensureDesktopAgentSession();
    h.setDesktopAgentLifecycle('active');
    h.setDesktopAgentTurnActive(true);
    await h.sendStickerV2('group:456', 'fixture-sticker');
    assert.equal(body.message.find((part) => part.type === 'image').data.file, 'base64://' + image.toString('base64'));
    console.log('PASS sticker sending gives OneBot validated bytes, never a URL to refetch');
  } catch (error) { failures++; console.error('FAIL safe sticker sending:', error.message); }
  finally { await h.close(); }
}
// agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
// 因此仅靠控制台令牌挡不住 QQ 群里的 AI。人格/提示词/思考强度/白名单/重启等管理端点
// 必须对 agent token 一律 403，否则 AI 能改写自己的系统提示词或给自己提权。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const adminOnly = { 'x-console-token': 'fixture-console-token' };
    const asAgent = { ...adminOnly, 'x-agent-token': 'fixture-agent-token' };
    const mustDeny = [
      ['GET', '/api/roles'], ['GET', '/api/roles/content?name=x'], ['GET', '/api/roles?x=1'],
      ['POST', '/api/roles/create'], ['POST', '/api/roles/update'],
      ['POST', '/api/roles/rename'], ['POST', '/api/roles/delete'],
      ['GET', '/api/desktop-agent/prompt-templates'], ['POST', '/api/desktop-agent/prompt-templates'],
      ['GET', '/api/preset/desktop-agent-prompt'], ['POST', '/api/preset/desktop-agent-prompt'],
      ['GET', '/api/preset/desktop-agent-prompt/backups'], ['POST', '/api/preset/desktop-agent-prompt/restore'],
      ['GET', '/api/dsh/model'], ['POST', '/api/dsh/effort'],
      ['GET', '/api/whitelist'], ['POST', '/api/whitelist'], ['POST', '/api/restart'],
      ['POST', '/api/memory/records/list'],
      ['POST', '/api/console/token'], ['GET', '/api/role'], ['POST', '/api/role'],
    ];
    for (const [method, path] of mustDeny) {
      const res = await call(path, method, asAgent, method === 'POST' ? {} : undefined);
      assert.equal(res.status, 403, `${method} ${path} 必须对 agent token 拒绝，实际 HTTP ${res.status}`);
    }
    // 绕过尝试：路径穿越与重复斜杠在 URL 解析后仍需被拒
    for (const path of ['/api/roles/../roles', '/api//roles', '/api/./roles', '/api/roles/']) {
      const res = await call(path, 'GET', asAgent);
      assert.notEqual(res.status, 200, `${path} 不得绕过 agent token 限制（实际 HTTP ${res.status}）`);
    }
    // 允许面：AI 真正需要的只读接口不应被误伤
    const allowed = await call('/api/status', 'GET', asAgent);
    assert.equal(allowed.status, 200, '/api/status 应对 agent token 放行');
    // 同一批管理端点，管理员（仅控制台令牌）应可正常访问
    const adminOk = await call('/api/dsh/model', 'GET', adminOnly);
    assert.equal(adminOk.status, 200, '管理员应能访问 /api/dsh/model');
    const templatesRead = await call('/api/desktop-agent/prompt-templates', 'GET', adminOnly);
    assert.equal(templatesRead.status, 200, '管理员应能读取运行时提示模板');
    const templates = JSON.parse(templatesRead.body).templates;
    assert.ok(templates.qqAttention.includes('{sources}'));
    const updatedTemplates = { ...templates, recovery: '' };
    const templatesSaved = await call('/api/desktop-agent/prompt-templates', 'POST', adminOnly, { templates: updatedTemplates });
    assert.equal(templatesSaved.status, 200, '管理员应能保存有效运行时模板');
    assert.equal(JSON.parse(templatesSaved.body).templates.recovery, '');
    const invalidTemplates = { ...updatedTemplates, roleCard: '缺少必需占位符' };
    const templatesRejected = await call('/api/desktop-agent/prompt-templates', 'POST', adminOnly, { templates: invalidTemplates });
    assert.equal(templatesRejected.status, 400, '缺少必需占位符的模板必须拒绝');
    console.log('PASS agent token cannot reach persona/prompt/effort/whitelist admin endpoints');
  } catch (error) { failures++; console.error('FAIL agent token admin isolation:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
// The raw A_Memorix record browser is a console-only endpoint. Exercise the
// real route and agent allowlist while replacing only the local SQLite adapter.
{
  let readRequest = null;
  const h = await bridgeHarness({
    config: { memory: { enabled: true, namespace: 'fixture-space', apiKey: 'fixture-only' } },
    globals: {
      listAMemorixParagraphs: async (options) => {
        readRequest = options;
        return { hits: [{ memoryId: 'fixture-record' }], total: 1, nextCursor: '' };
      },
    },
  });
  const server = h.startConsoleServer();
  try {
    h.setReady(true);
    await h.ensureDesktopAgentSession();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (headers, body) => new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port, path: '/api/memory/records/list', method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      }, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: data }));
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(JSON.stringify(body));
    });

    const admin = { 'x-console-token': 'fixture-console-token' };
    const listed = await call(admin, { query: '群聊', origin: 'qq', limit: 10 });
    assert.equal(listed.status, 200);
    assert.equal(JSON.parse(listed.body).result.hits[0].memoryId, 'fixture-record');
    assert.equal(readRequest.namespace, 'fixture-space');
    assert.equal(readRequest.query, '群聊');
    assert.equal(readRequest.origin, 'qq');
    assert.equal(readRequest.limit, 10);

    const agentToken = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'desktop-agent.json'), 'utf8')).agentToken;
    const denied = await call({ ...admin, 'x-agent-token': agentToken, 'x-agent-call': '1' }, {});
    assert.equal(denied.status, 403, 'a valid agent credential must not open the console-only raw record browser');
    assert.equal(readRequest.query, '群聊', 'agent denial must happen before touching the local reader');
    console.log('PASS memory record browsing is console-only and forwards filters to the read-only adapter');
  } catch (error) { failures++; console.error('FAIL memory record browser authorization:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

// ── 控制台入口的传输层防护：Host 头 + 令牌定长比较 ──
// 这两条都是「审计发现 → 加固」的结果，钉住它们以防以后被无意改回去。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const admin = { 'x-console-token': 'fixture-console-token' };

    // ① DNS rebinding 硬化：非本机 Host 一律拒绝（即使带着正确的控制台令牌）。
    // 注意 Host 必须走 headers（Node 会用 options.host 覆盖它，那样测不到伪造 Host）。
    for (const host of ['evil.example.com:' + port, '127.0.0.1:1', 'localhost']) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 403, `Host=${host} 必须被拒绝，实际 HTTP ${res.status}`);
    }
    // 合法的三个 Host 都要放行（127.0.0.1 / localhost / [::1] 加实际端口）
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 200, `Host=${host} 应被接受，实际 HTTP ${res.status}`);
    }

    // ② 令牌比较必须是定长：错长度/错内容的令牌都不得通过（不能因为"前缀对"就放行）。
    // 查询参数不参与鉴权；这里也覆盖尾随空白令牌不会被误认。
    for (const token of ['fixture-console-token-x', 'fixture-console-toke', 'FIXTURE-CONSOLE-TOKEN', 'fixture-console-token ']) {
      const res = await call(`/api/status?token=${encodeURIComponent(token)}`, 'GET');
      assert.equal(res.status, 401, `令牌「${token}」不得通过鉴权，实际 HTTP ${res.status}`);
    }
    const noHeader = await call('/api/status', 'GET');
    assert.equal(noHeader.status, 401, '不带令牌必须被拒绝');

    console.log('PASS console rejects foreign Host headers and non-exact tokens');
  } catch (error) { failures++; console.error('FAIL console transport guards:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

// ── The console can create the persistent global session without starting a model turn. ──
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    h.setReady(true);
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/console/desktop-agent/ensure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
      body: '{}'
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.turnStarted, false);
    assert.equal(h.calls.created.at(-1)?.agentPreset, 'desktop-agent');
    assert.equal(h.calls.prompts.length, 0, 'creating the persistent session must not start a model turn');
    console.log('PASS console creates the persistent desktop-agent session without starting a turn');
  } catch (error) { failures++; console.error('FAIL console desktop-agent ensure:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

// ── Global desktop-agent preset refresh keeps history and refuses to interrupt a live turn. ──
{
  const h = await bridgeHarness();
  try {
    h.setReady(true);
    const oldSessionId = await h.ensureDesktopAgentSession();
    h.api.sessions.list = async () => ({ result: { ok: true, value: { items: [{ sessionId: oldSessionId, running: false }] } } });

    h.setDesktopAgentTurnActive(true);
    await assert.rejects(h.recreateDesktopAgentSession(), /当前正在运行/);
    assert.deepEqual(h.calls.archived, [], '运行中的全局会话不得归档');

    h.setDesktopAgentTurnActive(false);
    const rebuilt = await h.recreateDesktopAgentSession();
    assert.equal(rebuilt.archivedSessionId, oldSessionId);
    assert.notEqual(rebuilt.sessionId, oldSessionId, '新 preset 应加载到新会话');
    assert.deepEqual(h.calls.archived, [oldSessionId], '旧会话应归档以保留 DSH 历史');
    assert.equal(h.calls.created.at(-1)?.agentPreset, 'desktop-agent');
    console.log('PASS global desktop-agent refresh archives history and refuses to interrupt a live turn');
  } catch (error) { failures++; console.error('FAIL global desktop-agent refresh:', error.message); }
  finally { await h.close(); }
}

if (failures) process.exitCode = 1;
