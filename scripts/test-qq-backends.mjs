import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { openNativeReminders } from '../src/native-reminders.js';
import { createChatLearningStore } from '../src/chat-learning.js';
import { QQ_READ_MAX_MODEL_BYTES, serializeModelData } from '../src/qq-model-view.js';
import os from 'node:os';

test('independent mode stores only reminder references and never opens the SnowLuma cache', async () => {
  const h = await bridgeHarness({config:{qqBackend:'native',qqBackendSince:Date.now()}});
  try {
    h.bot.account = '42'; h.bot.health = {connected:true};
    h.bot.emit('open');
    h.setDesktopAgentLifecycle('active');
    const msg = (id,text,at) => ({self_id:'42',group_id:456,user_id:123,message_id:id,
      message:[...(at ? [{type:'at',data:{qq:'42'}}] : []), {type:'text',data:{text}}]});
    await h.handleIncomingForTest('group',456,msg('910000000000000001','ordinary text fixture',false));
    await h.handleIncomingForTest('group',456,msg('910000000000000002','private marker fixture',true));
    await h.handleIncomingForTest('group',456,msg('910000000000000002','private marker fixture',true));
    const st = h.getSocialV2State('group:456');
    assert.equal(st.unread.length,1);
    assert.equal(st.unread[0].messageId,'910000000000000002');
    assert.equal(st.unread[0].text,undefined);
    assert.equal(h.attentionSnapshot().queue[0].count,1);
    assert.equal(fs.existsSync(path.join(h.temp,'state/qq-unread.sqlite')),false);
    const db = new DatabaseSync(path.join(h.temp,'state/ntqq-reminders-42.sqlite'),{readOnly:true});
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM reminders').get().n,1);
      assert.deepEqual(db.prepare('PRAGMA table_info(reminders)').all().map(col => col.name),
        ['source','id','seq','reason','time','sender','stage']);
    } finally { db.close(); }
    h.bot.account = '43'; h.bot.emit('open');
    assert.equal(h.getSocialV2State('group:456').unread.length,0);
    // Simulate time spent on SnowLuma: the previous native coverage predates activation.
    const inactive = new DatabaseSync(path.join(h.temp,'state/ntqq-reminders-42.sqlite'));
    try { inactive.prepare('UPDATE settings SET value=? WHERE key=?').run('1','coverage'); }
    finally { inactive.close(); }
    h.bot.account = '42'; h.bot.emit('open');
    assert.equal(h.getSocialV2State('group:456').unread.length,1);
    assert.equal(h.calls.http.some(c => String(c.url).includes(':3000/')),false);
  } finally { await h.close(); }
});

test('reminders resume delivery after reopen and acknowledgements survive replay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'qq-reminder-test-'));
  const file = path.join(dir,'reminders.sqlite');
  let store = openNativeReminders(file);
  try {
    store.replace('test');
    const now = Date.now(), key = 'private:123';
    store.add(key,{messageId:'987654321012345678',seq:1,reason:'private',time:now,userId:'123'});
    store.delivered(key,1,false);
    store.close(); store = openNativeReminders(file);
    assert.equal(store.load().conversations[key].unread[0].stage,1);
    store.delivered(key,1,true);
    assert.equal(store.load().conversations[key].unread[0].stage,2);
    store.acknowledge(key,{},[1]);
    assert.equal(store.load().conversations[key].unread.length,0);
    assert.ok(store.seen(key,'987654321012345678'));
    store.cover(now+120001);
    assert.equal(store.seen(key,'987654321012345678'),false);
    const learning = createChatLearningStore(path.join(dir,'learning.json'));
    const config = {enabled:true,slang:true,stickers:true,sources:[],maxImages:2};
    learning.enqueue(key,{messageId:'42',nativeAccount:'987',plain:'sample message body',
      media:[{kind:'sticker',file:'sample attachment path'}]},config);
    const queue = learning.snapshot().queue;
    assert.equal(queue.length,1);
    assert.equal(queue[0].imageCount,1);
    assert.doesNotMatch(JSON.stringify(queue), /sample message body|sample attachment path/);
    assert.equal(learning.batch(config,now,true),null);
  } finally {
    store.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('SnowLuma mode opens only its own message buffer', async () => {
  const h = await bridgeHarness();
  try {
    assert.equal(fs.existsSync(path.join(h.temp,'state/qq-unread.sqlite')),true);
    assert.equal(fs.readdirSync(path.join(h.temp,'state')).some(file => file.startsWith('ntqq-reminders-')),false);
  } finally { await h.close(); }
});

test('unread conversation list and turn-scoped handled watermark preserve isNew across in-turn lookups', async () => {
  // The fixture drives turn boundaries directly, including recovery after a transport error.
  const h = await bridgeHarness({
    config: {qqBackend: 'native', qqBackendSince: Date.now()},
    globals: {setTimeout: () => ({unref() {}}), clearTimeout() {}},
  });
  h.bot.account = '42'; h.bot.health = {connected:true}; h.bot.emit('open');
  h.setDesktopAgentLifecycle('active');
  h.setReady(true);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    const session = await h.ensureDesktopAgentSession();
    const state = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/desktop-agent.json'), 'utf8'));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      'x-console-token': 'fixture-console-token',
      'x-agent-call': '1',
      'x-agent-session-id': session,
      'x-agent-token': state.agentToken
    };
    const msg = (groupId, id, text, timeSec) => ({
      self_id: '42', group_id: groupId, user_id: 123, message_id: String(id), time: timeSec,
      message: [{ type: 'text', data: { text } }]
    });
    // Group 456 receives 3 ordinary messages; Group 789 receives none.
    await h.handleIncomingForTest('group', 456, msg(456, 1001, 'new msg 1', 1000));
    await h.handleIncomingForTest('group', 456, msg(456, 1002, 'new msg 2', 1001));
    await h.handleIncomingForTest('group', 456, msg(456, 1003, 'new msg 3', 1002));

    h.bot.raw = async (action) => {
      if (action === 'get_group_list') return [{ group_id: '456', group_name: '活跃群' }, { group_id: '789', group_name: '安静群' }];
      if (action === 'get_friend_list') return [];
      if (action === 'get_group_msg_history') {
        return {
          messages: [
            msg(456, 1003, 'new msg 3', 1002),
            msg(456, 1002, 'new msg 2', 1001),
            msg(456, 1001, 'new msg 1', 1000),
            msg(456, 999, 'older context msg', 900)
          ]
        };
      }
      return {};
    };

    // Default onlyUnread=true hides group:789 and shows unreadCount=3, suggestedReadCount=13 for group:456
    const unreadList = await (await fetch(`${base}/api/socialV2/conversations`, { headers })).json();
    assert.equal(unreadList.onlyUnread, true);
    assert.equal(unreadList.conversations.length, 1);
    assert.equal(unreadList.conversations[0].key, 'group:456');
    assert.equal(unreadList.conversations[0].unreadCount, 3);
    assert.equal(unreadList.conversations[0].suggestedReadCount, 13);

    const allList = await (await fetch(`${base}/api/socialV2/conversations?onlyUnread=false`, { headers })).json();
    assert.equal(allList.conversations.length, 2);

    // During an active turn, reading history marks 1001..1003 as isNew=true and 999 as isNew=false
    h.setDesktopAgentTurnActive(true);
    const read1 = await (await fetch(`${base}/api/socialV2/conversation-history?key=group:456`, { headers })).json();
    assert.equal(read1.unreadBeforeRead, 3);
    assert.deepEqual(read1.messages.map(m => [m.messageId, m.isNew]), [
      ['1003', true], ['1002', true], ['1001', true], ['999', false]
    ]);

    // A second read in the same turn (e.g. after looking up info) preserves isNew=true on 1001..1003!
    const read2 = await (await fetch(`${base}/api/socialV2/conversation-history?key=group:456`, { headers })).json();
    assert.deepEqual(read2.messages.map(m => [m.messageId, m.isNew]), [
      ['1003', true], ['1002', true], ['1001', true], ['999', false]
    ]);

    // Reading the latest page only stages the source badge. Exact queue acknowledgements
    // can be persisted by other code while the turn is still in progress.
    assert.equal(read2.unreadBeforeRead, 3);
    const readBadge = async () => {
      const response = await fetch(`${base}/api/socialV2/conversations?onlyUnread=false`, { headers });
      const data = await response.json();
      assert.equal(response.status, 200, data.error);
      return data.conversations.find(row => row.key === 'group:456').unreadCount;
    };
    assert.equal(await readBadge(), 3);
    h.enterDesktopAgentRest();
    h.setDesktopAgentTurnActive(false);
    assert.equal(await readBadge(), 0);
    const readAfterRest = await (await fetch(`${base}/api/socialV2/conversation-history?key=group:456`, {
      headers: { 'x-console-token': 'fixture-console-token' },
    })).json();
    assert.deepEqual(readAfterRest.messages.map(m => [m.messageId, m.isNew]), [
      ['1003', false], ['1002', false], ['1001', false], ['999', false]
    ]);

    h.setDesktopAgentLifecycle('active');
    h.setDesktopAgentTurnActive(true);
    const send = (group, id) => h.handleIncomingForTest('group', group, msg(group, id, '来信', id));
    await send(789, 2000);
    h.getSocialV2State('group:456').unreadMessageCount = 499;
    await send(456, 2500);
    await send(456, 2501);
    const originalRaw = h.bot.raw;
    let duringRead = false;
    h.bot.raw = async (action, params) => {
      if (action !== 'get_group_msg_history') return originalRaw(action, params);
      if (duringRead) { duringRead = false; await send(456, 2502); }
      return { messages: [msg(456, 2501, '最新一条', 2501)] };
    };
    const route = base + '/api/socialV2/conversation-history?key=group:456&count=1';
    const read = async (suffix = '', auth = headers) => {
      const response = await fetch(route + suffix, { headers: auth });
      assert.equal(response.status, 200);
      return response.json();
    };
    await read('', { 'x-console-token': 'fixture-console-token' });
    await read('&messageId=id:2001');
    h.enterDesktopAgentRest();
    assert.equal(await readBadge(), 500);
    h.setDesktopAgentLifecycle('active');
    duringRead = true;
    const partial = await read();
    assert.equal(partial.count, 1);
    assert.equal(partial.unreadBeforeRead, 500);
    await send(456, 2503);
    assert.equal(await readBadge(), 500);
    const loadStored = () => {
      const store = openNativeReminders(path.join(h.temp, 'state/ntqq-reminders-42.sqlite'));
      try { return store.load().conversations; } finally { store.close(); }
    };
    assert.equal(loadStored()['group:456'].unreadMessageCount, 500);
    h.enterDesktopAgentRest();
    assert.equal(await readBadge(), 2);
    assert.equal(loadStored()['group:456'].unreadMessageCount, 2);
    assert.equal(loadStored()['group:789'].unreadMessageCount, 1);

    const endTurn = async kind => {
      const consumed = Promise.withResolvers();
      h.api.events.mux = async function* () {
        yield { payload: { type: 'session/event', sessionId: session,
          event: { type: 'turn/end', data: { turn: 1, reason: { kind } } } } };
        consumed.resolve();
        await new Promise(() => {});
      };
      void h.pumpMux();
      await consumed.promise;
    };
    h.setDesktopAgentLifecycle('active');
    h.setDesktopAgentTurnActive(true);
    await read();
    await endTurn('error');
    assert.equal(await readBadge(), 2);
    h.setDesktopAgentLifecycle('active');
    h.setDesktopAgentTurnActive(true);
    await read();
    await endTurn('completed');
    assert.equal(await readBadge(), 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});

test('native runtime receives and sends non-friend group temporary private messages (chatType=100)', async t => {
  const net = await import('node:net');
  const { createInterface } = await import('node:readline');
  const { once } = await import('node:events');
  const { default: startNativeRuntime } = await import('./ntqq-probe/runtime.cjs');

  const oldAuth = globalThis.authData, pending = new Map(), prepared = [], sentPeers = [];
  let socket, lines, listener, next = 0, eventWaiter = Promise.withResolvers();
  const hello = Promise.withResolvers(), removed = Promise.withResolvers();
  const svc = {
    addKernelMsgListener: l => { listener = l; return 1; },
    removeKernelMsgListener: () => removed.resolve(),
    generateMsgUniqueId: () => '9001',
    getTempChatInfo: async (chatType, uid) => ({
      result: 0,
      tmpChatInfo: { chatType: 100, peerUid: uid, groupCode: '575000000', fromNick: '测试群', sig: new Uint8Array([1, 2, 3]) }
    }),
    prepareTempChat: async info => { prepared.push(info); return { result: 0 }; },
    getMsgsByMsgId: async (peer, ids) => ({
      result: 0,
      msgList: [{ msgId: ids[0], msgSeq: '1', msgTime: '1000', chatType: 100, peerUid: peer.peerUid, senderUin: '156365184', senderUid: 'u_stranger' }]
    }),
    sendMsg: async (_id, peer, elements) => {
      sentPeers.push({ peer, elements });
      setImmediate(() => listener.onMsgInfoListUpdate([{
        msgId: '9002', msgSeq: '2', sendStatus: 2, chatType: 100, peerUid: peer.peerUid, senderUin: '42', guildId: ''
      }]));
      return { result: 0 };
    }
  };
  const receiver = {
    getMsgService: () => svc,
    getBuddyService: () => ({ isBuddy: async uid => uid === 'u_friend' })
  };
  const server = net.createServer(peer => {
    socket = peer;
    lines = createInterface({ input: peer });
    lines.on('line', line => {
      const packet = JSON.parse(line);
      if (packet.hello) hello.resolve(packet);
      else if (packet.event) eventWaiter.resolve(packet.event);
      else { pending.get(packet.id)?.resolve(packet); pending.delete(packet.id); }
    });
  });
  t.after(async () => {
    socket?.destroy(); lines?.close();
    await new Promise(resolve => server.close(resolve));
    await removed.promise;
    if (oldAuth === undefined) delete globalThis.authData; else globalThis.authData = oldAuth;
  });
  globalThis.authData = { uid: 'u_self', uin: '42' };
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  startNativeRuntime(receiver, { pipe: { host: '127.0.0.1', port: server.address().port }, token: 'fixture' });
  await hello.promise;

  // 1. Incoming chatType=100 temporary message is forwarded as private message
  await listener.onRecvMsg([{
    msgId: '8001', msgTime: '1700000000', chatType: 100, peerUid: 'u_stranger',
    senderUid: 'u_stranger', senderUin: '156365184', sendNickName: '路人',
    elements: [{ textElement: { content: 'hello' } }]
  }]);
  const incomingEvent = await eventWaiter.promise;
  assert.equal(incomingEvent.message_type, 'private');
  assert.equal(incomingEvent.user_id, '156365184');

  // 2. Sending to { chatType: 1, peerUid: 'u_stranger' } upgrades to chatType=100, prepares temp chat, and resolves receipt
  const id = ++next, reply = Promise.withResolvers();
  pending.set(id, reply);
  socket.write(JSON.stringify({
    id, action: 'send',
    params: {
      peer: { chatType: 1, peerUid: 'u_stranger' },
      message: [{ type: 'reply', data: { id: '8001' } }, { type: 'text', data: { text: '你好呀' } }]
    }
  }) + '\n');
  const res = await reply.promise;
  assert.equal(res.error, undefined);
  assert.equal(res.data?.message_id, '9002');
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].chatType, 100);
  assert.equal(prepared[0].fromGroupCode, '575000000');
  assert.equal(sentPeers.length, 1);
  assert.equal(sentPeers[0].peer.chatType, 100);
});

test('conversation-history and unread cap model-view payload bytes, report pagination, and acknowledge only returned items', async () => {
  // 1. Native conversation-history byte budget & pagination
  const hNative = await bridgeHarness({
    config: { qqBackend: 'native', qqBackendSince: Date.now() },
    globals: { setTimeout: () => ({ unref() {} }), clearTimeout() {} }
  });
  hNative.bot.account = '42'; hNative.bot.health = { connected: true }; hNative.bot.emit('open');
  hNative.setDesktopAgentLifecycle('active');
  const nativeServer = hNative.startConsoleServer();
  if (!nativeServer.listening) await new Promise(resolve => nativeServer.once('listening', resolve));
  try {
    const session = await hNative.ensureDesktopAgentSession();
    const state = JSON.parse(fs.readFileSync(path.join(hNative.temp, 'state/desktop-agent.json'), 'utf8'));
    const headers = {
      'x-console-token': 'fixture-console-token',
      'x-agent-call': '1',
      'x-agent-session-id': session,
      'x-agent-token': state.agentToken
    };
    const base = `http://127.0.0.1:${nativeServer.address().port}`;
    const longHistory = Array.from({ length: 180 }, (_, idx) => {
      const id = 5000 - idx;
      return {
        self_id: '42', group_id: 456, user_id: 100 + (idx % 5), message_id: String(id), time: 1700000000 + (180 - idx),
        sender: { card: `群友${idx % 5}` },
        message: [{ type: 'text', data: { text: `历史消息#${id}：` + '长文'.repeat(90) } }]
      };
    });
    for (const row of longHistory.slice(0, 120)) {
      await hNative.handleIncomingForTest('group', 456, {
        ...row,
        message: [{ type: 'at', data: { qq: '42' } }, ...row.message]
      });
    }
    hNative.bot.raw = async (action, params) => {
      if (action === 'get_group_msg_history') {
        const startIdx = params?.message_id ? longHistory.findIndex(m => m.message_id === String(params.message_id)) : 0;
        return { messages: longHistory.slice(Math.max(0, startIdx), Math.max(0, startIdx) + (params?.count || 20)) };
      }
      return [];
    };
    const res = await fetch(`${base}/api/socialV2/conversation-history?key=group:456&count=180`, { headers });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.partial, true);
    assert.equal(data.hasMore, true);
    assert.equal(data.requestedCount, 180);
    assert.ok(data.count > 0 && data.count < 180);
    assert.equal(data.nextMessageId, `id:${data.messages.at(-1).messageId}`);
    assert.ok(Buffer.byteLength(serializeModelData(data)) <= QQ_READ_MAX_MODEL_BYTES);
    // Only the returned unread messages are acknowledged; unreturned reminders remain pending.
    assert.equal(data.unreadCount, 120 - data.count);

    // Follow-up page using nextMessageId succeeds without hitting the spill threshold.
    const nextRes = await fetch(`${base}/api/socialV2/conversation-history?key=group:456&count=180&messageId=${encodeURIComponent(data.nextMessageId)}`, { headers });
    assert.equal(nextRes.status, 200);
    const nextData = await nextRes.json();
    assert.equal(nextData.messages[0].messageId, data.messages.at(-1).messageId);
    assert.ok(Buffer.byteLength(serializeModelData(nextData)) <= QQ_READ_MAX_MODEL_BYTES);
  } finally {
    await new Promise(resolve => nativeServer.close(resolve));
    await hNative.close();
  }

  // 2. SnowLuma unread byte budget, partial flag, and accurate readThroughSeq
  const hSnow = await bridgeHarness({ config: { qqBackend: 'snowluma' } });
  hSnow.setDesktopAgentLifecycle('active');
  const snowServer = hSnow.startConsoleServer();
  if (!snowServer.listening) await new Promise(resolve => snowServer.once('listening', resolve));
  try {
    const session = await hSnow.ensureDesktopAgentSession();
    const state = JSON.parse(fs.readFileSync(path.join(hSnow.temp, 'state/desktop-agent.json'), 'utf8'));
    const headers = {
      'x-console-token': 'fixture-console-token',
      'x-agent-call': '1',
      'x-agent-session-id': session,
      'x-agent-token': state.agentToken
    };
    const base = `http://127.0.0.1:${snowServer.address().port}`;
    for (let i = 1; i <= 100; i += 1) {
      await hSnow.handleIncomingForTest('group', 456, {
        self_id: '42', group_id: 456, user_id: 100 + (i % 4), message_id: String(8000 + i), time: 1700001000 + i,
        sender: { card: `群友${i % 4}` },
        message: [{ type: 'text', data: { text: `未读#${i}：` + '长消息'.repeat(90) } }]
      });
    }
    const page1 = await (await fetch(`${base}/api/socialV2/unread?key=group:456&limit=100`, { headers })).json();
    assert.equal(page1.partial, true);
    assert.equal(page1.hasMore, true);
    assert.ok(page1.messages.length > 0 && page1.messages.length < 100);
    assert.equal(page1.nextAfterSeq, page1.messages.at(-1).seq);
    assert.equal(page1.readThroughSeq, page1.nextAfterSeq);
    assert.equal(page1.unreadCount, 100 - page1.messages.length);
    assert.ok(Buffer.byteLength(serializeModelData(page1)) <= QQ_READ_MAX_MODEL_BYTES);

    const page2 = await (await fetch(`${base}/api/socialV2/unread?key=group:456&limit=100&afterSeq=${page1.nextAfterSeq}`, { headers })).json();
    assert.equal(page2.messages[0].seq, page1.nextAfterSeq + 1);
    assert.ok(Buffer.byteLength(serializeModelData(page2)) <= QQ_READ_MAX_MODEL_BYTES);
  } finally {
    await new Promise(resolve => snowServer.close(resolve));
    await hSnow.close();
  }
});
