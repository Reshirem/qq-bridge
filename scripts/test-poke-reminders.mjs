import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { NativeQQ } from '../src/native-qq.js';
import startNativeRuntime from './ntqq-probe/runtime.cjs';
import net from 'node:net';
import { createInterface } from 'node:readline';

const poke = (extra = {}) => ({post_type:'notice',notice_type:'notify',sub_type:'poke',self_id:'42',
  group_id:'456',user_id:'123',target_id:'42',message_id:'910000000000000123',
  action:'抱起',suffix:'任意自定义文案',...extra});

async function setup(config = {}, globals) {
  const h = await bridgeHarness({config, globals});
  if (config.qqBackend === 'native') { h.bot.account = '42'; h.bot.health = {connected:true}; h.bot.emit('open'); }
  h.setDesktopAgentLifecycle('active');
  h.setReady(false);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening',resolve));
  const close = h.close;
  h.close = async () => { await new Promise(resolve => server.close(resolve)); await close(); };
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {'x-console-token':'fixture-console-token','content-type':'application/json'};
  const settings = async body => {
    const response = await fetch(base + '/api/socialV2/config',{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal(response.status,200);
    return (await response.json()).config;
  };
  const read = async route => {
    h.setReady(true);
    const session = await h.ensureDesktopAgentSession();
    const state = JSON.parse(fs.readFileSync(path.join(h.temp,'state/desktop-agent.json'),'utf8'));
    assert.ok(session);
    const response = await fetch(base + route,{headers:{...headers,'x-agent-call':'1','x-agent-session-id':session,'x-agent-token':state.agentToken}});
    assert.equal(response.status,200);
    return response.json();
  };
  return {h, settings, read};
}

for (const backend of ['native','snowluma']) {
  test(`${backend}: poke wakes, deduplicates by QQ ID, and has an independent toggle`, async () => {
    const {h,settings} = await setup({qqBackend:backend});
    try {
      await h.handlePokeNotice(poke());
      await h.handlePokeNotice(poke());
      assert.equal(h.attentionSnapshot().queue[0].count,1);
      assert.equal(h.attentionSnapshot().queue[0].reason,'poke');
      const row = h.getSocialV2State('group:456').unread[0];
      if (backend === 'native') assert.equal(row.text,undefined,'native store holds references only');
      else {
        assert.match(row.text,/QQ 戳一戳事件/);
        assert.doesNotMatch(row.text,/抱起|任意自定义/);
      }
      const saved = await settings({reminders:{poke:false}});
      assert.equal(saved.reminders.atMention,true);
      assert.equal(h.attentionSnapshot().queue.length,0);
      assert.equal(h.attentionSnapshot().unresolved.length,0);
      await h.handlePokeNotice(poke({message_id:'124'}));
      assert.equal(h.attentionSnapshot().queue.length,0);
      assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp,'config.json'),'utf8')).socialV2.reminders.poke,false);
      await settings({reminders:{poke:true,private:false}});
      await h.handlePokeNotice(poke({group_id:undefined,message_id:'125'}));
      assert.equal(h.attentionSnapshot().queue[0].key,'private:123','private poke does not depend on private-message toggle');
      h.setReady(true);
      await h.flushAttentionNow();
      assert.match(h.calls.prompts.at(-1).content[0].text,/事件：QQ 戳一戳（功能事件）/);
      assert.doesNotMatch(h.calls.prompts.at(-1).content[0].text,/任意自定义/);
    } finally { await h.close(); }
  });

  test(`${backend}: other targets, self pokes, sleep, stop and master switch cannot wake`, async () => {
    const {h,settings} = await setup({qqBackend:backend});
    try {
      for (const delta of [{target_id:'321'},{user_id:'42'},{target_id:''},{sub_type:'other'},{notice_type:'other'}]) await h.handlePokeNotice(poke(delta));
      assert.equal(h.attentionSnapshot().queue.length,0);
      for (const state of ['sleeping','stopped']) {
        h.setDesktopAgentLifecycle(state);
        await h.handlePokeNotice(poke());
        assert.equal(h.attentionSnapshot().queue.length,0);
      }
      h.setDesktopAgentLifecycle('active');
      await settings({enabled:false});
      await h.handlePokeNotice(poke());
      assert.equal(h.attentionSnapshot().queue.length,0);
    } finally { await h.close(); }
  });

  test(`${backend}: disabling one trigger preserves another pending trigger from the same conversation`, async () => {
    const {h,settings} = await setup({qqBackend:backend});
    try {
      await h.handleIncomingForTest('group',456,{self_id:'42',group_id:456,user_id:123,message_id:'111',message:[{type:'at',data:{qq:'42'}}]});
      await h.handlePokeNotice(poke());
      await settings({reminders:{poke:false}});
      assert.equal(h.attentionSnapshot().queue[0].reason,'atMention');
      assert.equal(h.attentionSnapshot().queue[0].messageId,'111');
      h.setReady(true);
      await h.flushAttentionNow();
      assert.match(h.calls.prompts.at(-1).content[0].text,/消息 id:111/);
      assert.doesNotMatch(h.calls.prompts.at(-1).content[0].text,/戳一戳/);
    } finally { await h.close(); }
  });
}

test('id-less SnowLuma poke remains readable and read acknowledgement removes pending attention', async () => {
  const {h,read} = await setup();
  try {
    await h.handlePokeNotice(poke({message_id:undefined}));
    const row = h.getSocialV2State('group:456').unread[0];
    const result = await read('/api/socialV2/message-detail?key=group:456&messageId=seq:' + row.seq);
    assert.match(result.info.text,/QQ 戳一戳事件/);
    assert.equal(h.attentionSnapshot().unresolved.length,0);
  } finally { await h.close(); }
});

test('unread follow-up toggle cancels its timer and queued retry while preserving first reminders', async () => {
  const timers = new Set();
  const {h,settings} = await setup({}, {
    setTimeout(fn,ms) { const timer = {fn,ms,unref(){}}; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  });
  try {
    await h.handlePokeNotice(poke());
    h.setReady(true);
    await h.flushAttentionNow();
    h.enterDesktopAgentRest();
    h.setDesktopAgentTurnActive(false);
    assert.equal(h.attentionSnapshot().reminderScheduled,true);
    await settings({reminders:{unreadFollowup:false}});
    assert.equal(h.attentionSnapshot().reminderScheduled,false);
    assert.equal(h.attentionSnapshot().unresolved.length,1);
    await settings({reminders:{unreadFollowup:true}});
    const timer = [...timers].find(t => t.ms === 60_000);
    assert.ok(timer);
    timers.delete(timer); timer.fn();
    assert.equal(h.attentionSnapshot().queue[0].reminder,true);
    await settings({reminders:{unreadFollowup:false}});
    assert.equal(h.attentionSnapshot().queue.length,0);
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length,1);
    await h.handlePokeNotice(poke({message_id:'126'}));
    await h.flushAttentionNow();
    assert.equal(h.calls.prompts.length,2);
    assert.match(h.calls.prompts.at(-1).content[0].text,/id:126/);
  } finally { await h.close(); }
});

test('native catchup resolves a gray-tip record as a poke and history can read it', async () => {
  const {h,read} = await setup({qqBackend:'native'});
  try {
    const event = poke({message:[{type:'text',data:{text:'[QQ 戳一戳事件] QQ 123 对 QQ 42 使用了“戳一戳”功能。'}}],
      sender:{user_id:'123'},poke:{targetId:'42',targetIsSelf:true,groupId:'456'}});
    h.bot.raw = async () => ({messages:[event]});
    await h.handleIncomingForTest('group',456,{self_id:'42',message_id:event.message_id,replay:true,message:[{type:'notice',data:{}}]});
    assert.equal(h.attentionSnapshot().queue[0].reason,'poke');
    const result = await read('/api/socialV2/unread?key=group:456');
    assert.match(result.messages[0].text,/QQ 戳一戳事件/);
    assert.equal(result.messages[0].poke.targetIsSelf,true);
    assert.equal(h.attentionSnapshot().unresolved.length,0);
  } finally { await h.close(); }
});

test('NativeQQ resolves DB gray-tip metadata using QQ history', async () => {
  const bot = new NativeQQ('.');
  bot.account = '42';
  bot.read = async () => [{message_id:'100',message:[{type:'notice'}]}];
  bot.call = async (action,params) => { assert.equal(action,'history'); assert.deepEqual(params.ids,['100']); return [poke({message_id:'100'})]; };
  try {
    const result = await bot.raw('get_group_msg_history',{group_id:'456',count:1,message_id:'100'});
    assert.equal(result.messages[0].sub_type,'poke');
  } finally { bot.close(); }
});

test('native runtime classifies QQ business 1061 independently of action text and system sender', async () => {
  let listener, socket, lines;
  let historyRows = [];
  const packets = [];
  const oldAuth = globalThis.authData;
  const server = net.createServer(peer => {
    socket = peer;
    lines = createInterface({input:peer});
    lines.on('line', line => packets.push(JSON.parse(line)));
  });
  const waitUntil = async predicate => { for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));} throw Error('native fixture timeout'); };
  try {
    globalThis.authData = {uid:'u_self',uin:'42'};
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    startNativeRuntime({getMsgService:()=>({addKernelMsgListener:value=>(listener=value,1),removeKernelMsgListener:()=>{},
      getMsgsByMsgId:async()=>({result:0,msgList:historyRows})}),
      getUixConvertService:()=>({getUin:async()=>({uinInfo:new Map([['u_friend','123']])})})},
      {pipe:{host:'127.0.0.1',port:server.address().port},token:'fixture'});
    await waitUntil(()=>packets.length===1);
    const row = (busiId, text, id='100', chatType=2) => ({chatType,peerUin:chatType===2?'456':'123',peerUid:chatType===2?'456':'u_friend',senderUin:'0',msgId:id,
      elements:[{grayTipElement:{subElementType:17,jsonGrayTipElement:{busiId,jsonStr:JSON.stringify({items:[{uid:'u_friend'},{txt:text},{uid:'u_self'}]})}}}]});
    await listener.onRecvMsg([row('1061','抱起'),row(1061,'送了一颗星星','101',1),row('999','戳一戳'),
      {chatType:2,peerUin:'456',senderUin:'123',msgId:'102',elements:[{textElement:{content:'戳一戳'}}]}]);
    await waitUntil(()=>packets.length===4);
    assert.equal(packets[1].event.sub_type,'poke');
    assert.equal(packets[1].event.sender_id,'123');
    assert.equal(packets[1].event.target_id,'42');
    assert.equal(packets[2].event.message_type,'private');
    assert.equal(packets[3].event.notice_type,undefined);
    assert.doesNotMatch(JSON.stringify(packets),/抱起|送了一颗星星/);
    const sent = row('1061','自定义动作','103',1);
    sent.elements[0].grayTipElement.jsonGrayTipElement.jsonStr = JSON.stringify({items:[{uid:'u_self'},{uid:'u_friend'}]});
    historyRows = [sent];
    socket.write(JSON.stringify({id:1,action:'history',params:{peer:{chatType:1,peerUid:'u_friend'},ids:['103']}}) + '\n');
    await waitUntil(()=>packets.some(p=>p.id===1));
    const outgoing = packets.find(p=>p.id===1).data[0];
    assert.equal(outgoing.user_id,'42','self poke stays authored by self in private history');
    assert.equal(outgoing.peer_id,'123');
  } finally {
    socket?.destroy(); lines?.close();
    await new Promise(resolve=>server.close(resolve));
    if(oldAuth===undefined)delete globalThis.authData;else globalThis.authData=oldAuth;
  }
});
