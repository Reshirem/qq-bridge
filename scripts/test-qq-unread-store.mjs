import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openQQUnreadStore } from '../src/qq-unread-store.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('incremental unread commits survive reopening, preserve other sources, and roll back invalid batches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-unread-test-'));
  const file = path.join(dir, 'unread.sqlite');
  let store = openQQUnreadStore(file);
  try {
    store.replace('buffer-one', false, []);
    const messages = Array.from({ length: 500 }, (_, i) => ({ seq: i + 1, text: '消息' + i }));
    store.save('group:1', { lastUnreadSeq: 500 }, messages);
    store.save('private:2', { lastUnreadSeq: 1 }, [{ seq: 1, text: '私聊' }]);
    messages.shift();
    messages.push({ seq: 501, text: '新来信' });
    store.save('group:1', { lastUnreadSeq: 501 }, messages);
    store.save('group:1', { lastUnreadSeq: 501, lastReadThroughSeq: 100 }, messages.slice(99));
    assert.throws(() => store.save('group:1', { lastUnreadSeq: 502 }, [{ seq: 502, text: 1n }]));
    store.close();
    store = openQQUnreadStore(file);
    const snapshot = store.load();
    assert.equal(snapshot.bufferId, 'buffer-one');
    assert.equal(snapshot.conversations['group:1'].unread.length, 401);
    assert.equal(snapshot.conversations['group:1'].unread[0].seq, 101);
    assert.equal(snapshot.conversations['group:1'].lastUnreadSeq, 501);
    assert.equal(snapshot.conversations['private:2'].unread[0].text, '私聊');
    store.replace('buffer-two', false, []);
    assert.equal(Object.keys(store.load().conversations).length, 0);
    assert.equal(store.load().bufferId, 'buffer-two');
  } finally {
    store.close();
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  }
});

test('incoming backlog caps at 500, pages without skipping, and reads historical media after acknowledgement', async () => {
  const h = await bridgeHarness();
  let server;
  try {
    const sessionId = await h.ensureDesktopAgentSession();
    h.setDesktopAgentLifecycle('sleeping');
    for (let i = 1; i <= 520; i++) {
      await h.handleIncomingForTest('group', 456, {
        self_id: 42, user_id: 789, message_id: i,
        message: [{ type: 'text', data: { text: '测试消息' } }],
      });
    }
    const st = h.getSocialV2State('group:456');
    assert.equal(st.unread.length, 500);
    assert.equal('recentMessages' in st, false);
    assert.equal(st.unread[0].seq, 21);
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(r => server.once('listening', r));
    const token = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/desktop-agent.json'), 'utf8')).agentToken;
    const headers = { 'x-console-token': 'fixture-console-token', 'x-agent-token': token, 'x-agent-call': '1', 'x-agent-session-id': sessionId, 'content-type': 'application/json' };
    const call = async (route, body) => {
      const response = await fetch('http://127.0.0.1:' + server.address().port + route,
        { headers, method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    let after = 0;
    for (let page = 0; page < 5; page++) {
      const data = await call('/api/socialV2/unread?key=group:456&limit=100&afterSeq=' + after);
      assert.equal(data.messages.length, 100);
      assert.equal(data.messages[0].seq, 21 + page * 100);
      assert.equal(data.hasMore, page < 4);
      after = data.nextAfterSeq;
      assert.equal(data.readThroughSeq, after);
    }
    // A new message arriving after the last read must survive acknowledgement.
    await h.handleIncomingForTest('group', 456, { user_id: 789, message_id: 521, message: [{ type:'text',data:{text:'后来'} }] });
    await call('/api/socialV2/mark-read', { key: 'group:456', throughSeq: after });
    assert.equal(st.unread.length, 1);
    assert.equal(st.unread[0].seq, 521);
    h.bot.request = async (action, params) => {
      assert.equal(action, 'get_group_msg_history');
      assert.equal(params.group_id, 456);
      return { status: 'ok', retcode: 0, data: { messages: [
        { group_id: 456, message_id: 100, user_id: 789, message: [{ type: 'face', data: { id: '101' } }] },
      ] } };
    };
    const image = await call('/api/images/message?key=group:456&messageId=id:100');
    assert.equal(image.media[0].faceId, '101');
    const history = await call('/api/socialV2/conversation-history?key=group:456');
    assert.equal(history.messages[0].messageId, 100);
    assert.equal(st.unread.length, 1);
    assert.equal('recentMessages' in st, false);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});
