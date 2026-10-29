import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { findQQMessageReference, parseQQMessageReference } from '../src/qq-message-reference.js';
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
  assert.equal(findQQMessageReference({ recentMessages: [local55] }, 'id:55').message, null);
  assert.throws(() => findQQMessageReference({ recentMessages: [local55] }, '55'), /id:55.*seq:55/);
  assert.throws(() => parseQQMessageReference('seq:-1'), /本地 seq/);
  const bufferId = '12345678-1234-4567-89ab-123456789abc';
  assert.equal(findQQMessageReference({ ...state, bufferId }, `seq:55@${bufferId}`).message.text, local55.text);
  assert.throws(() => findQQMessageReference({ ...state, bufferId }, 'seq:55@aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'), /缓存已清空或更换/);
  assert.throws(() => parseQQMessageReference(`id:55@${bufferId}`), /只有本地 seq/);
});

async function fixture() {
  const h = await bridgeHarness({ files: {
    'state/social-v2.json': {
      paused: false,
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
  h.bot.getMessage = async () => null;
  h.bot.fetchFaceEntity = async (faceId) => { h.calls.faces.push(faceId); return null; };
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const token = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'desktop-agent.json'), 'utf8')).agentToken;
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, { method = 'GET', body, adminOnly = false } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...(!adminOnly ? { 'x-agent-token': token } : {}) },
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
    assert.equal(h.calls.prompts[0].content[0].text, '【QQ 提醒】\n- group:456，消息 id:55');

    const detail = await call('/api/socialV2/message-detail?key=group%3A456&messageId=id%3A55');
    assert.equal(detail.status, 200);
    assert.equal(detail.data.info.seq, 56);
    assert.equal(detail.data.info.messageId, '55');
    assert.match(detail.data.info.text, /QQ ID 55 的消息/);
    const local = await call('/api/socialV2/message-detail?key=group%3A456&messageId=seq%3A55');
    assert.equal(local.data.info.messageId, '999');
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
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
    assert.equal(saved.conversations['group:456'].sendTimes.length, 1, 'ambiguous quote must not consume sending quota');

    const partial = await call('/api/socialV2/unread?key=group%3A456&afterSeq=55');
    assert.equal(partial.data.readThroughSeq, 54);
    assert.equal(h.attentionSnapshot().unresolved.length, 1);
    const unread = await call('/api/socialV2/unread?key=group%3A456&afterSeq=0');
    assert.equal(unread.data.messages.at(-1).messageId, '55');
    assert.equal(unread.data.readThroughSeq, 56);
    assert.equal(h.attentionSnapshot().unresolved.length, 0);
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
    assert.match(prompt, /^【QQ 提醒】\n- group:456，消息 seq:56@[0-9a-f-]{36}$/);
    const reference = prompt.match(/seq:56@[0-9a-f-]{36}/)[0];
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
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
    assert.match(prompt, /^【QQ 提醒】\n- group:456，消息 seq:56@[0-9a-f-]{36}$/);
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
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
    assert.equal(saved.conversations['group:456'].sendTimes.length, 4, 'invalid later quote must roll back the whole batch quota');

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
