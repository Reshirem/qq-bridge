// Offline route regressions: only temporary bridge state and fake QQ responses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const rootId = 'native:7700000000000000001';
const nestedId = `${rootId}:-7700000000000000002`;
const nodeId = '7700000000000000003';
const digest = 'a'.repeat(32);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';

async function routeFixture(t, backend = 'native', options = {}) {
  const h = await bridgeHarness({...options, config:{...options.config, qqBackend:backend}});
  if (backend === 'native') {
    h.bot.account = '42'; h.bot.health = {connected:true}; h.bot.emit('open');
  }
  h.setReady(true);
  const session = await h.ensureDesktopAgentSession();
  const token = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/desktop-agent.json'), 'utf8')).agentToken;
  const server = h.startConsoleServer();
  if (!server.listening) await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await h.close(); });
  const calls = [];
  h.bot.raw = async (action, params) => { calls.push({action, params:structuredClone(params)}); return {messages:[]}; };
  async function request(route, {query, body, credentials = {}} = {}) {
    const headers = {'content-type':'application/json', 'x-agent-call':'1',
      'x-console-token':'fixture-console-token', 'x-agent-session-id':session, 'x-agent-token':token};
    for (const [key, value] of Object.entries(credentials)) {
      if (value == null) delete headers[key]; else headers[key] = value;
    }
    const url = new URL(`/api/socialV2/${route}`, `http://127.0.0.1:${server.address().port}`);
    if (query) url.search = new URLSearchParams(query).toString();
    const response = await fetch(url, {method:body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status, ...await response.json()};
  }
  return {h, calls, request};
}

for (const backend of ['native', 'snowluma']) {
  test(`${backend}: forward root and nested previews preserve backend parameters and content`, async t => {
    const {h, calls, request} = await routeFixture(t, backend);
    const id = backend === 'native' ? rootId : 'resource-root';
    const child = backend === 'native' ? nestedId : 'resource-child';
    const mediaContext = backend === 'native' ? {nativeForwardId:id, nativeMessageId:nodeId} : {};
    h.bot.raw = async (action, params) => {
      calls.push({action, params:structuredClone(params)});
      assert.equal(action, 'get_forward_msg');
      if (params.id === child) return {messages:[{message_id:'9', sender:{user_id:'456', nickname:'nested'},
        message:[{type:'text', data:{text:'Nested content'}}]}]};
      assert.equal(params.id, id);
      return {messages:[{message_id:nodeId, sender:{user_id:'123', nickname:'author'}, time:1700000000,
        message:[{type:'text', data:{text:'Forward text'}},
          {type:'image', data:{file:digest, ...mediaContext}},
          {type:'forward', data:{id:child}}]}]};
    };
    const response = await request('forward-message', {query:{key:'group:456', id}});
    assert.equal(response.status, 200); assert.equal(response.ok, true);
    assert.deepEqual(calls, [id, child].map(value => ({action:'get_forward_msg',
      params:{id:value, ...(backend === 'native' ? {key:'group:456'} : {})}})));
    assert.equal(response.total, 1);
    assert.equal(response.messages[0].text, 'Forward text[图片][转发]');
    assert.equal(response.messages[0].sender, 'author');
    assert.equal(response.messages[0].userId, '123');
    assert.equal(response.messages[0].messageId, nodeId);
    const returnedMedia = response.messages[0].media[0];
    if (backend === 'native') {
      assert.match(returnedMedia.imageRef, /^qqimg:/);
      assert.equal(returnedMedia.canFetchOriginal, true);
    }
    const {imageRef, canFetchOriginal, ...originalMedia} = returnedMedia;
    assert.deepEqual(originalMedia, {kind:'image', file:digest, ...mediaContext});
    assert.deepEqual(response.messages[0].nestedForwardIds, [child]);
    assert.equal(response.nestedPreviews[0].id, child);
    assert.equal(response.nestedPreviews[0].messages[0].text, 'Nested content');
    assert.deepEqual(h.calls.sent, []);
  });
}

test('native: a stalled optional nested preview still returns the root content', {timeout:12000}, async t => {
  const {h, request} = await routeFixture(t);
  h.bot.raw = async (_, params) => params.id === rootId ? {messages:[{message:[
    {type:'text', data:{text:'Root already read'}}, {type:'forward', data:{id:nestedId}},
  ]}]} : new Promise(() => {});
  const response = await request('forward-message', {query:{key:'group:456', id:rootId}});
  assert.equal(response.status, 200);
  assert.match(response.messages[0].text, /Root already read/);
  assert.equal(response.nestedPreviews[0].id, nestedId);
  assert.match(response.nestedPreviews[0].error, /预览超时/);
});

test('forward routes reject missing or wrong agent credentials before calling QQ', async t => {
  const {calls, request} = await routeFixture(t);
  for (const credentials of [{'x-agent-token':null}, {'x-agent-token':''}, {'x-agent-token':'wrong'},
    {'x-agent-session-id':'wrong-session'}]) {
    assert.equal((await request('forward-message', {query:{key:'group:456', id:rootId}, credentials})).status, 403);
    assert.equal((await request('forward-media', {body:{key:'group:456', media:[]}, credentials})).status, 403);
  }
  // Console authentication alone is still insufficient for the forward-content route.
  assert.equal((await request('forward-message', {query:{key:'group:456', id:rootId},
    credentials:{'x-agent-token':null, 'x-agent-call':null}})).status, 403);
  assert.deepEqual(calls, []);
});

test('forward route rejects empty and malformed resource ids before calling QQ', async t => {
  const {calls, request} = await routeFixture(t);
  for (const id of ['', 'native:123\n456', '<unsafe>', 'x'.repeat(257)]) {
    assert.equal((await request('forward-message', {query:{key:'group:456', id}})).status, 400, id);
  }
  assert.deepEqual(calls, []);
});

test('native message detail keeps backend forward ids for direct ids and reminder references', async t => {
  const {h, calls, request} = await routeFixture(t);
  const messageId = rootId.slice('native:'.length);
  h.bot.raw = async (action, params) => {
    calls.push({action, params:structuredClone(params)});
    assert.equal(action, 'get_friend_msg_history');
    assert.equal(params.user_id, 123); assert.equal(params.message_id, messageId);
    return {messages:[{message_id:messageId, user_id:'123', sender:{nickname:'author'},
      message:[{type:'forward', data:{id:rootId}}]}]};
  };
  const direct = await request('message-detail', {query:{key:'private:123', messageId:`id:${messageId}`}});
  assert.equal(direct.status, 200);
  assert.deepEqual(direct.info.forwardIds, [rootId]);
  assert.equal(direct.info.hasForward, true);
  assert.equal(direct.info.text, `[转发消息 id=${rootId}]`);
  await h.handleIncomingForTest('private', 123, {self_id:'42', user_id:'123', message_id:messageId,
    message:[{type:'forward', data:{id:rootId}}]});
  const reminder = h.getSocialV2State('private:123').unread[0];
  assert.equal(reminder.messageId, messageId);
  assert.equal(reminder.forwardIds, undefined, 'reminder storage contains no forward payload');
  const recalled = await request('message-detail', {query:{key:'private:123', messageId:`seq:${reminder.seq}`}});
  assert.equal(recalled.status, 200);
  assert.deepEqual(recalled.info.forwardIds, [rootId], 'empty reminder fields must not overwrite the backend');
  assert.equal(recalled.info.hasForward, true);
  assert.equal(recalled.info.seq, reminder.seq);
  assert.equal(recalled.info.text, direct.info.text);
  assert.equal(calls.length, 2);
  assert.deepEqual(h.calls.sent, []);
});

test('native forward images pass source, forward and node ids to the cache reader', async t => {
  const {h, request} = await routeFixture(t);
  const calls = [];
  h.bot.getImage = async params => { calls.push(structuredClone(params)); return {base64:png}; };
  const media = [{kind:'image', file:digest, nativeForwardId:nestedId, nativeMessageId:nodeId}];
  const response = await request('forward-media', {body:{key:'group:456', media}});
  assert.equal(response.status, 200); assert.equal(response.ok, true);
  assert.deepEqual(calls, [{file:digest, maxBytes:32 * 1024 * 1024, quality:'preview', key:'group:456', forwardId:nestedId, messageId:nodeId}]);
  assert.equal(response.images.length, 1);
  assert.equal(response.images[0].kind, 'image');
  assert.equal(response.images[0].mimeType, 'image/png');
  assert.equal(response.images[0].data, png);
  assert.deepEqual(h.calls.sent, []);
});

test('native forward media rejects missing or malformed locators before cache access', async t => {
  const {h, request} = await routeFixture(t);
  const calls = [];
  h.bot.getImage = async params => { calls.push(params); return {base64:png}; };
  const valid = {kind:'image', file:digest, nativeForwardId:rootId, nativeMessageId:nodeId};
  for (const media of [null, {kind:'image', file:digest}, {...valid, nativeForwardId:''},
    {...valid, nativeForwardId:'native:0'}, {...valid, nativeForwardId:'native:1:2:3'},
    {...valid, nativeMessageId:''}, {...valid, nativeMessageId:'0'}, {...valid, nativeMessageId:'../file'}]) {
    assert.equal((await request('forward-media', {body:{key:'group:456', media:[media]}})).status, 400);
  }
  assert.equal((await request('forward-media', {body:{key:'', media:[valid]}})).status, 400);
  assert.equal((await request('forward-media', {body:{key:'invalid', media:[valid]}})).status, 403);
  const empty = await request('forward-media', {body:{key:'group:456', media:[]}});
  assert.equal(empty.status, 200); assert.deepEqual(empty.images, []);
  assert.deepEqual(calls, []);
});

function forwardImages(count) {
  return Array.from({length:count}, (_, index) => ({
    kind:'image', file:(index + 1).toString(16).repeat(32),
    nativeForwardId:rootId, nativeMessageId:String(200 + index),
  }));
}

test('native forward images retain QQ failure codes without exposing raw diagnostics', async t => {
  const {h, request} = await routeFixture(t);
  h.bot.getImage = async () => { throw Error('QQ 转发图片下载失败（QQ 2006021，服务端 -6101）：https://example.invalid/signed?token=secret'); };
  const response = await request('forward-media', {body:{key:'group:456',media:forwardImages(1)}});
  assert.equal(response.ok, true);
  assert.equal(response.images[0].text, '（QQ 转发图片下载失败（QQ 2006021，服务端 -6101））');
  assert.doesNotMatch(JSON.stringify(response), /secret|example\.invalid/);
});

test('native forward images report bounded cache size failures without exposing extra diagnostics', async t => {
  const {h, request} = await routeFixture(t);
  const message = 'QQ 本地图片缓存均超过读取大小上限（8388608 字节），未重复下载';
  h.bot.getImage = async () => { throw Error(message); };
  const response = await request('forward-media', {body:{key:'group:456',media:forwardImages(1)}});
  assert.equal(response.ok, true);
  assert.equal(response.images[0].text, `（${message}）`);
  h.bot.getImage = async () => { throw Error(message + ' https://example.invalid/?token=secret'); };
  const untrusted = await request('forward-media', {body:{key:'group:456',media:forwardImages(1)}});
  assert.equal(untrusted.images[0].text, '（图片获取失败）');
  assert.doesNotMatch(JSON.stringify(untrusted), /secret|example\.invalid/);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'the offline request did not reach its expected state');
}

function controlledImages(t) {
  const pending = new Map(), started = [];
  let active = 0, peak = 0;
  t.after(() => { for (const item of pending.values()) item.resolve({base64:png}); });
  return {
    pending, started, get peak() { return peak; },
    getImage(params) {
      started.push(params.messageId);
      active++; peak = Math.max(peak, active);
      return new Promise((resolve, reject) => {
        pending.set(params.messageId, {resolve, reject});
      }).finally(() => { active--; pending.delete(params.messageId); });
    },
    finish(index, error) {
      const item = pending.get(String(200 + index));
      assert.ok(item, `image ${index + 1} has not started`);
      if (error) item.reject(error); else item.resolve({base64:png});
    },
  };
}

// Only the isolated bridge VM sees this clock. HTTP and test deadlines stay real.
function mediaClock(t) {
  let now = Date.now(), armed = false;
  const timers = new Set(), realTimers = new Set(), delays = [];
  const fire = () => {
    for (const timer of [...timers]) {
      if (timer.at <= now) { timers.delete(timer); timer.fn(); }
    }
  };
  t.after(() => {
    now += 1000000; fire();
    for (const timer of realTimers) clearTimeout(timer);
  });
  return {
    delays, arm() { armed = true; }, advance(ms) { now += ms; fire(); },
    globals: {
      Date: class extends Date { static now() { return now; } },
      setTimeout(fn, ms) {
        if (armed && ms > 0 && ms <= 45000) {
          const timer = {at:now + ms, fn, unref() {}};
          delays.push(ms); timers.add(timer); return timer;
        }
        const timer = setTimeout(fn, ms); realTimers.add(timer); return timer;
      },
      clearTimeout(timer) {
        if (!timers.delete(timer)) { realTimers.delete(timer); clearTimeout(timer); }
      },
    },
  };
}

test('native forward images use two workers, retain partial success and preserve source order/count', async t => {
  const controlled = controlledImages(t);
  const {h, request} = await routeFixture(t);
  h.bot.getImage = controlled.getImage;
  const media = forwardImages(6);
  const responsePromise = request('forward-media', {body:{key:'group:456', media}});
  await waitFor(() => controlled.started.length === 2);
  controlled.finish(1);
  await waitFor(() => controlled.started.length === 3);
  controlled.finish(2, Error('fixture image unavailable'));
  await waitFor(() => controlled.started.length === 4);
  controlled.finish(3);
  await waitFor(() => controlled.started.length === 5);
  controlled.finish(4);
  controlled.finish(0);
  const response = await responsePromise;
  assert.equal(response.status, 200); assert.equal(response.ok, true);
  assert.equal(controlled.peak, 2);
  assert.deepEqual(controlled.started, ['200','201','202','203','204']);
  assert.deepEqual(response.images.map(image => image.index), [1,2,3,4,5,6]);
  assert.deepEqual(response.images.filter(image => image.data).map(image => image.index), [1,2,4,5]);
  assert.match(response.images[2].text, /获取失败/);
  assert.match(response.images[5].text, /超过单条上限 5/);
  assert.deepEqual(h.calls.sent, []);
});

test('native forward media retires timed-out workers and bounds the whole batch without losing completed images', async t => {
  const clock = mediaClock(t), controlled = controlledImages(t);
  const {h, request} = await routeFixture(t, 'native', {
    config:{socialV2:{media:{maxCount:8}}}, globals:clock.globals,
  });
  h.bot.getImage = controlled.getImage;
  clock.arm();
  const responsePromise = request('forward-media', {body:{key:'group:456', media:forwardImages(8)}});
  await waitFor(() => controlled.started.length === 2);
  clock.advance(40000); controlled.finish(0);
  await waitFor(() => controlled.started.length === 3);
  clock.advance(5000); // Image 2 is still pending; this slot must retire.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controlled.started.length, 3);
  clock.advance(39000); controlled.finish(2);
  await waitFor(() => controlled.started.length === 4);
  clock.advance(44000); controlled.finish(3);
  await waitFor(() => controlled.started.length === 5);
  clock.advance(7000); // The whole 135s budget expires before a new 45s slot.
  const response = await responsePromise;
  assert.equal(response.status, 200); assert.equal(response.ok, true);
  assert.equal(controlled.peak, 2, 'an expired but uncancelled QQ read still occupies its slot');
  // The request-body deadline precedes the five image deadlines in this VM.
  assert.deepEqual(clock.delays.slice(-controlled.started.length), [45000,45000,45000,45000,7000]);
  assert.deepEqual(controlled.started, ['200','201','202','203','204']);
  assert.deepEqual(response.images.map(image => image.index), [1,2,3,4,5,6,7,8]);
  assert.deepEqual(response.images.filter(image => image.data).map(image => image.index), [1,3,4]);
  for (const index of [1,4]) assert.match(response.images[index].text, /读取超时.*重试/);
  for (const index of [5,6,7]) assert.match(response.images[index].text, /预算已用尽.*重试/);
});

test('native concurrent forward media applies the shared byte limit in source order', async t => {
  const controlled = controlledImages(t);
  const {h, request} = await routeFixture(t, 'native', {
    config:{socialV2:{media:{maxBytes:256 * 1024}}},
    globals:{normalizeImageForModel:async () => ({ok:true, buffer:Buffer.alloc(180 * 1024), mimeType:'image/png'})},
  });
  h.bot.getImage = controlled.getImage;
  const responsePromise = request('forward-media', {body:{key:'group:456', media:forwardImages(2)}});
  await waitFor(() => controlled.started.length === 2);
  controlled.finish(1);
  await waitFor(() => !controlled.pending.has('201'));
  controlled.finish(0);
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.ok(response.images[0].data, 'the first source image wins even when it completes last');
  assert.equal(response.images[1].data, undefined);
  assert.equal(response.images[1].mimeType, undefined);
  assert.match(response.images[1].text, /图片总大小超限/);
  assert.equal(Buffer.byteLength(response.images[0].data, 'base64'), 180 * 1024);
});
