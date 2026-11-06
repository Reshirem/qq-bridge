import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { findQQMessageReference, parseQQMessageReference } from '../src/qq-message-reference.js';
import { openQQUnreadStore } from '../src/qq-unread-store.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const local55 = { seq: 55, messageId: '999', sender: '先到的人', userId: '11', text: '本地序号 55 的消息', media: [{ kind: 'face', faceId: '101' }] };
const qq55 = { seq: 56, messageId: '55', sender: '后来的人', userId: '12', text: 'QQ ID 55 的消息', media: [{ kind: 'face', faceId: '202' }] };
const state = { recentMessages: [local55, qq55], unread: [local55, qq55] };

test('typed references distinguish colliding QQ IDs and local sequences', () => {
  assert.equal(findQQMessageReference(state, 'id:55').message.text, qq55.text);
  assert.equal(findQQMessageReference(state, 'seq:55').message.text, local55.text);
  assert.equal(findQQMessageReference(state, '999').message.text, local55.text);
  assert.throws(() => findQQMessageReference(state, '55'), /id:55.*seq:55/);
  assert.equal(findQQMessageReference(state, 'id:-123').message, null);
  assert.equal(findQQMessageReference({ unread: [local55] }, 'id:55').message, null);
  assert.throws(() => findQQMessageReference({ unread: [local55] }, '55'), /id:55.*seq:55/);
  assert.throws(() => parseQQMessageReference('seq:-1'), /本地 seq/);
  const bufferId = '12345678-1234-4567-89ab-123456789abc';
  assert.equal(findQQMessageReference({ ...state, bufferId }, `seq:55@${bufferId}`).message.text, local55.text);
  assert.throws(() => findQQMessageReference({ ...state, bufferId }, 'seq:55@aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'), /缓存已清空或更换/);
  assert.throws(() => parseQQMessageReference(`id:55@${bufferId}`), /只有本地 seq/);
});

async function fixture(config = {}, legacyPause = false) {
  const h = await bridgeHarness({ config, files: {
    'state/social-v2.json': {
      paused: legacyPause,
      conversations: {
        'group:456': { recentMessages: [local55], unread: [local55], lastUnreadSeq: 55, lastReadThroughSeq: 54 },
        'group:789': { recentMessages: [{ ...qq55, text: '另一个群的同号消息' }], unread: [], lastUnreadSeq: 56 },
      },
    },
  } });
  const sessionId = await h.ensureDesktopAgentSession();
  h.api.sessions.list = async () => ({ result: { ok: true, value: { items: [{ sessionId, running: true, blank: false }] } } });
  h.setDesktopAgentLifecycle('active');
  h.setDesktopAgentTurnActive(true);
  h.bot.getMessage = async id => id === 55 ? { message_id: 55, group_id: 789, user_id: 12, message: [{ type: 'text', data: { text: '另一个群的同号消息' } }] } : null;
  h.bot.fetchFaceEntity = async (faceId) => { h.calls.faces.push(faceId); return null; };
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const token = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'desktop-agent.json'), 'utf8')).agentToken;
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, { method = 'GET', body, adminOnly = false } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...(!adminOnly ? { 'x-agent-call': '1', 'x-agent-session-id': sessionId, 'x-agent-token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  };
  return { h, call, close };
}

test('an incoming mention remains the same message through reminder, lookup and reply', async () => {
  const { h, call, close } = await fixture();
  try {
    await h.handleIncomingForTest('group', 456, {
      self_id: 42, user_id: 12, message_id: 55, sender: { card: '后来的人' },
      message: [{ type: 'at', data: { qq: '42' } }, { type: 'text', data: { text: 'QQ ID 55 的消息' } }, { type: 'face', data: { id: '202' } }],
    });
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts[0].content[0].text, '【QQ 提醒】\n- group:456，发送者 QQ 12，消息 id:55');

    const partial = await call('/api/socialV2/unread?key=group%3A456&afterSeq=55');
    assert.deepEqual(partial.data.messages.map(m => m.seq), [56]);
    assert.equal(partial.data.readThroughSeq, 54);
    assert.equal(partial.data.unreadCount, 1);
    assert.equal(h.attentionSnapshot().unresolved.length, 0);
    const skipped = await call('/api/socialV2/mark-read', { method: 'POST', body: { key: 'group:456', throughSeq: 56 } });
    assert.equal(skipped.status, 400);
    const detail = await call('/api/socialV2/message-detail?key=group%3A456&messageId=id%3A55');
    assert.equal(detail.status, 200);
    assert.equal(detail.data.info.seq, 56);
    assert.equal(detail.data.info.messageId, '55');
    assert.match(detail.data.info.text, /QQ ID 55 的消息/);
    const local = await call('/api/socialV2/message-detail?key=group%3A456&messageId=seq%3A55');
    assert.equal(local.data.info.messageId, '999');
    assert.equal(local.data.readThroughSeq, 56);
    assert.equal(local.data.unreadCount, 0);
    const otherGroup = await call('/api/socialV2/message-detail?key=group%3A789&messageId=id%3A55');
    assert.equal(otherGroup.data.info.text, '另一个群的同号消息');
    const ambiguous = await call('/api/socialV2/message-detail?key=group%3A456&messageId=55');
    assert.equal(ambiguous.status, 400);
    assert.match(ambiguous.data.error, /id:55.*seq:55/);

    const image = await call('/api/images/message?key=group%3A456&messageId=id%3A55');
    assert.equal(image.status, 200);
    assert.equal(image.data.media[0].faceId, '202');
    const localImage = await call('/api/images/message?key=group%3A456&messageId=seq%3A55');
    assert.equal(localImage.data.media[0].faceId, '101');
    const ambiguousImage = await call('/api/images/message?key=group%3A456&messageId=55');
    assert.equal(ambiguousImage.status, 400);
    const missingImage = await call('/api/images/message?key=group%3A456&messageId=id%3A404');
    assert.match(missingImage.data.note, /未找到该消息/);

    const body = { key: 'group:456', messages: '收到', replyToMessageId: 'id:55' };
    const replied = await call('/api/socialV2/send-message', { method: 'POST', body });
    assert.equal(replied.status, 200);
    const sent = h.calls.http.find((entry) => entry.url.endsWith('/send_group_msg'));
    assert.equal(sent.body.message.find((part) => part.type === 'reply').data.id, '55');
    const rejected = await call('/api/socialV2/send-message', { method: 'POST', body: { ...body, replyToMessageId: '55' } });
    assert.equal(rejected.status, 400);
    assert.equal(h.calls.http.filter((entry) => entry.url.endsWith('/send_group_msg')).length, 1);

    const unread = await call('/api/socialV2/unread?key=group%3A456&afterSeq=0');
    assert.deepEqual(unread.data.messages, []);
    assert.equal(unread.data.readThroughSeq, 56);
  } finally { await close(); }
});

test('history consumes only delivered IDs in this source, across gaps, retries and reopening the store', async () => {
  const { h, call, close } = await fixture();
  try {
    const incoming = (group, id) => h.handleIncomingForTest('group', group, {
      self_id: 42, user_id: 12, message_id: id, message: [{ type: 'text', data: { text: '消息' } }]
    });
    for (const id of [100, 101, 102]) await incoming(456, id);
    await incoming(789, 100);
    const route = '/api/socialV2/conversation-history?key=group:456';
    const entries = [100, 102].map(message_id => ({
      group_id: 456, message_id, user_id: 12, message: [{ type: 'text', data: { text: '消息' } }]
    }));
    const response = { status: 'ok', retcode: 0, data: { messages: entries } };
    h.bot.request = async () => response;
    assert.equal((await call(route, { adminOnly: true })).data.unreadCount, 4);
    h.bot.request = async () => ({ status: 'ok', retcode: 0, data: {} });
    assert.equal((await call(route)).status, 502);
    h.bot.request = async () => {
      await incoming(456, 103);
      return response;
    };
    const history = await call(route);
    assert.equal(history.data.unreadCount, 3);
    assert.equal(history.data.readThroughSeq, 54);
    h.bot.request = async () => response;
    assert.equal((await call(route)).data.unreadCount, 3);
    const store = openQQUnreadStore(path.join(h.temp, 'state', 'qq-unread.sqlite'));
    try {
      const { conversations } = store.load();
      assert.deepEqual(conversations['group:456'].unread.map(m => m.messageId), ['999', '101', '103']);
      assert.deepEqual(conversations['group:789'].unread.map(m => m.messageId), ['100']);
    } finally { store.close(); }
    const page = await call('/api/socialV2/unread?key=group:456&limit=2');
    assert.deepEqual(page.data.messages.map(m => m.seq), [55, 57]);
    assert.equal(page.data.readThroughSeq, 58);
    assert.equal(page.data.unreadCount, 1);
  } finally { await close(); }
});

test('when the gateway supplies no QQ ID, the reminder and lookup use the same local sequence', async () => {
  const { h, call, close } = await fixture();
  try {
    await h.handleIncomingForTest('group', 456, {
      self_id: 42, user_id: 12, sender: { card: '后来的人' },
      message: [{ type: 'at', data: { qq: '42' } }, { type: 'text', data: { text: '没有 QQ ID 的消息' } }],
    });
    await h.flushAttentionNow();
    const prompt = h.calls.prompts[0].content[0].text;
    assert.match(prompt, /^【QQ 提醒】\n- group:456，发送者 QQ 12，消息 seq:56@[0-9a-f-]{36}$/);
    const reference = prompt.match(/seq:56@[0-9a-f-]{36}/)[0];
    const store = openQQUnreadStore(path.join(h.temp, 'state', 'qq-unread.sqlite'));
    const saved = store.load();
    store.close();
    assert.equal(fs.existsSync(path.join(h.temp, 'state', 'social-v2.json')), false);
    assert.equal(reference, `seq:56@${saved.bufferId}`);
    const restarted = await bridgeHarness({ files: { 'state/social-v2.json': saved } });
    try {
      assert.equal(findQQMessageReference(restarted.getSocialV2State('group:456'), reference).message.seq, 56);
    } finally { await restarted.close(); }
    const detail = await call(`/api/socialV2/message-detail?key=group%3A456&messageId=${encodeURIComponent(reference)}`);
    assert.equal(detail.data.info.seq, 56);
    assert.equal(detail.data.info.messageId, null);
    assert.match(detail.data.info.text, /没有 QQ ID 的消息/);
    const history = await call(`/api/socialV2/conversation-history?key=group%3A456&messageId=${encodeURIComponent(reference)}`);
    assert.equal(history.status, 400);
    assert.match(history.data.error, /没有可用的 QQ 消息 ID/);
  } finally { await close(); }
});

test('an unsafe numeric QQ ID uses the local sequence instead of a rounded ID', async () => {
  const { h, call, close } = await fixture();
  try {
    await h.handleIncomingForTest('group', 456, {
      self_id: 42, user_id: 12, message_id: Number.MAX_SAFE_INTEGER + 1, sender: { card: '后来的人' },
      message: [{ type: 'at', data: { qq: '42' } }, { type: 'text', data: { text: '精度丢失的消息' } }],
    });
    await h.flushAttentionNow();
    const prompt = h.calls.prompts[0].content[0].text;
    assert.match(prompt, /^【QQ 提醒】\n- group:456，发送者 QQ 12，消息 seq:56@[0-9a-f-]{36}$/);
    const reference = prompt.match(/seq:56@[0-9a-f-]{36}/)[0];
    const detail = await call(`/api/socialV2/message-detail?key=group%3A456&messageId=${encodeURIComponent(reference)}`);
    assert.equal(detail.data.info.messageId, null);
    assert.match(detail.data.info.text, /精度丢失的消息/);
    const reply = await call('/api/socialV2/send-message', {
      method: 'POST', body: { key: 'group:456', messages: '收到', replyToMessageId: reference },
    });
    assert.equal(reply.status, 400);
    assert.equal(h.calls.http.filter((entry) => entry.url.endsWith('/send_group_msg')).length, 0);
  } finally { await close(); }
});

test('group reply and private send both pass the resolved quote to OneBot', async () => {
  const { h, call, close } = await fixture();
  try {
    const groupReply = await call('/api/send/reply', {
      method: 'POST', body: { groupId: '456', message: '收到', replyToMessageId: 'seq:55' },
    });
    assert.equal(groupReply.status, 200);
    const groupSend = h.calls.http.find((entry) => entry.url.endsWith('/send_group_msg'));
    assert.equal(groupSend.body.message[0].type, 'reply');
    assert.equal(groupSend.body.message[0].data.id, '999');

    const grouped = await call('/api/socialV2/send-message', {
      method: 'POST', body: { key: 'group:456', messages: ['第一条', '第二条'], replyToMessageId: 'id:999', gapMode: 'fixed', gapMs: 100 },
    });
    assert.equal(grouped.status, 200);
    const parts = h.calls.http.filter((entry) => entry.url.endsWith('/send_group_msg')).slice(-2);
    assert.equal(parts[0].body.message[0].type, 'reply');
    assert.equal(parts[0].body.message[0].data.id, '999');
    assert.equal(parts[1].body.message.some((part) => part.type === 'reply'), false);

    await h.handleIncomingForTest('private', 789, {
      self_id: 42, user_id: 789, message_id: -77, sender: { nickname: '好友' },
      message: [{ type: 'text', data: { text: '私聊消息' } }],
    });
    const privateReply = await call('/api/socialV2/send-message', {
      method: 'POST', body: { key: 'private:789', messages: '收到', replyToMessageId: 'id:-77' },
    });
    assert.equal(privateReply.status, 200);
    const privateSend = h.calls.http.find((entry) => entry.url.endsWith('/send_private_msg'));
    assert.equal(privateSend.body.message[0].type, 'reply');
    assert.equal(privateSend.body.message[0].data.id, '-77');
  } finally { await close(); }
});

test('batch messages can independently select which messages to quote', async () => {
  const { h, call, close } = await fixture();
  try {
    await h.handleIncomingForTest('group', 456, {
      self_id: 42, user_id: 12, message_id: 55, sender: { card: '后来的人' },
      message: [{ type: 'text', data: { text: 'QQ ID 55 的消息' } }],
    });
    const messages = [
      '第一条',
      { text: '第二条', replyToMessageId: 'seq:55' },
      '第三条',
      { text: '第四条', replyToMessageId: 'id:55' },
    ];
    const result = await call('/api/socialV2/send-message', {
      method: 'POST', body: { key: 'group:456', messages: JSON.stringify(messages), gapMode: 'fixed', gapMs: 100 },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.quotes.map(({ messageIndex, quoted }) => [messageIndex, quoted.messageId]), [[2, '999'], [4, '55']]);
    const sends = h.calls.http.filter((entry) => entry.url.endsWith('/send_group_msg'));
    assert.equal(sends.length, 4);
    assert.deepEqual(sends.map(({ body }) => ({
      text: body.message.find((part) => part.type === 'text').data.text,
      reply: body.message.find((part) => part.type === 'reply')?.data.id ?? null,
    })), [
      { text: '第一条', reply: null },
      { text: '第二条', reply: '999' },
      { text: '第三条', reply: null },
      { text: '第四条', reply: '55' },
    ]);

    const invalid = await call('/api/socialV2/send-message', {
      method: 'POST', body: { key: 'group:456', messages: ['不应发送', { text: '也不发送', replyToMessageId: 'id:404' }] },
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.data.error, /第 2 条消息的引用目标/);
    assert.equal(h.calls.http.filter((entry) => entry.url.endsWith('/send_group_msg')).length, 4);

    const sensitive = await call('/api/socialV2/send-message', {
      method: 'POST', body: { key: 'group:456', messages: [{ text: 'C:\\Users\\Example\\secret.txt', replyToMessageId: 'id:999' }] },
    });
    assert.equal(sensitive.status, 403);
    assert.equal(h.calls.http.filter((entry) => entry.url.endsWith('/send_group_msg')).length, 4);
  } finally { await close(); }
});

test('per-message quotes work in private chat and take precedence over the legacy first-message quote', async () => {
  const { h, call, close } = await fixture();
  try {
    await h.handleIncomingForTest('private', 789, {
      self_id: 42, user_id: 789, message_id: -77, sender: { nickname: '好友' },
      message: [{ type: 'text', data: { text: '私聊消息' } }],
    });
    const result = await call('/api/socialV2/send-message', {
      method: 'POST', body: {
        key: 'private:789',
        messages: [{ text: '第一条', replyToMessageId: 'id:-77' }, '第二条', { text: '第三条', replyToMessageId: 'id:-77' }],
        replyToMessageId: 'id:404', gapMode: 'fixed', gapMs: 100,
      },
    });
    assert.equal(result.status, 200);
    const sends = h.calls.http.filter((entry) => entry.url.endsWith('/send_private_msg'));
    assert.deepEqual(sends.map(({ body }) => body.message.find((part) => part.type === 'reply')?.data.id ?? null), ['-77', null, '-77']);
    const invalidText = await call('/api/socialV2/send-message', {
      method: 'POST', body: { key: 'private:789', messages: ['不应发送', { text: ' ', replyToMessageId: 'id:-77' }] },
    });
    assert.equal(invalidText.status, 400);
    assert.equal(h.calls.http.filter((entry) => entry.url.endsWith('/send_private_msg')).length, 3);
  } finally { await close(); }
});

test('a gateway response with a conflicting message ID is not treated as the requested message', async () => {
  const { h, call, close } = await fixture();
  try {
    h.bot.getMessage = async (id) => ({
      group_id: 456, message_id: id === 9876 ? 9875 : id, user_id: 12,
      sender: { card: '群友' }, message: [{ type: 'text', data: { text: '上游返回的消息' } }],
    });
    const wrong = await call('/api/socialV2/message-detail?key=group%3A456&messageId=id%3A9876');
    assert.equal(wrong.status, 200);
    assert.equal(wrong.data.info, null);
    const match = await call('/api/socialV2/message-detail?key=group%3A456&messageId=id%3A9877');
    assert.equal(match.data.info.messageId, '9877');
    assert.equal(match.data.info.text, '上游返回的消息');
  } finally { await close(); }
});

test('clearing the cache invalidates delivered sequence reminders even when sequence numbers are reused', async () => {
  const { h, call, close } = await fixture();
  try {
    const send = async (text) => h.handleIncomingForTest('group', 777, {
      self_id: 42, user_id: 12, sender: { card: '群友' },
      message: [{ type: 'at', data: { qq: '42' } }, { type: 'text', data: { text } }],
    });
    const lookup = (ref) => call(`/api/socialV2/message-detail?key=group%3A777&messageId=${encodeURIComponent(ref)}`);
    await send('旧消息');
    await h.flushAttentionNow();
    const oldReference = h.calls.prompts.at(-1).content[0].text.match(/seq:1@[0-9a-f-]{36}/)[0];
    assert.match((await lookup(oldReference)).data.info.text, /旧消息/);
    assert.equal((await call('/api/socialV2/reset', { method: 'POST', body: {}, adminOnly: true })).status, 200);
    await send('新消息');
    await h.flushAttentionNow();
    const newReference = h.calls.prompts.at(-1).content[0].text.match(/seq:1@[0-9a-f-]{36}/)[0];
    assert.notEqual(newReference, oldReference);
    assert.match((await lookup(newReference)).data.info.text, /新消息/);
    const stale = await lookup(oldReference);
    assert.equal(stale.status, 400);
    assert.match(stale.data.error, /缓存已清空或更换/);
  } finally { await close(); }
});

test('clearing the buffer discards old reminders even if a prior submission fails later', async () => {
  const { h, call, close } = await fixture();
  try {
    let release;
    let notify;
    const entered = new Promise((resolve) => { notify = resolve; });
    const response = new Promise((resolve) => { release = resolve; });
    h.api.sessions.prompt = async (params) => { h.calls.prompts.push(params); notify(); return response; };
    h.queueDesktopAttentionSignal({ key: 'group:456', kind: 'group', id: '456', reason: 'atMention', sender: '甲', senderId: '11', messageId: '999', seq: 55 });
    const pending = h.flushAttentionNow();
    await entered;
    const reset = await call('/api/socialV2/reset', { method: 'POST', body: {}, adminOnly: true });
    assert.equal(reset.status, 200);
    assert.equal(h.attentionSnapshot().unresolved.length, 0);
    await h.handleIncomingForTest('group', 456, {
      self_id: 42, user_id: 12, message_id: 88, sender: { card: '乙' },
      message: [{ type: 'at', data: { qq: '42' } }, { type: 'text', data: { text: '缓存清空后的消息' } }],
    });
    release({ result: { ok: false, error: { code: 'test', message: 'unavailable' } } });
    await pending;
    const snapshot = h.attentionSnapshot();
    assert.equal(snapshot.queue.length, 1);
    assert.equal(snapshot.queue[0].seq, 1);
    assert.equal(String(snapshot.queue[0].messageId), '88');
    assert.equal(snapshot.unresolved[0].seq, 1);
  } finally { await close(); }
});

test('history and sticker selection use the same typed reference', async () => {
  const { h, call, close } = await fixture();
  try {
    await h.handleIncomingForTest('group', 456, {
      self_id: 42, user_id: 12, message_id: 55, sender: { card: '后来的人' },
      message: [{ type: 'at', data: { qq: '42' } }, { type: 'face', data: { id: '202' } }],
    });
    const history = await call('/api/socialV2/conversation-history?key=group%3A456&messageId=id%3A55');
    assert.equal(history.status, 200);
    assert.equal(h.calls.onebot.find((item) => item.action === 'get_group_msg_history').params.message_id, '55');
    const localHistory = await call('/api/socialV2/conversation-history?key=group%3A456&messageId=seq%3A55');
    assert.equal(localHistory.status, 200);
    assert.equal(h.calls.onebot.filter((item) => item.action === 'get_group_msg_history').at(-1).params.message_id, '999');
    const ambiguous = await call('/api/socialV2/conversation-history?key=group%3A456&messageId=55');
    assert.equal(ambiguous.status, 400);
    const missing = await call('/api/socialV2/conversation-history?key=group%3A456&messageId=seq%3A404');
    assert.match(missing.data.error, /未找到该消息/);

    await call('/api/socialV2/collect-sticker', { method: 'POST', body: { key: 'group:456', messageId: 'id:55' } });
    assert.equal(h.calls.faces.at(-1), 202);
    await call('/api/socialV2/collect-sticker', { method: 'POST', body: { key: 'group:456', messageId: 'seq:55' } });
    assert.equal(h.calls.faces.at(-1), 101);
    const wrong = await call('/api/socialV2/collect-sticker', { method: 'POST', body: { key: 'group:456', messageId: '55' } });
    assert.equal(wrong.status, 400);
  } finally { await close(); }
});

test('legacy pause becomes one reminder preference while both send paths accept long text', async () => {
  const oldSend = { maxMessageChars: 5, maxSendPerMinute: 1, maxSendPerHour: 1, recommendedHint: 'old' };
  const { h, call, close } = await fixture({ socialV2: { send: oldSend, context: { contextWindow: 20 } } }, true);
  const settings = body => call('/api/socialV2/config', { method: 'POST', body, adminOnly: true });
  const incoming = id => h.handleIncomingForTest('private', 789, {
    self_id: 999, user_id: 789, message_id: id, sender: { nickname: '测试好友' },
    message: [{ type: 'text', data: { text: '新来信' } }],
  });
  try {
    const config = (await call('/api/socialV2/config', { adminOnly: true })).data.config;
    assert.equal(config.enabled, false);
    assert.equal('maxMessageChars' in config.send, false);
    assert.equal('context' in config, false);
    const text = '长'.repeat(600);
    assert.equal((await call('/api/send/group', { method: 'POST', body: { groupId: 456, message: text } })).status, 200);
    assert.equal((await call('/api/socialV2/send-message', { method: 'POST', body: { key: 'group:456', messages: text } })).status, 200);
    assert.equal((await settings({ enabled: true })).status, 200);
    await incoming(1001);
    assert.equal(h.attentionSnapshot().queue.length, 1);
    assert.equal((await settings({ enabled: false })).status, 200);
    await incoming(1002);
    await h.flushAttentionNow();
    assert.equal(h.attentionSnapshot().unresolved.length, 0);
    assert.equal(h.calls.prompts.length, 0);
    const state = (await call('/api/socialV2/states', { adminOnly: true })).data;
    assert.equal(state.conversations.find(row => row.key === 'private:789').unreadCount, 2);
    assert.equal((await settings({ enabled: true })).status, 200);
    await incoming(1003);
    await h.flushAttentionNow();
    assert.match(h.calls.prompts.at(-1).content[0].text, /id:1003/);
    await settings({ send: { delayPerCharMs: 20, burstEnabled: false, burstMaxMessages: 1 }, context: { unreadLimit: 1 } });
    const row = (await call('/api/socialV2/states', { adminOnly: true })).data.conversations.find(row => row.key === 'private:789');
    assert.equal(row.unreadCount, 3);
    assert.equal('recentCount' in row, false);
    const batch = await call('/api/socialV2/send-message', { method: 'POST', body: {
      key: 'group:456', messages: ['这 就是，', '🟦', '长'.repeat(80)], gapMode: 'fixed', gapMs: 99999,
    } });
    assert.equal(batch.data.sent, 3);
    assert.deepEqual(batch.data.delays, [20, 1000]);
    for (const key of ['hint', 'warn', 'splitWarn']) assert.equal(key in batch.data, false);
    await settings({ send: { delayPerCharMs: 0 } });
    const many = Array.from({ length: 20 }, () => '气泡');
    for (const route of ['send-message', 'send-burst']) {
      const sent = await call('/api/socialV2/' + route, { method: 'POST', body: { key: 'group:456', messages: many } });
      assert.equal(sent.data.sent, 20);
    }
    assert.equal((await call('/api/socialV2/wait', { method: 'POST', body: { key: 'group:456' } })).status, 404);
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
    assert.equal('maxSendPerHour' in saved.socialV2.send, false);
    assert.equal('recommendedHint' in saved.socialV2.send, false);
  } finally { await close(); }
});

test('sticker tools and QQ favorites sync can be toggled independently without a restart', async () => {
  const { call, close } = await fixture();
  const settings = sticker => call('/api/socialV2/config', { method: 'POST', body: { sticker }, adminOnly: true });
  const list = () => call('/api/socialV2/sticker-list?key=group:456');
  const sync = () => call('/api/stickers/sync', { method: 'POST', body: {}, adminOnly: true });
  try {
    await settings({ enabled: false, syncEnabled: true });
    assert.equal((await list()).status, 403);
    assert.equal((await sync()).status, 200);
    await settings({ enabled: true, syncEnabled: false });
    assert.equal((await sync()).status, 403);
    assert.equal((await list()).data.stickers.length, 1);
  } finally { await close(); }
});
