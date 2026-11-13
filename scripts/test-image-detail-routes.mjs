import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import {test} from 'node:test';
import {bridgeHarness} from './audit-bridge-harness.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';
const root = 'native:7700000000000000001';
const key = 'group:456';
async function fixture(t, globals = {}) {
  const h = await bridgeHarness({config:{qqBackend:'native'}, globals});
  h.bot.account = '42'; h.bot.health = {connected:true}; h.bot.emit('open');
  h.setReady(true);
  const session = await h.ensureDesktopAgentSession();
  const token = JSON.parse(fs.readFileSync(path.join(h.temp,'state/desktop-agent.json'),'utf8')).agentToken;
  const server = h.startConsoleServer();
  if (!server.listening) await once(server,'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await h.close(); });
  const calls = [];
  h.bot.getImage = async params => {
    calls.push({...params});
    return {base64:png, representation:params.quality, width:1,height:1,
      originalWidth:1,originalHeight:1,originalAvailable:params.quality === 'original',canFetchOriginal:true};
  };
  const images = Array.from({length:6},(_,i) => ({type:'image', data:{file:String(i + 1).repeat(32),
    nativeForwardId:root,nativeMessageId:String(100 + i)}}));
  h.bot.raw = async (action) => {
    if (action === 'get_forward_msg') return {messages:images.map((image,i) => ({message_id:String(100+i), message:[image]}))};
    return {messages:[{message_id:'999',group_id:456,user_id:123,message:images.slice(0,2).map(({data,...rest}) =>
      ({...rest,data:{file:data.file}}))}]};
  };
  async function request(route, body, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${route}`, {
      method:body === undefined ? 'GET':'POST',
      headers:{'content-type':'application/json','x-console-token':'fixture-console-token',
        'x-agent-call':'1','x-agent-token':token,'x-agent-session-id':session,...headers},
      ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,...await response.json()};
  }
  return {h,calls,request};
}

test('ordinary previews expose handles; original reads only the selected image with a separate limit', async t => {
  const {h,calls,request} = await fixture(t);
  const previews = await request('images/message?key=group:456&messageId=id:999');
  assert.equal(previews.ok,true); assert.equal(previews.images.length,2);
  assert.ok(previews.images.every(image => image.representation === 'preview' && image.imageRef && image.canFetchOriginal));
  assert.ok(calls.every(call => call.quality === 'preview' && call.maxBytes === 32 * 1024 * 1024));
  calls.length = 0;
  const detail = await request('socialV2/image-detail',{key,imageRef:previews.images[1].imageRef});
  assert.equal(detail.ok,true); assert.equal(detail.images.length,1);
  assert.equal(detail.images[0].index,2);
  assert.equal(detail.images[0].representation,'original');
  assert.equal(detail.images[0].originalAvailable,true);
  assert.deepEqual(calls,[{file:'2'.repeat(32),maxBytes:32 * 1024 * 1024,quality:'original',key,messageId:'999'}]);
  assert.deepEqual(h.calls.sent,[]);
});

test('forward handles include images beyond the automatic preview batch and ignore caller media replacements', async t => {
  const {calls,request} = await fixture(t);
  const forward = await request(`socialV2/forward-message?key=${key}&id=${root}`);
  assert.equal(forward.ok,true);
  const target = forward.messages[5].media[0];
  assert.match(target.imageRef,/^qqimg:/);
  const detail = await request('socialV2/image-detail',{key,imageRef:target.imageRef,quality:'original',file:'arbitrary'});
  assert.equal(detail.ok,true);
  assert.deepEqual(calls,[{file:'6'.repeat(32),maxBytes:32 * 1024 * 1024,quality:'original',key,forwardId:root,messageId:'105'}]);
  calls.length = 0;
  const preview = await request('socialV2/forward-media',{key,media:[{...target,file:'bad',nativeMessageId:'999'}]});
  assert.equal(preview.ok,true);
  assert.equal(calls[0].file,'6'.repeat(32));
  assert.equal(calls[0].messageId,'105');
  assert.equal(calls[0].quality,'preview');
});

test('original capability matches the native pure-MD5 contract, not filename-shaped identifiers', async t => {
  const {h,calls,request} = await fixture(t);
  const files = ['a'.repeat(32), 'a'.repeat(32) + '.png'];
  h.bot.raw = async () => ({messages:files.map((file,i) => ({message_id:String(100+i),
    message:[{type:'image',data:{file,nativeForwardId:root,nativeMessageId:String(100+i)}}]}))});
  const forward = await request(`socialV2/forward-message?key=${key}&id=${root}`);
  const [valid, filename] = forward.messages.map(message => message.media[0]);
  assert.equal(valid.canFetchOriginal,true);
  assert.equal(filename.canFetchOriginal,false);
  assert.match(filename.imageRef,/^qqimg:/, 'preview references can still exist without promising an original');
  const rejected = await request('socialV2/image-detail',{key,imageRef:filename.imageRef,quality:'original'});
  assert.equal(rejected.status,400);
  assert.equal(rejected.ok,false);
  assert.deepEqual(calls,[], 'unsupported filename identifiers fail before invoking QQ');
  assert.equal((await request('socialV2/image-detail',{key,imageRef:valid.imageRef,quality:'original'})).ok,true);
  assert.equal(calls.length,1);
  assert.equal(calls[0].file,files[0]);
});

test('detail rejects unscoped, stale and cross-source handles plus invalid crops before QQ access', async t => {
  const {h,calls,request} = await fixture(t);
  const forward = await request(`socialV2/forward-message?key=${key}&id=${root}`);
  const imageRef = forward.messages[0].media[0].imageRef;
  for (const body of [{key:'group:789',imageRef},{key,imageRef:'1'.repeat(32)},
    {key,imageRef,quality:'bad'},{key,imageRef,crop:{x:0.9,y:0,width:0.2,height:1}},
    {key,imageRef,crop:{x:0,y:0,width:0,height:1}},
    {key,imageRef,quality:'preview',crop:{x:0,y:0,width:1,height:1}}]) {
    assert.ok((await request('socialV2/image-detail',body)).status >= 400);
  }
  assert.equal((await request('socialV2/image-detail',{key,imageRef},{'x-agent-token':'wrong'})).status,403);
  assert.equal((await request('socialV2/image-detail',{key,imageRef},{'x-agent-token':''})).status,403);
  h.bot.emit('close'); h.bot.emit('open');
  assert.equal((await request('socialV2/image-detail',{key,imageRef})).status,404);
  assert.deepEqual(calls,[]);
});

test('crop is applied to the verified original and returned honestly without preview normalization', async t => {
  const prepared = [];
  const {calls,request} = await fixture(t, {prepareImageDetail:async (buffer,mimeType,options) => {
    prepared.push({mimeType,crop:structuredClone(options.crop)});
    return {ok:true,buffer,mimeType,representation:'crop',width:1,height:1,originalWidth:2,originalHeight:2,note:'原图局部裁剪'};
  }});
  const forward = await request(`socialV2/forward-message?key=${key}&id=${root}`);
  const crop = {x:0.25,y:0.25,width:0.5,height:0.5};
  const result = await request('socialV2/image-detail',{key,imageRef:forward.messages[0].media[0].imageRef,crop});
  assert.equal(result.ok,true);
  assert.equal(result.images[0].representation,'crop');
  assert.equal(result.images[0].originalWidth,2);
  assert.deepEqual(prepared,[{mimeType:'image/png',crop}]);
  assert.equal(calls[0].quality,'original');
});

test('a thumbnail returned for an explicit original is never silently accepted', async t => {
  const {h,request} = await fixture(t);
  const forward = await request(`socialV2/forward-message?key=${key}&id=${root}`);
  h.bot.getImage = async () => ({base64:png,representation:'preview'});
  const result = await request('socialV2/image-detail',{key,imageRef:forward.messages[0].media[0].imageRef});
  assert.equal(result.ok,false);
  assert.ok(!result.images?.[0]?.data);
});

test('switching QQ accounts during an original read discards its result', async t => {
  const {h,request} = await fixture(t);
  const forward = await request(`socialV2/forward-message?key=${key}&id=${root}`);
  let release, announce;
  const started = new Promise(resolve => {announce=resolve;});
  h.bot.getImage = async () => {
    announce(); await new Promise(resolve => {release=resolve;});
    return {base64:png,representation:'original',originalAvailable:true};
  };
  const pending = request('socialV2/image-detail',{key,imageRef:forward.messages[0].media[0].imageRef});
  await started;
  h.bot.account='43'; h.bot.emit('open'); release();
  const result = await pending;
  assert.equal(result.ok,false);
  assert.ok(!result.images?.[0]?.data);
});

test('duplicate detail requests share conversion while distinct detail work remains bounded', async t => {
  const waiting = [];
  const {calls,request} = await fixture(t, {prepareImageDetail:async (buffer,mimeType) => {
    await new Promise(resolve => waiting.push(resolve));
    return {ok:true,buffer,mimeType,representation:'original',width:1,height:1,originalWidth:1,originalHeight:1};
  }});
  const forward = await request(`socialV2/forward-message?key=${key}&id=${root}`);
  const body = index => ({key,imageRef:forward.messages[index].media[0].imageRef});
  const waitCount = async count => {
    for (let i=0;i<100 && waiting.length<count;i++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(waiting.length,count);
  };
  const first = request('socialV2/image-detail',body(0));
  await waitCount(1);
  const duplicate = request('socialV2/image-detail',body(0));
  const second = request('socialV2/image-detail',body(1));
  await waitCount(2);
  const busy = await request('socialV2/image-detail',body(2));
  assert.equal(busy.status,429);
  waiting.forEach(release=>release());
  const results=await Promise.all([first,duplicate,second]);
  assert.ok(results.every(result=>result.ok));
  assert.equal(calls.length,2);
  assert.equal(results[0].images[0].imageRef,results[1].images[0].imageRef);
});
