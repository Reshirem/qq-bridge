import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const CONSOLE = { 'x-console-token': 'fixture-console-token' };
let tests = 0;
let failures = 0;

function getJson(port, { endpoint = '/api/socialV2/conversation-history', key, query = {}, token, agent = true }) {
  const search = new URLSearchParams({ key });
  for (const [name, value] of Object.entries(query)) search.set(name, String(value));
  const headers = { ...CONSOLE };
  if (agent) headers['x-agent-token'] = token;
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: `${endpoint}?${search}`, method: 'GET', headers
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, json, text });
      });
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('fixture HTTP request timed out')));
    request.end();
  });
}

async function test(name, run, options = {}) {
  tests++;
  let h;
  let server;
  try {
    h = await bridgeHarness(options);
    h.setMode('reserved2');
    server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const tokenFor = (key) => h.getSocialV2State(key).agentToken;
    await run({ h, port: server.address().port, tokenFor });
    console.log('PASS', name);
  } catch (error) {
    failures++;
    console.error('FAIL', name, error?.stack ?? error);
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(() => resolve()));
    if (h) await h.close();
  }
}

await test('history route chooses group/private actions, normalizes params and response without advancing unread receipts', async ({ h, port, tokenFor }) => {
  const groupEntries = [
    {
      message_id: 1101,
      time: 1700000000,
      sender: { user_id: 789, nickname: '小明', card: '群名片小明' },
      message: [{ type: 'text', data: { text: 'group hello' } }]
    },
    {
      messageId: 1102,
      time: 1700000000123,
      sender: { userId: 123, nickname: '鲸鱼' },
      message: [{ type: 'text', data: { text: 'bot history item' } }]
    },
    {
      message_id: 1103,
      time: 0,
      user_id: 333,
      sender_name: '群友三',
      message: [{ type: 'text', data: { text: 'fallback sender' } }]
    }
  ];
  const privateEntries = [
    {
      messageId: 2201,
      time: 1700000000456,
      userId: 888,
      sender_name: '好友小乙',
      message: [{ type: 'text', data: { text: 'private hello' } }]
    }
  ];
  const fakeRequest = h.bot.request.bind(h.bot);
  h.bot.request = async (action, params = {}) => {
    if (action === 'get_group_msg_history' || action === 'get_friend_msg_history') {
      h.calls.onebot.push({ action, params: JSON.parse(JSON.stringify(params ?? {})) });
      if (action === 'get_group_msg_history') return { status: 'ok', retcode: 0, data: groupEntries };
      return { status: 'ok', retcode: 0, data: { messages: privateEntries } };
    }
    return fakeRequest(action, params);
  };
  h.setSelfIdentity('鲸鱼', '123');

  const groupKey = 'group:456';
  const groupState = h.getSocialV2State(groupKey);
  h.appendSocialV2Message(groupKey, 'fixture-person', 'buffered unread', 'buffered unread', false, false, 'local-unread-1', [], '789', []);
  const unreadBefore = Array.from(groupState.unread, (message) => message.seq);
  const seenBefore = Array.from(groupState.modelSeenSeqs ?? []);
  const acknowledgedBefore = groupState.lastReadThroughSeq;

  const group = await getJson(port, {
    key: groupKey,
    token: tokenFor(groupKey),
    query: { messageId: '-9001', count: '101', reverseOrder: 'true' }
  });
  assert.equal(group.status, 200, `group history should succeed: ${group.text}`);
  assert.equal(group.json.action, 'get_group_msg_history');
  assert.equal(group.json.source, 'snowluma-history');
  assert.equal(group.json.messageId, '-9001');
  assert.equal(group.json.count, 3);
  assert.equal(group.json.readThroughSeq, 0, 'history should report but not advance the local read cursor');
  assert.equal(group.json.messages[0].kind, 'group');
  assert.equal(group.json.messages[0].messageId, 1101);
  assert.equal(group.json.messages[0].sender, '群名片小明');
  assert.equal(group.json.messages[0].userId, '789');
  assert.equal(group.json.messages[0].text, 'group hello');
  assert.equal(group.json.messages[0].plain, 'group hello');
  assert.equal(group.json.messages[0].tail, 'group hello');
  assert.equal(group.json.messages[0].time, 1700000000000, 'seconds timestamps should be normalized to milliseconds');
  assert.equal(group.json.messages[0].isSelf, false);
  assert.equal(group.json.messages[0].isOwner, false);
  assert.deepEqual(group.json.messages[0].media, []);
  assert.equal(group.json.messages[0].hasMedia, false);
  assert.deepEqual(group.json.messages[0].forwardIds, []);
  assert.equal(group.json.messages[0].hasForward, false);
  assert.equal(group.json.messages[1].messageId, 1102, 'camelCase OneBot aliases should be accepted');
  assert.equal(group.json.messages[1].sender, '鲸鱼');
  assert.equal(group.json.messages[1].userId, '123');
  assert.equal(group.json.messages[1].isSelf, true);
  assert.equal(group.json.messages[1].isOwner, true);
  assert.equal(group.json.messages[1].time, 1700000000123, 'millisecond timestamps should be preserved');
  assert.equal(group.json.messages[2].sender, '群友三', 'sender_name fallback should be normalized');
  assert.equal(group.json.messages[2].time, 0, 'missing timestamps should normalize to zero');

  const lowCount = await getJson(port, {
    key: groupKey,
    token: tokenFor(groupKey),
    query: { count: '-5', reverseOrder: 'TRUE' }
  });
  assert.equal(lowCount.status, 200, `low count should be clamped: ${lowCount.text}`);
  assert.equal(lowCount.json.count, 1, 'count below the minimum should be clamped to one');

  const privateKey = 'private:123';
  const privateHistory = await getJson(port, {
    key: privateKey,
    token: tokenFor(privateKey),
    query: { count: '0', reverseOrder: '1' }
  });
  assert.equal(privateHistory.status, 200, `private history should succeed: ${privateHistory.text}`);
  assert.equal(privateHistory.json.action, 'get_friend_msg_history');
  assert.equal(privateHistory.json.messageId, null);
  assert.equal(privateHistory.json.count, 1);
  assert.equal(privateHistory.json.messages[0].kind, 'private');
  assert.equal(privateHistory.json.messages[0].messageId, 2201);
  assert.equal(privateHistory.json.messages[0].sender, '好友小乙');
  assert.equal(privateHistory.json.messages[0].userId, '888');
  assert.equal(privateHistory.json.messages[0].text, 'private hello');
  assert.equal(privateHistory.json.messages[0].time, 1700000000456);

  const historyCalls = h.calls.onebot.filter(({ action }) => action === 'get_group_msg_history' || action === 'get_friend_msg_history');
  assert.equal(historyCalls.length, 3);
  assert.equal(historyCalls[0].action, 'get_group_msg_history');
  assert.deepEqual(historyCalls[0].params, {
    group_id: 456, count: 100, reverse_order: true, message_id: '-9001'
  }, 'group params should use numeric group id, clamped count, bool reverse flag, and string message id');
  assert.deepEqual(historyCalls[1].params, {
    group_id: 456, count: 1, reverse_order: false
  }, 'low count should clamp to one and non-literal true should normalize to false');
  assert.equal(historyCalls[2].action, 'get_friend_msg_history');
  assert.deepEqual(historyCalls[2].params, {
    user_id: 123, count: 20, reverse_order: false
  }, 'private params should use numeric user id and default zero count to twenty');

  assert.deepEqual(Array.from(groupState.unread, (message) => message.seq), unreadBefore, 'history reads must leave buffered unread messages untouched');
  assert.deepEqual(Array.from(groupState.modelSeenSeqs ?? []), seenBefore, 'history reads must not mark buffered messages as offered to the model');
  assert.equal(groupState.lastReadThroughSeq, acknowledgedBefore, 'history reads must not move the acknowledged watermark');
  const unreadAfterHistory = await getJson(port, {
    endpoint: '/api/socialV2/unread', key: groupKey, token: tokenFor(groupKey)
  });
  assert.equal(unreadAfterHistory.status, 200);
  assert.equal(unreadAfterHistory.json.readThroughSeq, 1, 'the unread tool must still be required to offer the buffered message');
  assert.equal(groupState.lastReadThroughSeq, acknowledgedBefore, 'offering unread still does not acknowledge it');
});

await test('history route rejects malformed key, invalid token and out-of-allowlist session before upstream access', async ({ h, port, tokenFor }) => {
  const malformed = await getJson(port, { key: 'not-a-session-key', agent: false });
  assert.equal(malformed.status, 400);
  assert.match(malformed.json.error, /key 格式/);

  const validKey = 'group:456';
  const badToken = await getJson(port, { key: validKey, token: 'not-the-session-token' });
  assert.equal(badToken.status, 403);
  assert.match(badToken.json.error, /agent token/);

  const deniedKey = 'group:999';
  const denied = await getJson(port, { key: deniedKey, token: tokenFor(deniedKey) });
  assert.equal(denied.status, 403);
  assert.match(denied.json.error, /白名单|允许范围/);

  assert.equal(h.calls.onebot.filter(({ action }) => action.includes('msg_history')).length, 0, 'invalid requests must not reach OneBot');
});

await test('history route honors the getHistory tool switch', async ({ h, port, tokenFor }) => {
  const key = 'group:456';
  const result = await getJson(port, { key, token: tokenFor(key) });
  assert.equal(result.status, 403);
  assert.match(result.json.error, /工具未启用.*qq_get_conversation_history/);
  assert.equal(h.calls.onebot.filter(({ action }) => action.includes('msg_history')).length, 0, 'disabled tool must not reach OneBot');
}, { config: { socialV2: { tools: { getHistory: false } } } });

await test('history route returns a bounded upstream error after WebSocket and HTTP failures', async ({ h, port, tokenFor }) => {
  const key = 'private:123';
  const result = await getJson(port, { key, token: tokenFor(key), query: { count: 12 } });
  assert.equal(result.status, 502);
  assert.match(result.json.error, /读取会话历史失败/);
  assert.match(result.json.error, /history upstream down/);
  assert.deepEqual(h.calls.onebot.filter(({ action }) => action === 'get_friend_msg_history')[0]?.params, {
    user_id: 123, count: 12, reverse_order: false
  });
  const fallback = h.calls.http.find(({ url }) => url.endsWith('/get_friend_msg_history'));
  assert.ok(fallback, 'WebSocket failure should exercise the HTTP fallback');
  assert.deepEqual(fallback.body, { user_id: 123, count: 12, reverse_order: false });
}, {
  onebot: {
    request: async () => ({ status: 'failed', retcode: 77, wording: 'fixture ws failure' }),
    httpAction: async (action) => action === 'get_friend_msg_history'
      ? { ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 88, wording: 'history upstream down' }) }
      : undefined
  }
});

console.log(`Conversation history regression: ${tests - failures}/${tests} passed`);
if (failures) process.exitCode = 1;
