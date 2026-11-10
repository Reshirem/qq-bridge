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
