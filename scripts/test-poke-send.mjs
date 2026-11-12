// Entirely offline: no live QQ process, credentials or contacts are used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { NativeQQ } from '../src/native-qq.js';
import startNativeRuntime from './ntqq-probe/runtime.cjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function nativeFixture(t) {
  const bot = new NativeQQ('.'), calls = [];
  bot.account = '42';
  bot.call = async (action, params) => { calls.push({action, params}); return {accepted:true}; };
  t.after(() => bot.close());
  return {bot, calls};
}

test('NativeQQ maps group and private poke targets to native contacts', async t => {
  const {bot, calls} = nativeFixture(t);
  bot.read = async (action, params) => {
    assert.equal(action, 'uid'); assert.deepEqual(params, {uin:'123'}); return 'u_friend';
  };
  assert.deepEqual(await bot.raw('group_poke', {group_id:456, user_id:123}), {accepted:true});
  await bot.raw('send_poke', {user_id:'123'});
  assert.deepEqual(calls, [
    {action:'poke', params:{peer:{chatType:2, peerUid:'456'}, targetUin:'123', aioUin:'456'}},
    {action:'poke', params:{peer:{chatType:1, peerUid:'u_friend'}, targetUin:'123', aioUin:'123'}},
  ]);
});

test('NativeQQ resolves a missing private UID through QQ, and refuses unresolved targets', async t => {
  const {bot, calls} = nativeFixture(t);
  bot.read = async () => null;
  let uid = 'u_friend';
  bot.call = async (action, params) => { calls.push({action, params}); return action === 'resolveUid' ? uid : {accepted:true}; };
  await bot.raw('send_poke', {user_id:123});
  assert.deepEqual(calls[0], {action:'resolveUid', params:{uin:'123'}});
  assert.equal(calls[1].params.peer.peerUid, 'u_friend');
  calls.length = 0; uid = null;
  await assert.rejects(bot.raw('send_poke', {user_id:123}), /无法解析/);
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'resolveUid');
});

test('NativeQQ rejects invalid numbers before asking QQ', async t => {
  const {bot, calls} = nativeFixture(t);
  for (const bad of [undefined, '', '0', '-1', '12.5', '1e3', 'u_friend', '9223372036854775808']) {
    await assert.rejects(bot.raw('send_poke', {user_id:bad}), /编号无效/);
    await assert.rejects(bot.raw('group_poke', {group_id:bad, user_id:'123'}), /编号无效/);
  }
  assert.equal(calls.length, 0);
});

for (const change of ['account', 'connection']) {
  test(`NativeQQ cancels when ${change} changes during private UID resolution`, async t => {
    const {bot, calls} = nativeFixture(t);
    const resolving = Promise.withResolvers(), resolved = Promise.withResolvers();
    bot.read = () => { resolving.resolve(); return resolved.promise; };
    const sent = bot.raw('send_poke', {user_id:123});
    await resolving.promise;
    if (change === 'account') bot.account = '43';
    else bot.call = async (...args) => calls.push(args);
    resolved.resolve('u_friend');
    await assert.rejects(sent, /已切换/);
    assert.equal(calls.length, 0);
  });
}

test('NativeQQ propagates an unknown result without retrying the poke', async t => {
  const {bot, calls} = nativeFixture(t);
  bot.call = async (...args) => { calls.push(args); throw Error('QQ 请求超时，操作结果未知'); };
  await assert.rejects(bot.raw('group_poke', {group_id:456, user_id:123}), /结果未知/);
  assert.equal(calls.length, 1);
});

async function runtimeFixture(t) {
  const oldAuth = globalThis.authData, pending = new Map();
  let socket, lines, next = 0;
  const hello = Promise.withResolvers(), removed = Promise.withResolvers();
  const svc = {addKernelMsgListener:() => 1, removeKernelMsgListener:() => removed.resolve()};
  const server = net.createServer(peer => {
    socket = peer;
    lines = createInterface({input:peer});
    lines.on('line', line => {
      const packet = JSON.parse(line);
      if (packet.hello) hello.resolve(packet);
      else { pending.get(packet.id)?.resolve(packet); pending.delete(packet.id); }
    });
  });
  t.after(async () => {
    socket?.destroy(); lines?.close();
    await new Promise(resolve => server.close(resolve));
    await removed.promise;
    if (oldAuth === undefined) delete globalThis.authData; else globalThis.authData = oldAuth;
  });
  globalThis.authData = {uid:'u_self', uin:'42'};
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  startNativeRuntime({getMsgService:() => svc}, {pipe:{host:'127.0.0.1', port:server.address().port}, token:'fixture'});
  assert.equal((await hello.promise).account, '42');
  return {svc, request:params => {
    const id = ++next, reply = Promise.withResolvers();
    pending.set(id, reply);
    socket.write(JSON.stringify({id, action:'poke', params}) + '\n');
    return reply.promise;
  }};
}

test('real QQ runtime invokes sendNudge once per request and checks native results', {timeout:5000}, async t => {
  const {svc, request} = await runtimeFixture(t), calls = [];
  const group = {peer:{chatType:2, peerUid:'456'}, targetUin:'123', aioUin:'456'};
  const privateTarget = {peer:{chatType:1, peerUid:'u_friend'}, targetUin:'123', aioUin:'123'};
  let reply = {result:0};
  svc.sendNudge = async (...args) => { calls.push(args); if (reply instanceof Error) throw reply; return reply; };
  for (const params of [group, privateTarget]) {
    assert.deepEqual((await request(params)).data, {accepted:true});
    assert.deepEqual(calls.at(-1), [params.peer, params.targetUin, params.aioUin]);
  }
  for (const result of [{result:5, errMsg:'QQ 拒绝本次戳一戳'}, {}, undefined, Error('原生调用中断')]) {
    reply = result;
    const count = calls.length, packet = await request(group);
    assert.ok(packet.error); assert.equal(packet.data, undefined);
    assert.equal(calls.length, count + 1, 'failed sends are never retried');
    if (result?.errMsg) assert.equal(packet.error, result.errMsg);
    if (result instanceof Error) assert.equal(packet.error, result.message);
  }
  delete svc.sendNudge;
  assert.match((await request(group)).error, /不支持原生戳一戳/);
});

test('real QQ runtime rejects invalid contacts and account changes without calling sendNudge', {timeout:5000}, async t => {
  const {svc, request} = await runtimeFixture(t), calls = [];
  svc.sendNudge = async (...args) => { calls.push(args); return {result:0}; };
  const valid = {peer:{chatType:2, peerUid:'456'}, targetUin:'123', aioUin:'456'};
  for (const delta of [
    {peer:null}, {peer:{chatType:3, peerUid:'456'}}, {peer:{chatType:2, peerUid:'789'}},
    {targetUin:123}, {targetUin:'-1'}, {aioUin:'9223372036854775808'},
    {peer:{chatType:1, peerUid:'u_friend'}},
  ]) assert.match((await request({...valid, ...delta})).error, /不匹配/);
  globalThis.authData = {uid:'u_changed', uin:'43'};
  assert.match((await request(valid)).error, /登录账号已切换/);
  assert.equal(calls.length, 0);
});

async function routeFixture(t, backend = 'native') {
  const h = await bridgeHarness({config:{qqBackend:backend, socialV2:{reminders:{poke:false}}}});
  if (backend === 'native') { h.bot.account = '42'; h.bot.health = {connected:true}; h.bot.emit('open'); }
  h.setReady(true);
  const session = await h.ensureDesktopAgentSession();
  const token = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/desktop-agent.json'), 'utf8')).agentToken;
  const server = h.startConsoleServer();
  if (!server.listening) await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await h.close(); });
  const calls = [];
  h.bot.raw = async (action, params) => { calls.push({action, params:JSON.parse(JSON.stringify(params))}); return {accepted:true}; };
  h.bot.getGroupMemberList = async () => [{user_id:'123'}];
  return {h, calls, post:async (body, credentials = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/send-poke`, {
      method:'POST', headers:{'content-type':'application/json', 'x-agent-call':'1',
        'x-console-token':'fixture-console-token', 'x-agent-session-id':session, 'x-agent-token':token, ...credentials},
      body:JSON.stringify(body),
    });
    return {status:response.status, ...await response.json()};
  }};
}

for (const backend of ['native', 'snowluma']) {
  test(`${backend}: route sends group/private pokes even with incoming poke reminders disabled`, async t => {
    const {post, calls} = await routeFixture(t, backend);
    for (const body of [{key:'group:456', targetUserId:'123'}, {key:'private:123'}, {key:'private:123', targetUserId:'123'}]) {
      const result = await post(body);
      assert.equal(result.status, 200); assert.equal(result.ok, true); assert.equal(result.targetUserId, '123');
    }
    assert.deepEqual(calls, [
      {action:'group_poke', params:{group_id:456, user_id:123}},
      {action:'send_poke', params:{user_id:123}}, {action:'send_poke', params:{user_id:123}},
    ]);
  });
}

test('route rejects invalid targets, nonmembers and missing/wrong credentials before sending', async t => {
  const {post, calls, h} = await routeFixture(t);
  for (const body of [
    {key:'group:456'}, {key:'group:456', targetUserId:'-1'}, {key:'private:123', targetUserId:'999'},
    {key:'group:456', targetUserId:'9007199254740993'},
  ]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.equal((await post({key:'private:9007199254740993'})).status, 403, 'invalid key is rejected at the session policy boundary');
  assert.equal((await post({key:'group:456', targetUserId:'999'})).status, 403);
  for (const token of ['', 'invalid']) assert.equal((await post({key:'private:123'}, {'x-agent-token':token})).status, 403);
  assert.equal((await post({key:'private:123'}, {'x-agent-session-id':'wrong-session'})).status, 403);
  h.bot.getGroupMemberList = async () => { throw Error('群成员查询失败'); };
  const result = await post({key:'group:456', targetUserId:'123'});
  assert.equal(result.status, 403); assert.match(result.error, /群成员查询失败/);
  assert.equal(calls.length, 0);
});

test('route refuses an account switch while awaiting group membership', async t => {
  const {post, calls, h} = await routeFixture(t);
  h.bot.getGroupMemberList = async () => {
    h.bot.account = '43'; h.bot.emit('open');
    return [{user_id:'123'}];
  };
  const result = await post({key:'group:456', targetUserId:'123'});
  assert.equal(result.status, 500); assert.match(result.error, /账号已切换/);
  assert.equal(calls.length, 0);
});

test('route reports a backend failure and does not update successful action state', async t => {
  const {post, h} = await routeFixture(t);
  let calls = 0;
  h.bot.raw = async () => { calls++; throw Error('QQ 拒绝本次戳一戳'); };
  const before = h.getSocialV2State('private:123').lastActionAt;
  const result = await post({key:'private:123'});
  assert.equal(result.status, 500); assert.equal(result.ok, false); assert.match(result.error, /QQ 拒绝本次/);
  assert.equal(h.getSocialV2State('private:123').lastActionAt, before);
  assert.equal(calls, 1);
});
