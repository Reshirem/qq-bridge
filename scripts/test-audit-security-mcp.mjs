// Exercise MCP callbacks with a fake transport: no network, config or stdio server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { z } from 'zod';

function loadWebTools({ safeFetch, webSearch }) {
  const tools = new Map();
  const source = fs.readFileSync(new URL('../src/mcp-web-search-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer {
    tool(name, description, schema, callback) { tools.set(name, { schema, callback }); }
    connect() {}
  }
  vm.runInNewContext(source, {
    safeFetch,
    webSearch,
    McpServer,
    StdioServerTransport: class {},
    z,
    URL,
    path,
    process,
  });
  return async (name, arguments_) => {
    const tool = tools.get(name);
    return tool.callback(z.object(tool.schema).parse(arguments_));
  };
}

test('MCP search sanitizes the query and delegates to the shared web-search module', async () => {
  const calls = [];
  const callTool = loadWebTools({
    safeFetch: async () => { assert.fail('web_search 不应绕开 webSearch() 直接抓 Bing'); },
    webSearch: async (query, options) => {
      calls.push({ query, options });
      return { query, provider: 'deepseek', results: [{ title: 'Fixture title', url: 'https://example.com/', snippet: 'Fixture summary' }] };
    }
  });
  const result = await callTool('web_search', { query: '  fixture [CQ:at,qq=1]\n phrase  ' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.query, 'fixture phrase');
  assert.equal(parsed.provider, 'deepseek');
  assert.equal(parsed.results[0].title, 'Fixture title');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, 'fixture phrase', '查询词必须先清洗再交给搜索模块');
  assert.ok(calls[0].options?.root, '必须把项目根目录传给搜索模块（用于读 config.json）');
});

test('MCP fetch uses shared transport and exposes rejection as a tool error', async () => {
  const callTool = loadWebTools({
    safeFetch: async () => { throw new Error('fixture: internal redirect rejected'); },
    webSearch: async () => { throw new Error('fixture: internal redirect rejected'); },
  });
  for (const [name, args] of [['web_fetch', { url: 'http://example.com' }], ['web_search', { query: 'fixture' }]]) {
    const result = await callTool(name, args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /internal redirect rejected/);
  }
});

test('empty searches are rejected without calling the transport', async () => {
  const callTool = loadWebTools({
    safeFetch: async () => { assert.fail('Unexpected transport call'); },
    webSearch: async () => { assert.fail('Unexpected search call'); },
  });
  const result = await callTool('web_search', { query: '[CQ:at,qq=1]\n ' });
  assert.equal(result.isError, true);
});

/**
 * 用假 transport 加载 mcp-qq.js，拿到它的工具回调。
 * 只需要把 fetch（桥接 API / OneBot HTTP）、McpServer、zod、两个本地纯模块塞进上下文。
 */
function loadQQTools(fetchImpl, fixtureConfig = null) {
  const tools = new Map();
  // vm 里没有 ESM 的 import.meta，把模块顶部的 __dirname 推导整段替换成固定值。
  const source = fs.readFileSync(new URL('../src/mcp-qq.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace("const __dirname = path.dirname(fileURLToPath(import.meta.url));", "const __dirname = '/fixture/src';")
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer {
    constructor() { this.tool = (name, description, schema, callback) => tools.set(name, { schema, callback }); }
    connect() {}
  }
  const fixtureFs = {
    ...fs,
    readFileSync(file, ...args) {
      const name = path.basename(String(file));
      if (name === 'desktop-agent.json' && String(file).includes('fixture')) {
        return JSON.stringify({ sessionId: 'fixture-session', agentToken: 'a'.repeat(64) });
      }
      if (name === 'config.json' && String(file).includes('fixture') && fixtureConfig !== null) {
        return JSON.stringify(fixtureConfig);
      }
      return fs.readFileSync(file, ...args);
    },
  };
  vm.runInNewContext(source, {
    McpServer,
    StdioServerTransport: class {},
    z,
    URL,
    URLSearchParams,
    fetch: fetchImpl,
    AbortSignal,
    process,
    setTimeout,
    clearTimeout,
    console,
    Buffer,
    path,
    fs: fixtureFs,
    SENSITIVE_RE: { test: () => false },
    serializeModelData: (value) => JSON.stringify(value),
  });
  const callTool = async (name, arguments_ = {}) => {
    const tool = tools.get(name);
    assert.ok(tool, `tool ${name} should be registered`);
    return tool.callback(z.object(tool.schema).parse(arguments_));
  };
  /** 该模式下某工具是否真的注册进了 schema（注册期收敛的断言入口）。 */
  callTool.has = (name) => tools.has(name);
  callTool.schema = (name) => tools.get(name)?.schema;
  return callTool;
}

// 回归：桥接个别分支会把 error 回成**对象**。直接 `new Error(obj)` 会变成
// "[object Object]"（r3 的已知未修项里就有一条线上记录：qq_wait_for_messages 报
// `error: "\"Error: [object Object]\""`）。必须序列化成可读文本。
test('object-shaped bridge errors are rendered readably, not as [object Object]', async () => {
  const callTool = loadQQTools(async () => Response.json(
    { ok: false, error: { code: 'send/rejected', message: '消息含敏感信息，已阻止发送' } },
    { status: 200 },
  ));
  const result = await callTool('qq_send_group_message', { groupId: '456', message: 'fixture' });
  assert.equal(result.isError, true);
  const text = String(result.content[0].text);
  assert.ok(!/\[object Object\]/.test(text), `错误文本不得是不可读的对象：${text}`);
  assert.match(text, /send\/rejected|阻止发送/, `应带出对象里的原因：${text}`);
});

// 回归：桥接用 200 + {ok:false} 表达业务失败（例如发送被安全审计拦截）。
// agentApi 若不检查 body.ok，就会把「被拦截」当成「发送成功」报给模型 ——
// 模型据此认为消息已发出，既不再重试也不告诉用户，是典型的静默错误。
test('a bridge 200 with ok:false is reported to the model as a failure', async () => {
  const callTool = loadQQTools(async () => Response.json(
    { ok: false, error: '消息含敏感信息，已阻止发送' },
    { status: 200 },
  ));
  const result = await callTool('qq_send_group_message', { groupId: '456', message: 'fixture' });
  assert.equal(result.isError, true, 'ok:false 必须作为工具错误返回');
  assert.match(result.content[0].text, /阻止发送/);
});

test('single-runtime MCP tools hide internal credentials and expose bounded session reads', async () => {
  const callTool = loadQQTools(async () => Response.json({ ok: false, error: '目标不在当前模式允许范围内' }, { status: 403 }));
  assert.equal(callTool.has('qq_list_groups'), false, 'group listing tool must stay absent');
  assert.equal(callTool.has('qq_get_group_history'), false, 'direct group history tool must stay absent');
  assert.equal(callTool.has('qq_get_group_members'), true, 'bounded group members must be registered');
  assert.equal(callTool.has('qq_get_conversation_history'), true, 'bounded conversation history must be registered');
  assert.equal(Object.hasOwn(callTool.schema('qq_get_group_members'), 'token'), false, 'bridge token must stay out of the model-facing schema');
  const denied = await callTool('qq_get_group_members', { key: 'group:999999' });
  assert.equal(denied.isError, true);
});

test('denied group reads never reveal the group allowlist', async () => {
  const fixtureConfig = { allow: { groups: ['111111', '222222'] } };
  const calls = [];
  const callTool = loadQQTools(async (url) => {
    calls.push(String(url));
    if (String(url).includes('/api/socialV2/group-members')) {
      return Response.json({ ok: false, error: '目标不在当前模式允许范围内' }, { status: 403 });
    }
    assert.fail('denied group read must not call OneBot');
  }, fixtureConfig);
  const result = await callTool('qq_get_group_members', { key: 'group:999999' });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /111111|222222/);
  assert.ok(calls.length >= 1, '应当只经过桥接的鉴权/拒绝路径');
});

const previewImage = {
  kind: 'image', index: 1, text: '预览', data: 'fixture-image-bytes', mimeType: 'image/jpeg',
  imageRef: 'fixture-source-scoped-image', representation: 'preview', width: 1280, height: 720,
  originalWidth: 4000, originalHeight: 2250, originalAvailable: false, canFetchOriginal: true,
  localPath: 'C:\\private-cache\\original.jpg', url: 'https://private.invalid/signed-image',
};
const imageMetadata = (result) => Array.from(result.content).filter(part => part.type === 'text')
  .flatMap(part => [...part.text.matchAll(/媒体信息：([^\n]+)/g)].map(match => JSON.parse(match[1])));

test('message previews expose source references and exact availability without cache internals', async () => {
  let requested;
  const callTool = loadQQTools(async (url) => {
    requested = new URL(url);
    return Response.json({ ok: true, images: [previewImage] });
  });
  const result = await callTool('qq_get_message_images', { key: 'group:123', messageId: 'id:-55' });
  assert.equal(requested.pathname, '/api/images/message');
  assert.equal(requested.searchParams.get('messageId'), 'id:-55');
  assert.deepEqual(imageMetadata(result), [{
    imageRef: previewImage.imageRef, representation: 'preview', width: 1280, height: 720,
    originalWidth: 4000, originalHeight: 2250, originalAvailable: false, canFetchOriginal: true,
  }]);
  assert.equal(result.content.filter(part => part.type === 'image').length, 1);
  const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.doesNotMatch(text, /private-cache|private\.invalid|fixture-image-bytes/);
});

test('forward previews retain single-image references including failed previews', async () => {
  const requests = [];
  const callTool = loadQQTools(async (url, init) => {
    requests.push({ path: new URL(url).pathname, body: init.body ? JSON.parse(init.body) : null });
    if (requests.at(-1).path === '/api/socialV2/forward-message') return Response.json({
      ok: true, messages: [{ media: [{ file: 'fixture-md5', nativeForwardId: 'native:1', nativeMessageId: '2' }] }],
    });
    return Response.json({ ok: true, images: [
      previewImage,
      { ...previewImage, index: 2, imageRef: 'retryable-image', data: null, text: '预览失败', originalWidth: null, originalHeight: null },
    ] });
  });
  const result = await callTool('qq_get_forward_msg', { key: 'group:123', id: 'native:1' });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].path, '/api/socialV2/forward-media');
  assert.equal(requests[1].body.media[0].nativeMessageId, '2');
  const metadata = imageMetadata(result);
  assert.equal(metadata.length, 2);
  assert.equal(metadata[0].imageRef, previewImage.imageRef);
  assert.equal(metadata[1].imageRef, 'retryable-image');
  assert.equal(metadata[1].originalWidth, null);
  assert.equal(metadata[1].originalAvailable, false);
  assert.equal(result.content.filter(part => part.type === 'image').length, 1);
  assert.doesNotMatch(JSON.stringify(metadata), /private-cache|private\.invalid|fixture-image-bytes/);
});

test('single-image detail defaults to original and preserves explicit preview/crop requests', async () => {
  const requests = [];
  const callTool = loadQQTools(async (url, init) => {
    requests.push({ path: new URL(url).pathname, method: init.method, body: JSON.parse(init.body), headers: init.headers });
    const body = requests.at(-1).body;
    return Response.json({ ok: true, images: [{
      ...previewImage, representation: body.crop ? 'crop' : body.quality,
      width: body.crop ? 1000 : 4000, height: body.crop ? 1125 : 2250, originalAvailable: true,
    }] });
  });
  const base = { key: 'group:123', imageRef: previewImage.imageRef };
  const original = await callTool('qq_get_image_detail', base);
  assert.equal(requests[0].path, '/api/socialV2/image-detail');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, { ...base, quality: 'original' });
  assert.equal(requests[0].headers['x-agent-token'], 'a'.repeat(64));
  assert.equal(original.isError, undefined);
  assert.equal(imageMetadata(original)[0].representation, 'original');
  assert.equal(imageMetadata(original)[0].width, 4000);
  await callTool('qq_get_image_detail', { ...base, quality: 'preview' });
  assert.deepEqual(requests[1].body, { ...base, quality: 'preview' });
  const crop = { x: 0.25, y: 0, width: 0.25, height: 0.5 };
  const cropped = await callTool('qq_get_image_detail', { ...base, crop });
  assert.deepEqual(requests[2].body, { ...base, quality: 'original', crop });
  assert.equal(imageMetadata(cropped)[0].representation, 'crop');
  assert.equal(cropped.content.filter(part => part.type === 'image').length, 1);
});

test('image detail rejects invalid crops before requesting the bridge', async () => {
  const callTool = loadQQTools(async () => assert.fail('invalid image detail input must not reach bridge'));
  const base = { key: 'group:123', imageRef: previewImage.imageRef };
  for (const crop of [
    { x: -0.1, y: 0, width: 0.5, height: 0.5 },
    { x: 0, y: 0, width: 0, height: 0.5 },
    { x: 0.8, y: 0, width: 0.5, height: 0.5 },
    { x: 0, y: 0.8, width: 0.5, height: 0.5 },
    { x: 0, y: 0, width: '0.5', height: 0.5 },
  ]) await assert.rejects(callTool('qq_get_image_detail', { ...base, crop }));
  await assert.rejects(callTool('qq_get_image_detail', { ...base, quality: 'raw' }));
  await assert.rejects(callTool('qq_get_image_detail', { ...base, imageRef: ' ' }));
  const result = await callTool('qq_get_image_detail', { ...base, quality: 'preview', crop: { x: 0, y: 0, width: 1, height: 1 } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /crop 仅支持 quality=original/);
});

test('image detail registration follows either existing image reading capability', () => {
  for (const [getImages, getForwardMsg, expected] of [
    [undefined, undefined, true], [true, false, true], [false, true, true], [false, false, false],
  ]) {
    const callTool = loadQQTools(async () => assert.fail('registration must not call bridge'), {
      socialV2: { tools: { getImages, getForwardMsg } },
    });
    assert.equal(callTool.has('qq_get_image_detail'), expected);
    if (expected) assert.deepEqual(Object.keys(callTool.schema('qq_get_image_detail')).sort(), ['crop', 'imageRef', 'key', 'quality']);
  }
});

test('image detail reports missing originals, bridge failures and malformed multi-image results honestly', async () => {
  for (const payload of [
    { ok: false, error: { code: 'original-unavailable', message: '原图无法获取' } },
    { ok: true, images: [], note: '原图不在缓存中' },
    { ok: true, images: [{ ...previewImage, data: null, text: '原图无法获取' }] },
    { ok: true, images: [previewImage, previewImage] },
  ]) {
    const callTool = loadQQTools(async () => Response.json(payload));
    const result = await callTool('qq_get_image_detail', { key: 'group:123', imageRef: previewImage.imageRef });
    assert.equal(result.isError, true);
    assert.equal(result.content.some(part => part.type === 'image'), false);
    assert.match(result.content[0].text, /原图|指定的单张图片/);
  }
  const callTool = loadQQTools(async () => Response.json({ ok: true, images: [{ ...previewImage, representation: 'reencoded' }] }));
  const result = await callTool('qq_get_image_detail', { key: 'group:123', imageRef: previewImage.imageRef });
  assert.equal(imageMetadata(result)[0].representation, 'reencoded', 'original request must preserve the actual returned representation');
});
