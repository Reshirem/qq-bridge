// Native message references must outlive acknowledgement without caching bodies.
// All QQ history and images are fixtures; only temporary bridge state is written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';
const digest = 'a'.repeat(32);
const settle = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

async function fixture(t) {
  const h = await bridgeHarness({config:{qqBackend:'native',
    socialV2:{media:{prefetchOnReceive:false}}}});
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await h.close();
  });
  h.bot.account = '42';
  h.bot.health = {connected:true};
  h.bot.emit('open');
  await settle();
  const session = await h.ensureDesktopAgentSession();
  h.setDesktopAgentLifecycle('active');
  h.setDesktopAgentTurnActive(true);
  const token = JSON.parse(fs.readFileSync(path.join(h.temp,'state/desktop-agent.json'),'utf8')).agentToken;
  const history = new Map(), historyCalls = [], imageCalls = [];
  h.bot.raw = async (action, params) => {
    assert.ok(['get_friend_msg_history','get_group_msg_history'].includes(action));
    const key = action === 'get_group_msg_history' ? `group:${params.group_id}` : `private:${params.user_id}`;
    historyCalls.push({key, messageId:String(params.message_id ?? '')});
    const rows = history.get(key) ?? [];
    return {messages:structuredClone(params.message_id
      ? rows.filter(row => row.message_id === String(params.message_id)).slice(0,params.count)
      : rows.slice(-params.count))};
  };
  h.bot.getImage = async params => {
    imageCalls.push(plain(params));
    return {base64:png, representation:'preview', width:1, height:1,
      originalAvailable:true, originalWidth:1, originalHeight:1};
  };
  server = h.startConsoleServer();
  if (!server.listening) await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route, {query, body, adminOnly = false} = {}) {
    const url = new URL(route,base);
    if (query) url.search = new URLSearchParams(query).toString();
    const response = await fetch(url, {
      method:body === undefined ? 'GET' : 'POST',
      headers:{'content-type':'application/json','x-console-token':'fixture-console-token',
        ...(!adminOnly ? {'x-agent-call':'1','x-agent-session-id':session,'x-agent-token':token} : {})},
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(5000),
    });
    const result = {status:response.status, ...await response.json()};
    await settle(); // The response finish event commits acknowledgement.
    return result;
  }
  async function incoming(id, key = 'private:123') {
    const [kind, peer] = key.split(':');
    const row = {self_id:'42', user_id:'123', message_id:String(id),
      sender:{user_id:'123',nickname:'fixture'}, time:Math.floor(Date.now()/1000),
      ...(kind === 'group' ? {group_id:peer} : {}),
      message:[...(kind === 'group' ? [{type:'at',data:{qq:'42'}}] : []),
        {type:'text',data:{text:'Fixture body must remain only in QQ history'}},
        {type:'image',data:{file:digest,sub_type:0}}]};
    const rows = history.get(key) ?? [];
    rows.push(row); history.set(key,rows);
    await h.handleIncomingForTest(kind,Number(peer),row);
    const st = h.getSocialV2State(key);
    const reminder = st.unread.find(item => item.messageId === String(id));
    assert.ok(reminder);
    return {messageId:String(id),seq:reminder.seq,ref:`seq:${reminder.seq}@${st.bufferId}`};
  }
  const images = (key, messageId) => call('/api/images/message',{query:{key,messageId}});
  const unread = async key => {
    const result = await call('/api/socialV2/unread',{query:{key,limit:'100'}});
    assert.equal(result.status,200,`unread request failed: ${result.error ?? JSON.stringify(result)}`);
    assert.equal(result.ok,true,`unread request was unsuccessful: ${result.error ?? JSON.stringify(result)}`);
    return result;
  };
  return {h, call, incoming, images, unread, historyCalls, imageCalls};
}

test('native unread acknowledgement keeps sequence images and details backed by QQ history', async t => {
  const f = await fixture(t), key = 'private:123';
  const message = await f.incoming('910000000000000001');
  const page = await f.unread(key);
  assert.equal(page.status,200);
  assert.equal(page.messages[0].seq,message.seq);
  assert.equal(page.messages[0].messageId,message.messageId);
  assert.equal(f.h.getSocialV2State(key).unread.length,0);

  const readsBefore = f.historyCalls.length;
  const result = await f.images(key,message.ref);
  assert.equal(result.status,200);
  assert.equal(result.images.length,1,'the sequence returned by unread must still resolve after its automatic ACK');
  assert.deepEqual(f.historyCalls.slice(readsBefore),[{key,messageId:message.messageId}]);
  assert.equal(f.imageCalls.at(-1).messageId,message.messageId);

  const detail = await f.call('/api/socialV2/message-detail',{query:{key,messageId:message.ref}});
  assert.equal(detail.status,200);
  assert.equal(detail.info?.messageId,message.messageId);
  assert.equal(detail.info?.seq,message.seq);
  assert.equal(f.historyCalls.at(-1).messageId,message.messageId);

  const marked = await f.call('/api/socialV2/mark-read',{body:{key,throughSeq:page.readThroughSeq}});
  assert.equal(marked.status,200);
  assert.equal(marked.markedCount,0,'the read response already acknowledged the message');
  assert.equal((await f.images(key,message.ref)).images.length,1);
  assert.equal((await f.images(key,`id:${message.messageId}`)).images.length,1);
  assert.deepEqual(f.h.calls.sent,[]);
});

test('a partial private history read reports older unread hints and clears prior unread records at rest while preserving post-read arrivals', async t => {
  const f = await fixture(t), key = 'private:123';
  await f.incoming('1001');
  await f.incoming('1002');
  const read = await f.call('/api/socialV2/conversation-history', {query: {key, count: 1}});
  assert.equal(read.unreadBeforeRead, 2);
  assert.equal(read.messages[0].messageId, '1002');
  assert.equal(read.hasOlderUnread, true);
  assert.equal(read.olderUnreadCount, 1);
  assert.equal(read.nextMessageId, 'id:1002');
  const state = () => f.call('/api/socialV2/state', {query: {key}});
  assert.equal((await state()).conversationUnreadCount, 2);
  assert.equal((await state()).unreadCount, 1);
  await f.incoming('1003');
  f.h.enterDesktopAgentRest();
  const after = await state();
  assert.equal(after.conversationUnreadCount, 1);
  assert.equal(after.unreadCount, 1);
  f.h.bot.account = '43'; f.h.bot.emit('open');
  f.h.bot.account = '42'; f.h.bot.emit('open');
  assert.equal((await state()).conversationUnreadCount, 1);
  assert.deepEqual((await f.unread(key)).messages.map(item => item.messageId), ['1003']);
});

test('exhausted stage-2 and aged stage-1 native reminders retire at rest and on startup', async t => {
  const f = await fixture(t), key = 'private:123';
  f.h.setReady(true);
  const fresh = await f.incoming('2001');
  await f.h.flushAttentionNow();
  const aged = await f.incoming('2002');
  const recent = await f.incoming('2003');
  await f.h.flushAttentionNow();
  const st = f.h.getSocialV2State(key);
  st.unread.find(row => row.seq === fresh.seq).stage = 2;
  const dbPath = path.join(f.h.temp, 'state/ntqq-reminders-42.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('UPDATE reminders SET stage=2 WHERE source=? AND seq=?').run(key, fresh.seq);
    db.prepare('UPDATE reminders SET stage=1, time=? WHERE source=? AND seq=?')
      .run(Date.now() - 7 * 60 * 60 * 1000, key, aged.seq);
  } finally { db.close(); }

  // enterDesktopAgentRest retires stage=2 directly via finishConversationVisits(true)
  f.h.enterDesktopAgentRest();
  assert.equal(st.unread.some(row => row.seq === fresh.seq), false);
  // Simulate bridge restart / rebind: aged stage=1 (>6h) also retires while fresh stage=1 stays
  f.h.bot.account = '43'; f.h.bot.emit('open');
  f.h.bot.account = '42'; f.h.bot.emit('open');
  const reloaded = f.h.getSocialV2State(key);
  assert.deepEqual(reloaded.unread.map(row => row.seq), [recent.seq]);
});

test('native read references retain only source locators, never history bodies or attachments', async t => {
  const f = await fixture(t), key = 'private:123';
  const message = await f.incoming('910000000000000002');
  await f.unread(key);
  const references = plain(f.h.getSocialV2State(key).readReferences);
  assert.equal(references.length,1);
  assert.equal(references[0].seq,message.seq);
  assert.equal(references[0].messageId,message.messageId);
  const allowed = new Set(['seq','messageId','reason','time','userId','stage']);
  assert.ok(Object.keys(references[0]).every(key => allowed.has(key)),
    'only the original reminder locator metadata may be retained');
  assert.doesNotMatch(JSON.stringify(references),/Fixture body|base64|"media"|"message"|"text"|"plain"/);
});

test('native acknowledged references are bounded to one hundred and isolated by source', async t => {
  const f = await fixture(t), key = 'private:123', messages = [];
  for (let index = 0; index < 102; index++) messages.push(await f.incoming(String(1000+index)));
  assert.equal((await f.unread(key)).messages.length,100);
  assert.equal((await f.unread(key)).messages.length,2);
  const st = f.h.getSocialV2State(key);
  assert.equal(st.readReferences.length,100);
  assert.deepEqual(plain(st.readReferences.map(item => item.seq)),messages.slice(2).map(item => item.seq));
  assert.equal((await f.images(key,messages[2].ref)).images.length,1);
  assert.equal((await f.images(key,messages.at(-1).ref)).images.length,1);

  const readsBefore = f.historyCalls.length;
  const evicted = await f.images(key,messages[0].ref);
  assert.equal(evicted.images.length,0);
  assert.match(evicted.note,/未找到该消息/);
  const differentSource = await f.images('group:456',messages[2].ref);
  assert.equal(differentSource.images.length,0);
  assert.equal(f.historyCalls.length,readsBefore,'missing and cross-source sequences must never guess a QQ message ID');
  assert.equal((await f.images(key,`id:${messages[0].messageId}`)).images.length,1,
    'bounded reference eviction must not remove QQ history access by exact ID');
});

test('clearing native reminders invalidates old sequence generations even after sequence reuse', async t => {
  const f = await fixture(t), key = 'private:123';
  const old = await f.incoming('910000000000000003');
  await f.unread(key);
  assert.equal((await f.call('/api/socialV2/reset',{body:{},adminOnly:true})).status,200);
  const fresh = await f.incoming('910000000000000004');
  assert.equal(fresh.seq,old.seq);
  assert.notEqual(fresh.ref,old.ref);
  const readsBefore = f.historyCalls.length;
  const rejected = await f.images(key,old.ref);
  assert.equal(rejected.status,400);
  assert.match(rejected.error,/缓存已清空或更换/);
  assert.equal(f.historyCalls.length,readsBefore);
  assert.equal((await f.images(key,fresh.ref)).images.length,1);
});

test('pre-resolved reply source exposes structured replyTo across history, detail and image hints with zero extra lookups', async t => {
  const h = await bridgeHarness({config:{qqBackend:'native', socialV2:{media:{prefetchOnReceive:false}}}});
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await h.close();
  });
  h.bot.account = '42';
  h.bot.health = {connected:true};
  h.bot.emit('open');
  await settle();
  const session = await h.ensureDesktopAgentSession();
  h.setDesktopAgentLifecycle('active');
  h.setDesktopAgentTurnActive(true);
  const token = JSON.parse(fs.readFileSync(path.join(h.temp,'state/desktop-agent.json'),'utf8')).agentToken;

  const nowSec = Math.floor(Date.now() / 1000);
  const targetA = '7711608528983746316';
  const targetB = '7711608528983746399';
  const msgWithPreResolved = '7711619941044092679';
  const msgWithMissingSourceA = '7711619941044092680';
  const msgWithMissingSourceB = '7711619941044092681';
  const msgWithEmptyTarget = '7711619941044092682';
  const sourceRowA = {
    message_id: targetA, group_id: '906759656', user_id: '1414290810', time: nowSec - 2700,
    sender: {user_id: '1414290810', nickname: '化验单群友'},
    message: [{type: 'image', data: {file: digest, sub_type: 0}}]
  };
  const sourceRowB = {
    message_id: targetB, group_id: '906759656', user_id: '2222222222', time: nowSec - 1200,
    sender: {user_id: '2222222222', nickname: '转发群友'},
    message: [
      {type: 'reply', data: {id: targetA, nativeSelf: false}},
      {type: 'text', data: {text: '看下这个转发'}},
      {type: 'forward', data: {id: `native:${targetB}`}}
    ]
  };
  const historyRows = [
    {
      message_id: msgWithPreResolved, group_id: '906759656', user_id: '2875726738', time: nowSec - 60,
      sender: {user_id: '2875726738', nickname: '提问者'},
      message: [
        {type: 'reply', data: {id: targetA, nativeSelf: false, source: sourceRowA}},
        {type: 'at', data: {qq: '42'}},
        {type: 'text', data: {text: ' 如何评价'}}
      ]
    },
    {
      message_id: msgWithMissingSourceA, group_id: '906759656', user_id: '2875726738', time: nowSec - 50,
      sender: {user_id: '2875726738', nickname: '追问者A'},
      message: [{type: 'reply', data: {id: targetB, nativeSelf: false}}, {type: 'text', data: {text: '同问B'}}]
    },
    {
      message_id: msgWithMissingSourceB, group_id: '906759656', user_id: '3333333333', time: nowSec - 40,
      sender: {user_id: '3333333333', nickname: '追问者B'},
      message: [{type: 'reply', data: {id: targetB, nativeSelf: false}}, {type: 'text', data: {text: '也问B'}}]
    },
    {
      message_id: msgWithEmptyTarget, group_id: '906759656', user_id: '4444444444', time: nowSec - 30,
      sender: {user_id: '4444444444', nickname: '普通发言'},
      message: [{type: 'text', data: {text: '纯文本无图无引用'}}]
    }
  ];
  const byId = new Map([...historyRows, sourceRowA, sourceRowB].map(r => [r.message_id, r]));
  const rawCalls = [];
  h.bot.raw = async (action, params) => {
    rawCalls.push({action, messageId: params.message_id ? String(params.message_id) : null});
    if (params.message_id) {
      const found = byId.get(String(params.message_id));
      return {messages: found ? [structuredClone(found)] : []};
    }
    return {messages: structuredClone(historyRows)};
  };

  server = h.startConsoleServer();
  if (!server.listening) await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, query) => {
    const url = new URL(route, base);
    url.search = new URLSearchParams(query).toString();
    const res = await fetch(url, {
      headers: {'content-type':'application/json', 'x-console-token':'fixture-console-token',
        'x-agent-call':'1', 'x-agent-session-id':session, 'x-agent-token':token}
    });
    return {status: res.status, ...await res.json()};
  };

  // Page read: sourceRowA came pre-resolved (0 extra calls), targetB was deduplicated once across 2 rows.
  const page = await call('/api/socialV2/conversation-history', {key:'group:906759656', count:'4'});
  assert.equal(page.status, 200);
  assert.deepEqual(rawCalls, [
    {action:'get_group_msg_history', messageId: null},
    {action:'get_group_msg_history', messageId: targetB}
  ]);
  const msgA = page.messages.find(m => m.messageId === msgWithPreResolved);
  assert.equal(msgA.text, '@42 如何评价');
  assert.equal(msgA.plain, '[引用 化验单群友：[图片]]@42 如何评价');
  assert.equal(msgA.replyTo.messageId, `id:${targetA}`);
  assert.equal(msgA.replyTo.sender, '化验单群友');
  assert.equal(msgA.replyTo.hasMedia, true);
  const msgB = page.messages.find(m => m.messageId === msgWithMissingSourceA);
  assert.equal(msgB.replyTo.messageId, `id:${targetB}`);
  assert.equal(msgB.replyTo.text, '看下这个转发[转发消息 id=native:7711608528983746399]');
  assert.deepEqual(msgB.replyTo.forwardIds, [`native:${targetB}`]);
  assert.equal(msgB.replyTo.hasForward, true);
  assert.equal('replyTo' in msgB.replyTo, false, 'replyTo stays strictly single-hop');
  assert.equal('replyTo' in page.messages.find(m => m.messageId === msgWithEmptyTarget), false);

  // Detail route preserves bare info.messageId & text while surfacing replyTo.
  rawCalls.length = 0;
  const detail = await call('/api/socialV2/message-detail', {key:'group:906759656', messageId:`id:${msgWithPreResolved}`});
  assert.equal(detail.status, 200);
  assert.equal(detail.info.messageId, msgWithPreResolved);
  assert.equal(detail.info.text, '@42 如何评价');
  assert.equal(detail.info.replyTo.messageId, `id:${targetA}`);
  assert.equal(detail.info.replyTo.hasMedia, true);
  assert.equal(rawCalls.length, 1, 'detail uses pre-resolved source without second lookup');

  // Calling qq_get_message_images with outer message ID hints at quoted image ID without silently swapping.
  const imgWrong = await call('/api/images/message', {key:'group:906759656', messageId:`id:${msgWithPreResolved}`});
  assert.equal(imgWrong.status, 200);
  assert.deepEqual(imgWrong.images, []);
  assert.match(imgWrong.note, new RegExp(`id:${targetA}.*qq_get_message_images`));
  const imgPlain = await call('/api/images/message', {key:'group:906759656', messageId:`id:${msgWithEmptyTarget}`});
  assert.equal(imgPlain.note, '该消息没有可读取的图片/表情元数据');
});
