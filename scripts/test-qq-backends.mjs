import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { openNativeReminders } from '../src/native-reminders.js';
import { createChatLearningStore } from '../src/chat-learning.js';
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
  const h = await bridgeHarness({config:{qqBackend:'native',qqBackendSince:Date.now()}});
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

    // Once the turn ends (agent_rest), handledThroughAt advances; subsequent reads see isNew=false for 1001..1003
    h.enterDesktopAgentRest();
    h.setDesktopAgentTurnActive(false);
    const readAfterRest = await (await fetch(`${base}/api/socialV2/conversation-history?key=group:456`, { headers })).json();
    assert.deepEqual(readAfterRest.messages.map(m => [m.messageId, m.isNew]), [
      ['1003', false], ['1002', false], ['1001', false], ['999', false]
    ]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});
