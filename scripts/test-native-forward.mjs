import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {NativeQQ} from '../src/native-qq.js';

const require = createRequire(import.meta.url);
const startRuntime = require('./ntqq-probe/runtime.cjs');
const digest = 'a'.repeat(32);
const emojiId = 'b'.repeat(32);
const origin = {chatType:2, peerUid:'123'};
const root = {msgId:'101', ...origin, senderUin:'222', elements:[{multiForwardMsgElement:{resId:'resource'}}]};
const imagePath = path.join(os.homedir(), 'Documents/Tencent Files/999/nt_qq/nt_data/Pic/2026-11/Ori', `${digest}.png`);
function picture(id = '202') {
  return {msgId:id, chatType:2, peerUid:'456', senderUin:'222', msgTime:'1',
    msgRandom:'345', msgSeq:'12', senderUid:'sender-uid', guildId:'', elements:[
    {elementType:2, elementId:'pic-1', textElement:null, marketFaceElement:null,
      picElement:{md5HexStr:digest, sourcePath:imagePath, picSubType:0, fileName:'native.png',
        fileUuid:'native-file-uuid', fileSize:'123', thumbPath:new Map([[1,'native-thumbnail']])}},
    {elementId:'face-1', marketFaceElement:{emojiId, emojiPackageId:42, faceName:'fixture'}},
  ]};
}

async function harness() {
  const previous = globalThis.authData;
  globalThis.authData = {uin:'999', uid:'self'};
  let socket, lines, listener, nextId = 0;
  const replies = new Map();
  const received = [];
  let helloResolve;
  const hello = new Promise(resolve => { helloResolve = resolve; });
  const calls = [], downloads = [], forwardDownloads = [];
  let rows = [picture(), {msgId:'201', ...origin, senderUin:'222', elements:[{multiForwardMsgElement:{resId:'nested'}}]}];
  let nestedRows = [picture('301')];
  let mode = 'normal';
  let downloadMode = 'success';
  let ordinaryRows = [];
  const svc = {
    addKernelMsgListener(value) { listener = value; return 1; },
    removeKernelMsgListener() {},
    getMsgsByMsgId: async (peer, ids) => ({result:0, msgList:peer.chatType === 2 && peer.peerUid === '123' && ids[0] === '101' ? [root] : ordinaryRows.filter(row => ids.includes(row.msgId))}),
    getMultiMsg: async (peer, rootId, parentId) => {
      calls.push({peer, rootId, parentId});
      if (mode === 'fail') return {result:1, errMsg:'fixture failure'};
      if (mode === 'empty') return {result:0, msgList:[]};
      return {result:0, msgList:parentId === '101' ? rows : nestedRows};
    },
    getRichMediaElement: async request => { downloads.push(request); return {result:0}; },
    downloadRichMedia(request) {
      forwardDownloads.push(request);
      if (downloadMode === 'throw') throw Error('fixture native download failed');
      if (downloadMode !== 'pending') setImmediate(() => completeDownload(downloadMode === 'failure'
        ? {fileErrCode:'2006021',fileSrvErrCode:'-6101',fileErrMsg:'srv_err_code=[-6101]: '}
        : {}));
      // The native API returning void only acknowledges submission.
      return undefined;
    },
  };
  const completeDownload = (info = {}) => listener.onRichMediaDownloadComplete({
    msgId:'101', msgElementId:'pic-1', fileErrCode:'0', fileSrvErrCode:'0', ...info,
  });
  const server = net.createServer(channel => {
    socket = channel;
    lines = createInterface({input:channel});
    lines.on('line', line => {
      const packet = JSON.parse(line);
      if (packet.hello) helloResolve(packet);
      else if (packet.id) replies.get(packet.id)?.(packet);
      else received.push(packet);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  startRuntime({getMsgService:() => svc}, {pipe:{host:'127.0.0.1', port:server.address().port}, token:'fixture'});
  await hello;
  return {
    calls, downloads, forwardDownloads, received, completeDownload, get listener() { return listener; },
    get rows() { return rows; },
    setMode(value) { mode = value; }, setRows(value) { rows = value; },
    setDownloadMode(value) { downloadMode = value; },
    disableOrdinaryDownload() { delete svc.getRichMediaElement; },
    setNestedRows(value) { nestedRows = value; },
    setOrdinaryRows(value) { ordinaryRows = value; },
    rpc(action, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { replies.delete(id); reject(Error('fixture timed out')); }, 2000);
        replies.set(id, packet => { clearTimeout(timer); replies.delete(id); resolve(packet); });
        socket.write(JSON.stringify({id, action, params}) + '\n');
      });
    },
    async close() {
      socket?.destroy(); lines?.close();
      await new Promise(resolve => server.close(resolve));
      if (previous === undefined) delete globalThis.authData; else globalThis.authData = previous;
    },
  };
}

await test('native forwards retain a verified root and nested read capabilities', async () => {
  const h = await harness();
  try {
    const unread = await h.rpc('history', {peer:origin, ids:['101']});
    assert.deepEqual(unread.data[0].message, [{type:'forward',data:{id:'native:101'}}]);
    const forged = await h.rpc('get_forward_msg', {peer:origin, id:'native:101:201'});
    assert.match(forged.error, /未在此来源读取/);
    assert.equal(h.calls.length, 0);
    const wrongSource = await h.rpc('get_forward_msg', {peer:{chatType:2,peerUid:'456'}, id:'native:101'});
    assert.match(wrongSource.error, /当前会话中找不到/);
    const top = await h.rpc('get_forward_msg', {peer:origin, id:'native:101'});
    assert.equal(top.data.total, 2);
    assert.deepEqual(h.calls[0], {peer:origin,rootId:'101',parentId:'101'});
    assert.deepEqual(top.data.messages[0].message[0].data, {
      file:digest, sub_type:0, nativeForwardId:'native:101',nativeMessageId:'202',
    });
    assert.equal(top.data.messages[0].message[1].data.nativeForwardId, 'native:101');
    assert.equal(top.data.messages[1].message[0].data.id, 'native:101:201');
    const nested = await h.rpc('get_forward_msg', {peer:origin,id:'native:101:201'});
    assert.equal(nested.data.messages[0].message[0].data.nativeForwardId, 'native:101:201');
    assert.deepEqual(h.calls[1], {peer:origin,rootId:'101',parentId:'201'});
    const invalid = await h.rpc('get_forward_msg', {peer:origin,id:'native:9223372036854775808'});
    assert.match(invalid.error, /定位无效/);
  } finally { await h.close(); }
});

await test('native forward media reject forged sources and use QQ node cache coordinates', async () => {
  const h = await harness();
  try {
    await h.rpc('get_forward_msg', {peer:origin,id:'native:101'});
    const p = {peer:origin,forwardId:'native:101',messageId:'202',md5:digest};
    assert.deepEqual((await h.rpc('check_forward_image', p)).data, {verified:true});
    assert.deepEqual((await h.rpc('check_forward_image', {...p,md5:'',emojiId,emojiPackageId:'42'})).data, {verified:true});
    for (const changed of [{messageId:'999'}, {md5:'c'.repeat(32)}, {peer:{chatType:2,peerUid:'456'}}, {forwardId:'native:101:999'}]) {
      assert.ok((await h.rpc('check_forward_image',{...p,...changed})).error);
    }
    assert.ok((await h.rpc('check_forward_image',{...p,md5:'c'.repeat(32),emojiId,emojiPackageId:'42'})).error,
      'a known market face must not authorize an unrelated ordinary image');
    h.disableOrdinaryDownload();
    const fetched = await h.rpc('fetch_message_image', {...p,elem:{picElement:{sourcePath:'untrusted'}},filePath:'untrusted'});
    assert.deepEqual(fetched.data,{requested:true});
    assert.equal(h.downloads.length,0,'forward nodes do not exist in the ordinary message database');
    assert.deepEqual(h.forwardDownloads[0], {
      fileModelId:'0',downSourceType:0,triggerType:0,msgId:'101',peerUid:'123',chatType:2,
      elementId:'pic-1',downloadType:1,thumbSize:0,filePath:imagePath,
    });
    assert.notEqual(h.forwardDownloads[0].msgId,p.messageId,'the root message locates the forwarded image download');
    await h.rpc('get_forward_msg',{peer:origin,id:'native:101:201'});
    assert.deepEqual((await h.rpc('fetch_message_image',{...p,forwardId:'native:101:201',messageId:'301'})).data,{requested:true});
    assert.deepEqual(h.forwardDownloads[1],h.forwardDownloads[0],'nested pictures retain the same verified outer root');
    h.setRows([{...picture(),elements:[{elementId:'pic-1',picElement:{md5HexStr:digest,sourcePath:path.join(os.tmpdir(),'not-qq.png')}}]}]);
    await h.rpc('get_forward_msg',{peer:origin,id:'native:101'});
    assert.match((await h.rpc('fetch_message_image',p)).error,/缓存位置无效/);
    assert.equal(h.forwardDownloads.length,2);
  } finally { await h.close(); }
});

await test('native converted previews use the exact message thumbnail mapping in ordinary and forwarded reads', async t => {
  const h = await harness();
  const realpath = fs.realpathSync, stat = fs.statSync;
  t.mock.method(fs, 'realpathSync', file => file === imagePath ? file : realpath(file));
  t.mock.method(fs, 'statSync', file => file === imagePath ? {isFile:() => true} : stat(file));
  try {
    const row = picture();
    row.elements[0].picElement.thumbPath = new Map([[0, imagePath]]);
    h.setRows([row]);
    h.setOrdinaryRows([row]);
    const ordinary = {peer:{chatType:2,peerUid:'456'},messageId:'202',md5:digest,quality:'preview'};
    const forward = {peer:origin,forwardId:'native:101',messageId:'202',md5:digest,quality:'preview'};
    await h.rpc('get_forward_msg',{peer:origin,id:'native:101'});
    for (const params of [ordinary,forward]) {
      assert.deepEqual((await h.rpc('fetch_message_image',{...params,verifiedPreviewPath:'untrusted'})).data,
        {requested:false,verifiedPreviewPath:imagePath});
      assert.ok((await h.rpc('fetch_message_image',{...params,md5:'c'.repeat(32)})).error);
      assert.ok((await h.rpc('fetch_message_image',{...params,messageId:'999'})).error);
      assert.ok((await h.rpc('fetch_message_image',{...params,peer:{chatType:2,peerUid:'789'}})).error);
    }
    assert.equal(h.downloads.length + h.forwardDownloads.length, 0, 'existing QQ previews do not redownload');
    row.elements[0].picElement.sourcePath = '';
    assert.deepEqual((await h.rpc('fetch_message_image',ordinary)).data, {requested:false,verifiedPreviewPath:imagePath},
      'a verified existing preview does not need an original download destination');
    row.elements[0].picElement.sourcePath = imagePath;
    assert.deepEqual((await h.rpc('fetch_message_image',{...ordinary,quality:'original'})).data, {requested:true});
    assert.deepEqual((await h.rpc('fetch_message_image',{...forward,quality:'original'})).data, {requested:true});
    assert.equal(h.downloads.length, 1);
    assert.equal(h.forwardDownloads.length, 1);
    for (const bad of [path.join(os.tmpdir(),'outside.png'), imagePath.replace('999','998'), imagePath.replace(digest,'b'.repeat(32))]) {
      row.elements[0].picElement.thumbPath.set(0,bad);
      assert.deepEqual((await h.rpc('fetch_message_image',ordinary)).data, {requested:true});
    }
    row.elements[0].picElement.thumbPath.set(0,imagePath);
    t.mock.method(fs, 'realpathSync', file => file === imagePath ? path.join(os.tmpdir(),'escape.png') : realpath(file));
    assert.deepEqual((await h.rpc('fetch_message_image',ordinary)).data, {requested:true}, 'symlink escape cannot authorize preview');
  } finally { await h.close(); }
});

await test('ordinary previews can use the exact native source and dimensions after download submission', async t => {
  const h = await harness();
  t.after(() => h.close());
  const row = picture(), pic = row.elements[0].picElement;
  const params = {peer:{chatType:2,peerUid:'456'},messageId:'202',md5:digest};
  const locator = {path:imagePath,width:1920,height:1080};
  Object.assign(pic, {picWidth:locator.width,picHeight:locator.height});
  h.setOrdinaryRows([row]);
  h.setRows([row]);
  t.mock.method(fs, 'realpathSync', file => file);
  t.mock.method(fs, 'statSync', () => ({isFile:() => true}));

  const forged = {path:path.join(os.tmpdir(),'other.png'),width:1,height:1};
  for (const quality of [undefined, 'preview']) {
    const response = await h.rpc('fetch_message_image', {...params,quality,verifiedSourcePreview:forged});
    assert.deepEqual(response.data,{requested:true,verifiedSourcePreview:locator});
  }
  assert.equal(h.downloads.length,2,'a source candidate must not suppress a normal download');
  pic.thumbPath.set(0,imagePath);
  assert.deepEqual((await h.rpc('fetch_message_image',params)).data,{requested:false,verifiedPreviewPath:imagePath});
  assert.equal(h.downloads.length,2,'the native thumbnail takes priority');
  assert.deepEqual((await h.rpc('fetch_message_image',{...params,quality:'original'})).data,{requested:true});
  pic.thumbPath.clear();
  await h.rpc('get_forward_msg',{peer:origin,id:'native:101'});
  assert.deepEqual((await h.rpc('fetch_message_image',{...params,peer:origin,forwardId:'native:101'})).data,{requested:true});
  for (const change of [{peer:origin}, {messageId:'404'}, {md5:'b'.repeat(32)}]) {
    assert.ok((await h.rpc('fetch_message_image',{...params,...change,verifiedSourcePreview:locator})).error);
  }
  assert.equal(h.downloads.length,3);
});

await test('ordinary source previews require an exact account cache file and bounded native pixel dimensions', async t => {
  const h = await harness();
  t.after(() => h.close());
  const row = picture(), pic = row.elements[0].picElement;
  const params = {peer:{chatType:2,peerUid:'456'},messageId:'202',md5:digest,quality:'preview'};
  h.setOrdinaryRows([row]);
  let real = imagePath, regularFile = true, realpathError;
  t.mock.method(fs, 'realpathSync', () => {
    if (realpathError) throw Object.assign(Error('fixture realpath error'), {code:realpathError});
    return real;
  });
  t.mock.method(fs, 'statSync', () => ({isFile:() => regularFile}));
  const checkDownloadOnly = async () => assert.deepEqual((await h.rpc('fetch_message_image',params)).data,{requested:true});
  Object.assign(pic,{picWidth:8000,picHeight:8000});
  assert.deepEqual((await h.rpc('fetch_message_image',params)).data.verifiedSourcePreview,{path:imagePath,width:8000,height:8000});
  for (const [width,height] of [[8001,8000],[32769,1],[1,32769],[0,1],[-1,1],[1,0],[1,1.5],['1',1],[undefined,1]]) {
    Object.assign(pic,{picWidth:width,picHeight:height});
    await checkDownloadOnly();
  }
  Object.assign(pic,{picWidth:1920,picHeight:1080});
  for (const subtype of [1, 42, null, undefined]) {
    pic.picSubType = subtype;
    await checkDownloadOnly();
  }
  pic.picSubType = 0;
  for (const target of [imagePath.replace('Ori','Thumb'),imagePath.replace('Pic',path.join('Emoji','emoji-recv')),
    imagePath.replace(digest,digest+'_1'),imagePath.replace(digest,'b'.repeat(32)),imagePath.replace('2026-11','2026-13')]) {
    pic.sourcePath = real = target;
    await checkDownloadOnly();
  }
  pic.sourcePath = imagePath.replace('999','998');
  assert.match((await h.rpc('fetch_message_image',params)).error,/缓存位置无效/);
  pic.sourcePath = imagePath;
  for (real of [imagePath.replace('999','998'), imagePath.replace('2026-11','2025-11')]) await checkDownloadOnly();
  real = imagePath;
  realpathError = 'EACCES';
  await checkDownloadOnly();
  realpathError = 'ENOENT';
  assert.deepEqual((await h.rpc('fetch_message_image',params)).data,{requested:true,
    verifiedSourcePreview:{path:imagePath,width:1920,height:1080}},'the reader can poll a QQ file that arrives after submission');
  pic.sourcePath = imagePath.replace('Ori','Thumb');
  await checkDownloadOnly();
  pic.sourcePath = imagePath;
  realpathError = undefined;
  regularFile = false;
  await checkDownloadOnly();

  pic.picSubType = 1;
  const stickerPath = imagePath.replace('Pic', path.join('Emoji', 'emoji-recv'));
  pic.sourcePath = real = stickerPath;
  regularFile = true;
  assert.deepEqual((await h.rpc('fetch_message_image',params)).data,{requested:true,
    verifiedSourcePreview:{path:stickerPath,width:1920,height:1080}},'custom stickers can also use converted Ori JPEGs');
  pic.sourcePath = real = stickerPath.replace('Ori','Thumb');
  await checkDownloadOnly();
});

await test('custom stickers with blank sourcePath fall back to scanning account Emoji/emoji-recv Ori cache', async t => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-stk-home-'));
  t.after(() => fs.rmSync(tmpHome, {recursive:true, force:true}));
  t.mock.method(os, 'homedir', () => tmpHome);
  const oriDir = path.join(tmpHome, 'Documents/Tencent Files/999/nt_qq/nt_data/Emoji/emoji-recv/2026-11/Ori');
  fs.mkdirSync(oriDir, {recursive:true});
  const stickerFile = path.join(oriDir, `${digest}.png`);
  fs.writeFileSync(stickerFile, Buffer.from('not-empty'));
  const h = await harness();
  t.after(() => h.close());
  const row = picture();
  Object.assign(row.elements[0].picElement, {picSubType:1, sourcePath:'', picWidth:512, picHeight:512});
  h.setOrdinaryRows([row]);
  const res = await h.rpc('fetch_message_image', {peer:{chatType:2,peerUid:'456'},messageId:'202',md5:digest,quality:'preview'});
  assert.deepEqual(res.data, {requested:true, verifiedSourcePreview:{path:fs.realpathSync(stickerFile), width:512, height:512}});
});

await test('native forward downloads match completion events and propagate server failures with retry', async () => {
  const h = await harness();
  try {
    await h.rpc('get_forward_msg',{peer:origin,id:'native:101'});
    const p = {peer:origin,forwardId:'native:101',messageId:'202',md5:digest};
    h.setDownloadMode('pending');
    let completed = false;
    const a = h.rpc('fetch_message_image',p).then(value => { completed=true; return value; });
    const b = h.rpc('fetch_message_image',p);
    while (!h.forwardDownloads.length) await new Promise(resolve => setTimeout(resolve,5));
    h.completeDownload({msgId:'202',fileErrCode:'5'});
    h.completeDownload({msgElementId:'another-picture',fileErrCode:'5'});
    await new Promise(resolve => setTimeout(resolve,20));
    assert.equal(completed,false,'unrelated download events must not complete this request');
    assert.equal(h.forwardDownloads.length,1,'simultaneous verified reads share one native download');
    h.completeDownload({fileErrCode:'2006021',fileSrvErrCode:'-6101',fileErrMsg:'srv_err_code=[-6101]: '});
    for (const response of await Promise.all([a,b])) assert.match(response.error,/QQ 转发图片下载失败.*2006021.*-6101/);
    h.setDownloadMode('success');
    assert.deepEqual((await h.rpc('fetch_message_image',p)).data,{requested:true});
    assert.equal(h.forwardDownloads.length,2,'failed native downloads are not cached');
    h.setDownloadMode('throw');
    assert.match((await h.rpc('fetch_message_image',p)).error,/fixture native download failed/);
    h.setDownloadMode('success');
    assert.deepEqual((await h.rpc('fetch_message_image',p)).data,{requested:true});
  } finally { await h.close(); }
});

await test('NativeQQ waits for validated forward image cache after a native completion', async () => {
  const h = await harness();
  const bot = new NativeQQ(process.cwd());
  let reads=0;
  bot.account='999';
  bot.call=async (action,params) => {
    const reply=await h.rpc(action,params);
    if (reply.error) throw Error(reply.error);
    return reply.data;
  };
  bot.read=async () => ++reads < 3 ? null : imagePath;
  try {
    await bot.raw('get_forward_msg',{key:'group:123',id:'native:101'});
    const result=await bot.getImage({key:'group:123',forwardId:'native:101',messageId:'202',file:digest});
    assert.deepEqual(result,{file:imagePath});
    assert.equal(reads,3,'neither void submission nor the native completion replaces cache validation');
    assert.equal(h.forwardDownloads.length,1);
  } finally { bot.close(); await h.close(); }
});

await test('NativeQQ only returns a fixed CDN fallback for a verified uncached forward market face', async () => {
  const h=await harness();
  const bot=new NativeQQ(process.cwd());
  const reads=[];
  bot.account='999';
  bot.call=async (action,params) => {
    const reply=await h.rpc(action,params);
    if (reply.error) throw Error(reply.error);
    return reply.data;
  };
  bot.read=async (action,params) => { reads.push(params); return null; };
  const params={key:'group:123',forwardId:'native:101',messageId:'202',emojiId,emojiPackageId:'42'};
  try {
    await bot.raw('get_forward_msg',{key:'group:123',id:'native:101'});
    assert.deepEqual(await bot.getImage({...params,url:'https://untrusted.invalid/image'}),{
      file:null,url:`https://gxh.vip.qq.com/club/item/parcel/item/bb/${emojiId}/raw300.gif`,
    });
    assert.equal(reads.length,1);
    await assert.rejects(bot.getImage({...params,emojiId:'c'.repeat(32)}),/找不到对应的图片/);
    await assert.rejects(bot.getImage({...params,emojiPackageId:'43'}),/找不到对应的图片/);
    await assert.rejects(bot.getImage({...params,key:'group:456'}),/尚未在此来源读取/);
    assert.equal(reads.length,1,'forged identities and sources never reach a local cache or CDN');
    assert.equal(h.forwardDownloads.length,0,'market faces never invoke ordinary forward-image downloads');
    assert.deepEqual(await bot.getImage({emojiId,emojiPackageId:'42'}),{file:null},'this fallback is scoped to verified forwards');
  } finally { bot.close(); await h.close(); }
});

await test('NativeQQ verifies both identities independently when forward media has an image and a market face', async () => {
  const h = await harness();
  const bot = new NativeQQ(process.cwd());
  const reads = [];
  bot.account = '999';
  bot.call = async (action,params) => {
    const reply = await h.rpc(action,params);
    if (reply.error) throw Error(reply.error);
    return reply.data;
  };
  bot.read = async (action, params) => { reads.push(params); return params.type === 'marketFace' ? imagePath : null; };
  try {
    await bot.raw('get_forward_msg',{key:'group:123',id:'native:101'});
    const params = {key:'group:123',forwardId:'native:101',messageId:'202',file:digest,emojiId,emojiPackageId:'42'};
    await assert.rejects(bot.getImage({...params,file:'c'.repeat(32)}),/找不到对应的图片/);
    assert.equal(reads.length,0,'wrong primary digest is rejected before accessing cache');
    await assert.rejects(bot.getImage({...params,emojiId:'d'.repeat(32)}),/找不到对应的图片/);
    assert.deepEqual(reads.map(p=>p.type),['image'],'wrong fallback identity never reaches cache');
    assert.deepEqual(await bot.getImage(params),{file:imagePath},'both separately verified identities can use the existing fallback');
  } finally { bot.close(); await h.close(); }
});

await test('native empty/failed forward downloads can be retried and all returned nested references remain readable', async () => {
  const h = await harness();
  try {
    h.setMode('empty');
    assert.match((await h.rpc('get_forward_msg',{peer:origin,id:'native:101'})).error,/未返回转发内容/);
    h.setMode('fail');
    assert.match((await h.rpc('get_forward_msg',{peer:origin,id:'native:101'})).error,/fixture failure/);
    h.setMode('normal');
    h.setRows(Array.from({length:105},(_,i)=>({msgId:String(1000+i),...origin,senderUin:'222',elements:[{multiForwardMsgElement:{resId:String(i)}}]})));
    const many = await h.rpc('get_forward_msg',{peer:origin,id:'native:101'});
    assert.equal(many.data.total,105);
    assert.equal(many.data.messages.length,100);
    assert.equal(many.data.truncated,true);
    for (let i=0;i<100;i++) {
      assert.ok((await h.rpc('get_forward_msg',{peer:origin,id:`native:101:${1000+i}`})).data);
    }
  } finally { await h.close(); }
});

await test('native forward references and media rows have separate bounded retention', async () => {
  const h = await harness();
  try {
    for (let page=0;page<11;page++) {
      h.setRows(Array.from({length:100},(_,i)=>({msgId:String(1000+100*page+i),...origin,senderUin:'222',elements:[{multiForwardMsgElement:{resId:'nested'}}]})));
      assert.ok((await h.rpc('get_forward_msg',{peer:origin,id:'native:101'})).data);
    }
    assert.match((await h.rpc('get_forward_msg',{peer:origin,id:'native:101:1000'})).error,/未在此来源读取/);
    assert.ok((await h.rpc('get_forward_msg',{peer:origin,id:'native:101:2099'})).data);

    h.setNestedRows(Array.from({length:100},(_,i)=>picture(String(3000+i))));
    for (let i=0;i<11;i++) {
      h.setRows([{msgId:String(2000+i),...origin,senderUin:'222',elements:[{multiForwardMsgElement:{resId:'nested'}}]}]);
      assert.ok((await h.rpc('get_forward_msg',{peer:origin,id:'native:101'})).data);
      assert.ok((await h.rpc('get_forward_msg',{peer:origin,id:`native:101:${2000+i}`})).data);
    }
    const media = {peer:origin,forwardId:'native:101:2000',messageId:'3000',md5:digest};
    assert.match((await h.rpc('check_forward_image',media)).error,/尚未在此来源读取/);
    assert.deepEqual((await h.rpc('check_forward_image',{...media,forwardId:'native:101:2010'})).data,{verified:true});
  } finally { await h.close(); }
});

await test('a root and five full nested previews keep every returned image usable', async () => {
  const h = await harness();
  try {
    const nested = start => Array.from({length:99},(_,i)=>({msgId:String(start+i),...origin,senderUin:'222',elements:[{multiForwardMsgElement:{resId:'nested'}}]}));
    h.setRows([picture('202'),...nested(1000)]);
    assert.ok((await h.rpc('get_forward_msg',{peer:origin,id:'native:101'})).data);
    for (let i=0;i<5;i++) {
      h.setNestedRows([picture(String(3000+i)),...nested(4000+100*i)]);
      assert.ok((await h.rpc('get_forward_msg',{peer:origin,id:`native:101:${1000+i}`})).data);
    }
    const p = {peer:origin,forwardId:'native:101',messageId:'202',md5:digest};
    assert.deepEqual((await h.rpc('check_forward_image',p)).data,{verified:true});
    for (let i=0;i<5;i++) assert.deepEqual((await h.rpc('check_forward_image',{
      ...p,forwardId:`native:101:${1000+i}`,messageId:String(3000+i),
    })).data,{verified:true});
  } finally { await h.close(); }
});

await test('NativeQQ validates cached forward images and shares in-flight forward reads', async () => {
  const bot = new NativeQQ(process.cwd());
  bot.account = '999';
  let calls = [], release;
  bot.call = async (action,p,timeout) => {
    calls.push({action,p,timeout});
    if (action === 'get_forward_msg') return new Promise(resolve => { release = resolve; });
    return {verified:true};
  };
  bot.read = async () => imagePath;
  try {
    const a=bot.raw('get_forward_msg',{key:'group:123',id:'native:101'});
    const b=bot.raw('get_forward_msg',{key:'group:123',id:'native:101'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,1);
    release({messages:[]});
    assert.deepEqual(await a,await b);
    assert.equal(bot.forwardRequests.size,0);
    const cached = await bot.getImage({key:'group:123',forwardId:'native:101',messageId:'202',file:digest});
    assert.equal(cached.file,imagePath);
    assert.equal(calls.at(-1).action,'check_forward_image');
    bot.call = async () => { throw Error('unverified node'); };
    await assert.rejects(bot.getImage({key:'group:123',forwardId:'native:101',messageId:'999',file:digest}),/unverified node/);
    bot.call = async () => { bot.account='other'; return {messages:[]}; };
    await assert.rejects(bot.raw('get_forward_msg',{key:'group:123',id:'native:101'}),/账号或连接已改变/);
  } finally { bot.close(); }
});
