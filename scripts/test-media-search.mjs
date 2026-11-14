// 图片/表情链路 + 联网搜索的离线回归。
//
// 背景（真实故障，见 2026-10-17 的会话日志）：
//   1. QQ 表情包的 CDN（gxh.vip.qq.com / p.qpic.cn / multimedia.nt.qq.com.cn）同时有
//      AAAA/A 记录，而本机只有 IPv4 出口 —— 抢到 AAAA 的那次请求会一直等到 20s 超时，
//      于是「部分表情包发不出去 / 图片时好时坏」。修复在 safe-fetch 的地址故障切换。
//   2. 表情包字段（emoji_id/url/summary）以前被丢弃，get_image 对市场表情必然失败后
//      就没有任何兜底；现在保留字段、表情优先走 CDN、并支持用 emoji_id 推 CDN 地址。
//   3. 搜索以前是抓 Bing HTML（结果空/噪声大、部分 query 直接退化）；现在优先复用
//      DSH 同一路 DeepSeek 联网搜索，Bing RSS 仅作兜底。
//
// 本文件不访问网络：CDN 下载用注入的 safeFetchBuffer 桩，搜索只测纯函数与参数校验。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { NativeQQ } from '../src/native-qq.js';
import { qqChannelConfig } from '../src/qq-channel-config.js';
import startNativeRuntime from './ntqq-probe/runtime.cjs';
import {
  bingSearch,
  clearSearchCache,
  deepseekSearch,
  loadSearchConfig,
  mapDeepSeekResponse,
  parseBingHtml,
  parseBingRss,
  readDshCredential,
  resolveSearchApiKey,
  webSearch
} from '../src/web-search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 1×1 GIF / PNG / WebP（足够通过签名与尺寸解析）
const GIF = Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
const WEBP_VP8X = (() => {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(32, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  // width-1 = 1919 (0x77f), height-1 = 1079 (0x437)，24 位小端
  buf[24] = 0x7f; buf[25] = 0x07; buf[26] = 0x00;
  buf[27] = 0x37; buf[28] = 0x04; buf[29] = 0x00;
  return buf;
})();

// ── 消息段 → 媒体元数据 ─────────────────────────────────────────────────────
await test('extractMediaFromSegments 保留表情包字段（image / mface / face）', async () => {
  const h = await bridgeHarness();
  try {
    const media = h.extractMediaFromSegments([
      {
        type: 'image',
        data: {
          file: 'f9-f96bf2d2d93c3530d5eb148f55206fb1.gif',
          url: 'https://gxh.vip.qq.com/club/item/parcel/item/f9/f96bf2d2d93c3530d5eb148f55206fb1/raw300.gif',
          summary: '[给你糖吃]',
          sub_type: 0,
          emoji_id: 'f96bf2d2d93c3530d5eb148f55206fb1',
          emoji_package_id: 242139,
          key: 'a39bbb09c7d85d41'
        }
      },
      {
        type: 'mface',
        data: { emoji_id: 'abcdef0123456789abcdef0123456789', url: 'https://gxh.vip.qq.com/x.gif', summary: '[动画表情]' }
      },
      { type: 'face', data: { id: '178', url: 'https://example.invalid/f.png', summary: 'doge' } },
      { type: 'image', data: { file: 'abcdef0123456789abcdef0123456789', sub_type: 1, summary: '[圖片表情]' } },
      { type: 'text', data: { text: '普通文字' } }
    ]);
    assert.equal(media.length, 4);
    assert.equal(media[0].kind, 'image');
    assert.equal(media[0].emojiId, 'f96bf2d2d93c3530d5eb148f55206fb1', 'emoji_id 必须保留（否则失去 CDN 兜底）');
    assert.equal(media[0].emojiPackageId, '242139');
    assert.equal(media[0].emojiKey, 'a39bbb09c7d85d41');
    assert.equal(media[0].subType, '0');
    assert.equal(media[0].summary, '[给你糖吃]');
    assert.equal(media[1].kind, 'sticker', 'mface 必须被识别为表情包');
    assert.equal(media[1].emojiId, 'abcdef0123456789abcdef0123456789');
    assert.equal(media[1].subType, '1');
    assert.equal(media[2].kind, 'face');
    assert.equal(media[2].faceId, '178');
    assert.equal(media[2].url, 'https://example.invalid/f.png');
    assert.equal(media[3].kind, 'sticker', 'QQ 图片子类型 1 必须标为图片表情');
    assert.equal(media[3].subType, '1');

    assert.equal(await h.segmentsToText([{ type: 'mface', data: { summary: '给你糖吃' } }]), '[表情:给你糖吃]');
  } finally { await h.close(); }
});

await test('原生 QQ 收到图片时默认后台预取，关闭后按需读取仍会补齐缓存', async () => {
  assert.equal(qqChannelConfig({}).media.prefetchOnReceive, true);
  assert.equal(qqChannelConfig({}, {media:{prefetchOnReceive:false}}).media.prefetchOnReceive, false);
  assert.equal(qqChannelConfig({media:{prefetchOnReceive:false}}, {send:{delayPerCharMs:25}}).media.prefetchOnReceive, false);
  assert.equal(qqChannelConfig({media:{prefetchOnReceive:false}}, {media:{prefetchOnReceive:'true'}}).media.prefetchOnReceive, false);
  const digest = crypto.createHash('md5').update(PNG).digest('hex');
  const event = {
    self_id:'42', group_id:456, user_id:123, message_id:'910000000000000001',
    sender:{user_id:123,nickname:'fixture'},
    message:[
      {type:'text',data:{text:'图片缓存测试'}},
      {type:'image',data:{file:digest,sub_type:0}},
    ],
  };
  const startNative = h => {
    h.bot.account = '42';
    h.bot.health = {connected:true};
    h.bot.read = async () => [];
    h.bot.emit('open');
  };

  const eager = await bridgeHarness({config:{qqBackend:'native'}});
  try {
    startNative(eager);
    let releaseDownload;
    const pendingDownload = new Promise(resolve => { releaseDownload = resolve; });
    const requests = [];
    eager.bot.getImage = params => { requests.push(params); return pendingDownload; };
    await eager.handleIncomingForTest('group',456,event);
    assert.equal(requests.length,1, 'message receive returns while the cache download is still pending');
    assert.equal(requests[0].key,'group:456');
    assert.equal(requests[0].messageId,event.message_id);
    assert.equal(requests[0].maxBytes,8 * 1024 * 1024, 'prefetch uses the same limit as an explicit image read');
    await eager.handleIncomingForTest('group',456,event);
    assert.equal(requests.length,1, 'duplicate events share the running cache check');
    assert.equal(eager.calls.prompts.length,0, 'prefetch does not start a model turn');
    releaseDownload({base64:PNG.toString('base64')});
    await new Promise(resolve => setTimeout(resolve,0));
  } finally { await eager.close(); }

  const lazy = await bridgeHarness({config:{qqBackend:'native',socialV2:{media:{prefetchOnReceive:false}}}});
  try {
    startNative(lazy);
    const requests = [];
    lazy.bot.getImage = async params => { requests.push(params); return {base64:PNG.toString('base64')}; };
    await lazy.handleIncomingForTest('group',456,event);
    assert.equal(requests.length,0, 'disabled mode does not fetch on message receive');
    const image = await lazy.fetchOneBotImage({kind:'image',file:digest},{key:'group:456',messageId:event.message_id});
    assert.deepEqual(image.buffer,PNG);
    assert.equal(requests.length,1, 'an explicit image read still checks and fills the cache');
    assert.equal(requests[0].key,'group:456');
    assert.equal(requests[0].messageId,event.message_id);
    assert.equal(requests[0].maxBytes,8 * 1024 * 1024);
  } finally { await lazy.close(); }
});

await test('预取有并发和每条上限，关闭立即丢弃排队任务，重新开启无需重启', async () => {
  const h = await bridgeHarness({config:{qqBackend:'native',socialV2:{media:{maxCount:3}}}});
  let server;
  const requests = [], releases = [];
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const incoming = (id, count = 1, extras = {}) => h.handleIncomingForTest('group',456,{
    self_id:'42', group_id:456, user_id:123, message_id:String(id), ...extras,
    message:Array.from({length:count}, (_, n) => ({type:'image',data:{file:(n + 1).toString(16).padStart(32,'0')}})),
  });
  try {
    h.bot.account = '42'; h.bot.health = {connected:true}; h.bot.read = async () => [];
    h.bot.emit('open');
    h.bot.getImage = params => { requests.push(params); return new Promise(resolve => releases.push(resolve)); };
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening',resolve));
    const setEnabled = async enabled => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/config`, {
        method:'POST', headers:{'content-type':'application/json','x-console-token':'fixture-console-token'},
        body:JSON.stringify({media:{prefetchOnReceive:enabled}}),
      });
      assert.equal(response.status,200);
      assert.equal((await response.json()).config.media.prefetchOnReceive,enabled);
    };
    await incoming(1,5);
    assert.equal(requests.length,2,'at most two concurrent cache checks');
    releases.shift()({file:'cached'}); await settle();
    assert.equal(requests.length,3);
    while (releases.length) releases.shift()({file:'cached'});
    await settle();
    assert.equal(requests.length,3,'the remaining pictures beyond the per-message limit stay on demand');
    await incoming(2,3);
    assert.equal(requests.length,5);
    await setEnabled(false);
    while (releases.length) releases.shift()({file:'cached'});
    await settle();
    await incoming(3);
    assert.equal(requests.length,5,'disabled setting removes queued work and skips later messages');
    await setEnabled(true);
    await incoming(4,1,{replay:true});
    await incoming(5,1,{self_id:'43'});
    assert.equal(requests.length,5,'replayed messages and another account cannot trigger prefetch');
    await incoming(6,3);
    assert.equal(requests.length,7,'the setting takes effect on the next message');
    h.bot.emit('close');
    h.bot.account = '43'; h.bot.emit('open');
    while (releases.length) releases.shift()({file:'cached'});
    await settle();
    assert.equal(requests.length,7,'queued images are discarded on disconnect/account change');
  } finally {
    h.bot.emit('close');
    while (releases.length) releases.shift()({file:'cached'});
    await settle();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});

await test('预取等待账号缓存读取器就绪，队列有界且单图失败不会阻塞后续任务', async () => {
  const h = await bridgeHarness({config:{qqBackend:'native'}});
  let requests = 0;
  try {
    h.bot.account = '42'; h.bot.health = {connected:true}; h.bot.emit('open');
    h.bot.getImage = async () => { if (++requests === 1) throw Error('cache miss fixture'); return {file:'cached'}; };
    for (let id = 1; id <= 105; id++) {
      await h.handleIncomingForTest('group',456, {
        self_id:'42', user_id:123, message_id:String(id),
        message:[{type:'image',data:{file:'c'.repeat(32)}}],
      });
    }
    assert.equal(requests,0,'cache reader startup must not turn incoming images into failed jobs');
    h.bot.read = async () => ({events:[],next:null});
    h.bot.emit('reader-ready');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests,100,'the queue stays bounded and keeps draining after a failed image');
    assert.equal(h.calls.prompts.length,0);
  } finally { h.bot.emit('close'); await h.close(); }
});

await test('原生图片读取带上原消息定位，只读取当前账号的 QQ 缓存', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-image-path-'));
  const digest = crypto.createHash('md5').update(PNG).digest('hex');
  const target = path.join(dir, 'Documents', 'Tencent Files', '999', 'nt_qq', 'nt_data', 'Pic', digest + '.png');
  const outside = path.join(dir, 'outside.png');
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, PNG);
  fs.writeFileSync(outside, PNG);
  const h = await bridgeHarness({config:{qqBackend:'native', socialV2:{media:{maxBytes:512 * 1024}}},
    globals:{os:{...os, homedir:() => dir}}});
  try {
    h.bot.account = '999';
    h.bot.emit('open');
    let received;
    h.bot.getImage = async params => { received = params; return {file:target}; };
    const found = await h.fetchOneBotImage({kind:'image', file:digest}, {key:'private:123', messageId:'456'});
    assert.deepEqual(found.buffer, PNG);
    assert.equal(received.key, 'private:123');
    assert.equal(received.messageId, '456');
    assert.equal(received.maxBytes, 512 * 1024, 'native cache selection must use the configured byte limit');
    h.bot.getImage = async () => ({file:outside});
    assert.equal(await h.fetchOneBotImage({kind:'image', file:digest}), null);
  } finally {
    await h.close();
    fs.rmSync(dir, {recursive:true, force:true});
  }
});

await test('QQ 转换预览对实际字节强制解码，关闭归一化也不能绕过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-converted-image-'));
  const digest = 'a'.repeat(32);
  const target = path.join(dir, 'Documents/Tencent Files/999/nt_qq/nt_data/Pic/2026-11/Ori', digest + '.png');
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, PNG);
  let decodeOk = false, calls = 0, swapAccount = false;
  const h = await bridgeHarness({config:{qqBackend:'native',socialV2:{media:{normalize:false}}},
    globals:{os:{...os,homedir:() => dir},validateImageDecode:async bytes => {
      calls++;
      assert.deepEqual(bytes, PNG, 'decode the bytes actually read, not the declared filename or digest');
      if (swapAccount) h.bot.account = '998';
      return {ok:decodeOk};
    }}});
  try {
    h.bot.account = '999'; h.bot.emit('open');
    h.bot.getImage = async () => ({file:target,representation:'preview',originalAvailable:false,
      originalUnavailableReason:'invalid_cache',width:1,height:1,requiresDecode:true});
    const params = {key:'private:123',messageId:'456',quality:'preview'};
    assert.equal(await h.fetchOneBotImage({kind:'image',file:digest},params), null);
    decodeOk = true;
    const result = await h.fetchOneBotImage({kind:'image',file:digest},params);
    assert.deepEqual(result.buffer, PNG);
    assert.equal(result.representation, 'preview');
    assert.equal(result.originalAvailable, false);
    assert.equal(result.requiresDecode, undefined, 'internal validation flags do not leak to model output');
    swapAccount = true;
    assert.equal(await h.fetchOneBotImage({kind:'image',file:digest},params), null);
    assert.equal(calls, 3);
  } finally {
    await h.close();
    fs.rmSync(dir, {recursive:true,force:true});
  }
});

await test('NativeQQ 缓存未命中时按原消息请求 QQ 下载并重新读取缓存', async () => {
  const bot = new NativeQQ(ROOT);
  const digest = 'abcdef0123456789abcdef0123456789';
  const cachedPath = 'C:\\QQ\\nt_data\\Pic\\2026-11\\Ori\\' + digest + '.png';
  const reads = [];
  const calls = [];
  let available = null;
  bot.read = async (action, params) => {
    reads.push({action, params});
    return reads.length < 3 ? null : available;
  };
  bot.uid = async (uin) => `uid-${uin}`;
  bot.call = async (...args) => {
    calls.push(args);
    available = cachedPath;
    return {requested:true};
  };
  try {
    const result = await bot.getImage({file:digest, key:'private:123', messageId:'456'});
    assert.deepEqual(result, {file:cachedPath});
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'fetch_message_image');
    assert.deepEqual(calls[0][1], {
      peer:{chatType:1, peerUid:'uid-123'}, messageId:'456', md5:digest,
    });
    assert.equal(calls[0][2], 30000, '下载 RPC 使用独立的媒体超时');
    assert.equal(reads.length, 3, '请求接受后继续等待有效缓存，不能提前返回成功');
    assert.ok(reads.every(read => JSON.stringify(read.params) === JSON.stringify({type:'image',md5:digest})),
      'omitting maxBytes retains the original media request contract');
  } finally { bot.close(); }
});

await test('NativeQQ 把大小上限传给首次缓存查询、下载后查询及商城预览回退', async () => {
  const bot = new NativeQQ(ROOT), reads = [], calls = [];
  const digest = 'a'.repeat(32), maxBytes = 1024;
  let available = null;
  bot.read = async (action, params) => { reads.push({action,params}); return available; };
  bot.call = async (action, params) => { calls.push({action,params}); available = 'small-thumbnail.png'; };
  try {
    assert.deepEqual(await bot.getImage({file:digest, key:'group:456', messageId:'123', maxBytes}),
      {file:'small-thumbnail.png'});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'fetch_message_image');
    assert.deepEqual(reads, [1,2].map(() => ({action:'media',params:{type:'image',md5:digest,maxBytes}})));
    reads.length = calls.length = 0;
    bot.read = async (action, params) => {
      reads.push({action,params}); return params.type === 'marketFace' ? 'small-market-preview.png' : null;
    };
    assert.deepEqual(await bot.getImage({file:digest, emojiId:'b'.repeat(32), emojiPackageId:'42', maxBytes}),
      {file:'small-market-preview.png'});
    assert.deepEqual(reads, [
      {action:'media',params:{type:'image',md5:digest,maxBytes}},
      {action:'media',params:{type:'marketFace',emojiId:'b'.repeat(32),packageId:'42',maxBytes}},
    ]);
    assert.equal(calls.length, 0);
  } finally { bot.close(); }
});

await test('NativeQQ 所有缓存超限时明确失败而不重复下载', async () => {
  const bot = new NativeQQ(ROOT);
  let downloads = 0, reads = 0;
  bot.read = async () => { reads++; throw Error('QQ 本地图片缓存均超过读取大小上限，未重复下载'); };
  bot.call = async () => { downloads++; };
  try {
    for (let i = 0; i < 2; i++) {
      await assert.rejects(bot.getImage({file:'a'.repeat(32),key:'group:456',messageId:'123',maxBytes:1024}),
        /缓存均超过读取大小上限/);
    }
    assert.equal(reads, 2);
    assert.equal(downloads, 0);
    assert.equal(bot.imageRequests.size, 0);
  } finally { bot.close(); }
});

await test('NativeQQ 只合并相同大小上限的并发请求，非法上限不能复用不限大小请求', async () => {
  const bot = new NativeQQ(ROOT), reads = [];
  const params = {file:'a'.repeat(32)};
  bot.call = async () => { throw Error('cache hit must not download'); };
  bot.read = (action, query) => new Promise(resolve => { reads.push({action,query,resolve}); });
  try {
    const unlimited = bot.getImage(params);
    const small = bot.getImage({...params,maxBytes:64});
    const larger = bot.getImage({...params,maxBytes:128});
    assert.equal(bot.getImage({...params,maxBytes:64}), small);
    assert.notEqual(small, larger);
    assert.notEqual(small, unlimited);
    assert.equal(reads.length, 3);
    for (const maxBytes of [null, true, 0, -1, 1.5, '1024', NaN, Infinity, 20 * 1024 * 1024 + 1]) {
      await assert.rejects(bot.getImage({...params,maxBytes}), /maxBytes/);
      await assert.rejects(bot.raw('get_image', {...params,maxBytes}), /maxBytes/);
    }
    assert.equal(reads.length, 3, 'invalid limits must fail before cache access');
    for (const read of reads) read.resolve(`${read.query.maxBytes ?? 'original'}.png`);
    assert.deepEqual(await Promise.all([unlimited,small,larger]),
      [{file:'original.png'},{file:'64.png'},{file:'128.png'}]);
    assert.equal(bot.imageRequests.size, 0);
    bot.read = async () => 'bounded.png';
    for (const maxBytes of [1, 20 * 1024 * 1024]) {
      assert.deepEqual(await bot.getImage({...params,maxBytes}), {file:'bounded.png'});
    }
  } finally { for (const read of reads) read.resolve(null); bot.close(); }
});

await test('NativeQQ 预取与角色看同一张图共用下载，失败后仍可重试', async () => {
  const bot = new NativeQQ(ROOT);
  const params = {file:'a'.repeat(32),key:'group:456',messageId:'123',maxBytes:8 * 1024 * 1024};
  let attempts = 0, release, cache = null;
  bot.read = async () => cache;
  bot.call = async () => { attempts++; await new Promise(resolve => { release = resolve; }); cache = 'cached.png'; };
  try {
    const prefetch = bot.getImage(params), requested = bot.getImage(params);
    assert.equal(prefetch,requested);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts,1);
    release();
    assert.deepEqual(await requested,{file:'cached.png'});
    assert.deepEqual(await bot.getImage(params),{file:'cached.png'});
    assert.equal(attempts,1,'a completed cache hit never downloads again');
    cache = null;
    bot.call = async () => { throw Error('download failed'); };
    await assert.rejects(bot.getImage(params), /download failed/);
    cache = 'cached-after-retry.png';
    assert.deepEqual(await bot.getImage(params),{file:cache});
    assert.equal(bot.imageRequests.size,0);
  } finally { bot.close(); }
});

await test('NativeQQ 图片读取遇到账号切换不继续下载或返回旧账号结果', async () => {
  const bot = new NativeQQ(ROOT);
  let release, downloads = 0;
  const params = {file:'b'.repeat(32),key:'group:456',messageId:'123'};
  bot.account = '42';
  bot.read = () => new Promise(resolve => { release = resolve; });
  bot.call = async () => { downloads++; };
  try {
    const pending = bot.getImage(params);
    bot.account = '43';
    release('old-account.png');
    await assert.rejects(pending, /账号或连接已改变/);
    assert.equal(downloads,0);
    bot.read = async () => null;
    bot.call = async () => { downloads++; bot.account = '44'; };
    await assert.rejects(bot.getImage(params), /账号或连接已改变/);
    assert.equal(downloads,1,'a submitted download is never resumed against a different account');
  } finally { bot.close(); }
});

await test('NTQQ runtime 只请求原消息内匹配的图片并限制 QQ 缓存目标路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntqq-runtime-media-'));
  const digest = crypto.createHash('md5').update(PNG).digest('hex');
  const filePath = path.join(os.homedir(), 'Documents', 'Tencent Files', '999', 'nt_qq', 'nt_data', 'Pic', '2026-11', 'Ori', digest + '.png');
  const row = {
    msgId:'456', chatType:1, peerUid:'uid-123',
    elements:[{elementId:'element-7', picElement:{md5HexStr:digest, fileName:'original.png', picSubType:0, sourcePath:filePath, fileSize:String(PNG.length)}}],
  };
  let downloadRequest;
  const service = {
    getMsgsByMsgId: async (peer, ids) => ({result:0, msgList:peer.chatType === 1 && peer.peerUid === 'uid-123' && ids[0] === '456' ? [row] : []}),
    getRichMediaElement: async (request) => { downloadRequest = request; return {result:0}; },
    addKernelMsgListener: () => 1,
    removeKernelMsgListener: () => {},
  };
  const previousAuth = globalThis.authData;
  let server, channel, lines, queue = [], waiter = null;
  const nextPacket = () => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    const timer = setTimeout(() => { waiter = null; reject(new Error('NTQQ runtime test timed out')); }, 5000);
    waiter = packet => { clearTimeout(timer); resolve(packet); };
  });
  try {
    globalThis.authData = {uid:'self-uid', uin:'999'};
    server = net.createServer(socket => {
      channel = socket;
      lines = createInterface({input:socket});
      lines.on('line', line => {
        const packet = JSON.parse(line);
        if (waiter) { const take = waiter; waiter = null; take(packet); }
        else queue.push(packet);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    startNativeRuntime({getMsgService:() => service}, {pipe:{host:'127.0.0.1', port:address.port}, token:'fixture'});
    const hello = await nextPacket();
    assert.equal(hello.hello, 'fixture');
    const response = nextPacket();
    channel.write(JSON.stringify({id:1, action:'fetch_message_image', params:{
      peer:{chatType:1, peerUid:'uid-123'}, messageId:'456', md5:digest,
    }}) + '\n');
    assert.deepEqual(await response, {id:1, data:{requested:true}});
    assert.deepEqual(downloadRequest, {
      msgId:'456', peerUid:'uid-123', chatType:1, elementId:'element-7', downSourceType:1, downloadType:1, thumbSize:0, filePath,
    });
    downloadRequest = null;
    const wrongDigest = nextPacket();
    channel.write(JSON.stringify({id:2, action:'fetch_message_image', params:{
      peer:{chatType:1, peerUid:'uid-123'}, messageId:'456', md5:'0'.repeat(32),
    }}) + '\n');
    assert.match((await wrongDigest).error, /找不到对应的图片/);
    assert.equal(downloadRequest, null, '不匹配原消息的图片不得触发下载');
    row.elements[0].picElement.sourcePath = path.join(os.tmpdir(), 'outside-qq-cache.png');
    const unsafePath = nextPacket();
    channel.write(JSON.stringify({id:3, action:'fetch_message_image', params:{
      peer:{chatType:1, peerUid:'uid-123'}, messageId:'456', md5:digest,
    }}) + '\n');
    assert.match((await unsafePath).error, /缓存位置无效/);
    assert.equal(downloadRequest, null, '越界路径不得交给 QQ 写入');
  } finally {
    channel?.destroy();
    lines?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (previousAuth === undefined) delete globalThis.authData; else globalThis.authData = previousAuth;
    fs.rmSync(dir, {recursive:true, force:true});
  }
});

await test('NativeQQ 商城表情优先读预览缓存，未命中时允许 CDN 回退', async () => {
  const bot = new NativeQQ(ROOT);
  let available = null;
  let calls = 0;
  bot.read = async () => available;
  bot.call = async () => { calls++; throw Error('商城表情不应调用普通图片下载'); };
  try {
    const params = {emojiId:'abcdef0123456789abcdef0123456789', emojiPackageId:'42', key:'private:123', messageId:'456'};
    assert.deepEqual(await bot.getImage(params), {file:null});
    available = 'cached-preview.png';
    assert.deepEqual(await bot.getImage(params), {file:available});
    assert.equal(calls, 0);
  } finally { bot.close(); }
});

// ── 表情包下载：CDN 优先、emoji_id 兜底、普通图片仍走 get_image ──────────────
await test('fetchOneBotImage 表情优先 CDN，普通图片优先 get_image', async () => {
  const fetched = [];
  const h = await bridgeHarness({
    globals: {
      safeFetchBuffer: async (url) => { fetched.push(String(url)); return { buffer: GIF, mimeType: 'image/gif' }; }
    }
  });
  try {
    // ① 表情（有 url）：不调用 get_image，直接抓 CDN
    const sticker = await h.fetchOneBotImage({
      kind: 'sticker',
      url: 'https://gxh.vip.qq.com/club/item/parcel/item/f9/f96bf2d2d93c3530d5eb148f55206fb1/raw300.gif'
    });
    assert.ok(sticker?.buffer?.length, '表情必须取到字节');
    assert.equal(sticker.mimeType, 'image/gif');
    assert.equal(fetched.at(-1), 'https://gxh.vip.qq.com/club/item/parcel/item/f9/f96bf2d2d93c3530d5eb148f55206fb1/raw300.gif');
    assert.equal(h.calls.images.length, 0, '表情有 URL 时不应先问网关 get_image（市场表情必然 not found）');

    // ② 表情（没有 url，只有 emoji_id）：按 emoji_id 推 CDN 地址兜底
    const byId = await h.fetchOneBotImage({
      kind: 'image',
      subType: '0',
      emojiId: 'f96bf2d2d93c3530d5eb148f55206fb1',
      file: 'f9-f96bf2d2d93c3530d5eb148f55206fb1.gif'
    });
    assert.ok(byId?.buffer?.length, '只有 emoji_id 时也要能取到');
    assert.equal(
      fetched.at(-1),
      'https://gxh.vip.qq.com/club/item/parcel/item/f9/f96bf2d2d93c3530d5eb148f55206fb1/raw300.gif',
      '必须按 emoji_id 推出 CDN 地址'
    );

    // ②b 连 emoji_id 都没有、只有文件名：从 `<前两位>-<32 位 hex>.gif` 还原
    const byFile = await h.fetchOneBotImage({
      kind: 'image',
      subType: '0',
      file: 'f9-f96bf2d2d93c3530d5eb148f55206fb1.gif'
    });
    assert.ok(byFile?.buffer?.length, '只有文件名时也要能推出 CDN 地址');
    assert.equal(
      fetched.at(-1),
      'https://gxh.vip.qq.com/club/item/parcel/item/f9/f96bf2d2d93c3530d5eb148f55206fb1/raw300.gif',
      '必须能从文件名还原 emoji_id'
    );

    // ③ 普通图片（有 file）：get_image 优先，不走 CDN
    const before = fetched.length;
    const getImage = h.bot.getImage.bind(h.bot);
    h.bot.getImage = params => {
      assert.deepEqual({...params}, {file:'abc.jpg'}, 'SnowLuma keeps its original get_image parameters');
      return getImage(params);
    };
    const image = await h.fetchOneBotImage({ kind: 'image', file: 'abc.jpg' });
    assert.ok(image?.buffer?.length);
    assert.deepEqual(h.calls.images, ['abc.jpg']);
    assert.equal(fetched.length, before, '普通图片不应额外抓 URL');
  } finally { await h.close(); }
});

await test('emojiCdnCandidates 只接受十六进制 id（防任意 URL 拼接）', async () => {
  const h = await bridgeHarness();
  try {
    const valid = h.emojiCdnCandidates('f96bf2d2d93c3530d5eb148f55206fb1');
    assert.equal(valid.length, 1);
    assert.equal(valid[0], 'https://gxh.vip.qq.com/club/item/parcel/item/f9/f96bf2d2d93c3530d5eb148f55206fb1/raw300.gif');
    for (const bad of ['', 'abc', '../../etc/passwd', 'f96bf2d2d93c3530d5eb148f55206fb1/../../x', '中文', null]) {
      assert.equal(h.emojiCdnCandidates(bad).length, 0, `非法 emoji_id 不得拼 URL：${bad}`);
    }
  } finally { await h.close(); }
});

await test('fetchMediaData 标注表情/图片，并保留 summary 与 emojiId', async () => {
  const h = await bridgeHarness({
    globals: {
      safeFetchBuffer: async (url) => {
        if (String(url).includes('gxh.vip.qq.com')) return { buffer: GIF, mimeType: 'image/gif' };
        throw new Error('网络不可用');
      }
    }
  });
  try {
    const out = await h.fetchMediaData([
      { kind: 'sticker', emojiId: 'f96bf2d2d93c3530d5eb148f55206fb1', summary: '[给你糖吃]' }
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'sticker');
    assert.equal(out[0].summary, '[给你糖吃]');
    assert.equal(out[0].emojiId, 'f96bf2d2d93c3530d5eb148f55206fb1');
    assert.ok(out[0].data?.length, '应带 base64 图片数据');
    assert.equal(out[0].text, '');

    h.bot.getImage = async () => { throw new Error('image not found in cache'); };
    const failed = await h.fetchMediaData([{ kind: 'image', file: 'abc.jpg', url: 'https://multimedia.nt.qq.com.cn/x' }]);
    assert.equal(failed[0].kind, 'image');
    assert.match(String(failed[0].text), /图片获取失败/, '失败必须明确标注为图片');

    const imageSticker = await h.fetchMediaData([{
      kind:'image', file:'abcdef0123456789abcdef0123456789', subType:'1', url:'https://gxh.vip.qq.com/fixture.gif'
    }]);
    assert.equal(imageSticker[0].kind, 'sticker', 'subType=1 应作为表情输出');
    assert.ok(imageSticker[0].data, '图片表情应沿用图片读取链路');
  } finally { await h.close(); }
});

await test('getImageDimensions / acceptImageBuffer 覆盖 GIF 与 WebP，并拦截非图片', async () => {
  const h = await bridgeHarness();
  try {
    const gif = h.getImageDimensions(GIF);
    assert.equal(gif?.width, 1);
    assert.equal(gif?.height, 1);
    const webp = h.getImageDimensions(WEBP_VP8X);
    assert.equal(webp?.width, 1920);
    assert.equal(webp?.height, 1080);
    assert.ok(h.acceptImageBuffer(GIF, 'gif'), 'GIF 必须通过');
    assert.ok(h.acceptImageBuffer(WEBP_VP8X, 'webp'), 'WebP 必须通过');
    assert.equal(h.acceptImageBuffer(Buffer.from('not an image at all')), null, '非图片必须拒绝');
  } finally { await h.close(); }
});

// ── 搜索：配置 / 凭据 / 结果映射 / 解析 ─────────────────────────────────────
await test('loadSearchConfig 默认值与越界收敛', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-search-cfg-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      webSearch: { provider: 'bing', maxResults: 99, maxUses: 9, timeoutMs: 1, apiKeyEnv: ' MY_KEY ' }
    }));
    const cfg = loadSearchConfig(dir);
    assert.equal(cfg.provider, 'bing');
    assert.equal(cfg.maxResults, 20, 'maxResults 上限 20');
    assert.equal(cfg.maxUses, 5, 'maxUses 上限 5');
    assert.equal(cfg.timeoutMs, 5000, 'timeoutMs 下限 5s');
    assert.equal(cfg.apiKeyEnv, 'MY_KEY');
    assert.equal(cfg.model, 'deepseek-v4-flash');

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webSearch: { provider: 'nonsense' } }));
    assert.equal(loadSearchConfig(dir).provider, 'auto', '未知 provider 回退 auto');
    fs.writeFileSync(path.join(dir, 'config.json'), '{broken json');
    assert.equal(loadSearchConfig(dir).provider, 'auto', '坏配置不得让搜索崩溃');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('resolveSearchApiKey 的优先级：config > env > DSH 凭据', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-home-'));
  const oldHome = process.env.DSH_HOME;
  const oldKey = process.env.QQ_TEST_SEARCH_KEY;
  try {
    fs.writeFileSync(path.join(home, '.credentials.yaml'), [
      'version: 1',
      'refs:',
      '  QQ_TEST_SEARCH_KEY: sk-from-dsh-credentials',
      'records: {}',
      ''
    ].join('\n'));
    process.env.DSH_HOME = home;
    delete process.env.QQ_TEST_SEARCH_KEY;

    assert.equal(resolveSearchApiKey({ apiKeyEnv: 'QQ_TEST_SEARCH_KEY' }).source, 'dsh-credentials');
    assert.equal(readDshCredential('QQ_TEST_SEARCH_KEY'), 'sk-from-dsh-credentials');

    process.env.QQ_TEST_SEARCH_KEY = 'sk-from-env';
    assert.deepEqual(resolveSearchApiKey({ apiKeyEnv: 'QQ_TEST_SEARCH_KEY' }), { key: 'sk-from-env', source: 'env' });

    assert.deepEqual(
      resolveSearchApiKey({ apiKey: 'sk-from-config', apiKeyEnv: 'QQ_TEST_SEARCH_KEY' }),
      { key: 'sk-from-config', source: 'config' }
    );

    delete process.env.QQ_TEST_SEARCH_KEY;
    fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\nrefs: {}\nrecords: {}\n');
    assert.equal(resolveSearchApiKey({ apiKeyEnv: 'QQ_TEST_SEARCH_KEY' }).source, 'none');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldKey === undefined) delete process.env.QQ_TEST_SEARCH_KEY; else process.env.QQ_TEST_SEARCH_KEY = oldKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test('mapDeepSeekResponse：去重、去 #N 锚点、引用摘要', async () => {
  const response = {
    content: [
      { type: 'thinking', thinking: '...' },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', title: '鲸鱼娘', url: 'https://example.com/a#1', page_age: '2026-10-01' },
          { type: 'web_search_result', title: '重复', url: 'https://example.com/a#2' },
          { type: 'web_search_result', title: '鲸鱼娘（二）', url: 'https://example.com/b' }
        ]
      },
      { type: 'text', text: '答案', citations: [{ url: 'https://example.com/b', cited_text: '这是引用片段' }] }
    ]
  };
  const results = mapDeepSeekResponse(response, 8);
  assert.equal(results.length, 2, '同一 URL 必须去重');
  assert.equal(results[0].url, 'https://example.com/a', '必须去掉 #1 锚点');
  assert.equal(results[0].publishedAt, '2026-10-01');
  assert.equal(results[1].snippet, '这是引用片段');
  assert.throws(() => mapDeepSeekResponse({ content: [{ type: 'text', text: '没有结果块' }] }), /web_search_tool_result/);
});

await test('Bing RSS / HTML 解析：CDATA、实体、去重、上限', async () => {
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[第一条 & 摘要]]></title><link>https://example.com/1</link><description><![CDATA[<b>加粗</b> 内容 &#x4e2d;]]></description></item>
    <item><title>第二条</title><link>https://example.com/2</link><description>&amp; 转义</description></item>
    <item><title>重复</title><link>https://example.com/1</link></item>
  </channel></rss>`;
  const fromRss = parseBingRss(rss, 8);
  assert.equal(fromRss.length, 2);
  assert.equal(fromRss[0].title, '第一条 & 摘要');
  assert.equal(fromRss[0].snippet, '加粗 内容 中');
  assert.equal(fromRss[1].snippet, '& 转义');

  const html = `<li class="b_algo"><h2><a href="https://example.com/x">X 标题</a></h2><p>X 摘要</p></li>
    <li class="b_algo"><h2><a href="https://example.com/x">重复</a></h2><p>dup</p></li>
    <li class="b_algo"><h2><a href="https://example.com/y">Y</a></h2><p>Y 摘要</p></li>`;
  const fromHtml = parseBingHtml(html, 8);
  assert.equal(fromHtml.length, 2);
  assert.equal(fromHtml[0].url, 'https://example.com/x');
  assert.equal(parseBingRss(rss, 1).length, 1, 'maxResults 必须生效');
});

await test('deepseekSearch：没有 key 时报 NO_KEY；非 https 端点直接拒绝', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-home2-'));
  const oldHome = process.env.DSH_HOME;
  const oldKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DSH_HOME = home;
    delete process.env.DEEPSEEK_API_KEY;
    const noKey = await deepseekSearch('测试', { provider: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' }).catch((e) => e);
    assert.equal(noKey?.code, 'NO_KEY');

    const insecure = await deepseekSearch('测试', {
      provider: 'deepseek',
      apiKey: 'sk-test-only-for-unit-test',
      baseURL: 'http://api.deepseek.com/anthropic/v1'
    }).catch((e) => e);
    assert.match(String(insecure?.message), /https/, 'API key 不允许发往 http 端点');

    const privateHost = await deepseekSearch('测试', {
      provider: 'deepseek',
      apiKey: 'sk-test-only-for-unit-test',
      baseURL: 'https://127.0.0.1/anthropic/v1'
    }).catch((e) => e);
    assert.match(String(privateHost?.message), /内网|本机|禁止/, 'API key 不允许发往内网/本机端点');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test('webSearch：provider=deepseek 且无 key 时不静默回退（明确报错）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-home3-'));
  const oldHome = process.env.DSH_HOME;
  const oldKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DSH_HOME = home;
    delete process.env.DEEPSEEK_API_KEY;
    clearSearchCache();
    const error = await webSearch('测试', {
      root: ROOT,
      provider: 'deepseek',
      config: { provider: 'deepseek', apiKey: '', apiKeyEnv: 'DEEPSEEK_API_KEY' }
    }).catch((e) => e);
    assert.equal(error?.code, 'NO_KEY', '显式指定 deepseek 时不能悄悄回退 Bing');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test('safe-fetch：多地址时按 IPv4 优先并在失败后切换', async () => {
  // 直接验证纯函数（不联网）：一个 IPv6 在前、IPv4 在后的应答，必须排出 IPv4 优先的顺序。
  const { default: dns } = await import('node:dns');
  const original = dns.promises.lookup;
  dns.promises.lookup = async () => ([
    { address: '2408:8756:f50:4::17', family: 6 },
    { address: '116.162.45.14', family: 4 }
  ]);
  try {
    // 用动态 import 拿到"用这份 DNS 桩解析"的实例：模块在导入时捕获 lookup 引用，
    // 所以先替换再导入（与 test-audit-security 的做法一致）。
    const mod = await import(`../src/safe-fetch.js?failover=${Date.now()}`);
    assert.deepEqual(await mod.resolveSafeAddresses('p.qpic.cn'), ['116.162.45.14', '2408:8756:f50:4::17']);
  } finally {
    dns.promises.lookup = original;
  }
});

// ── 搜索：空结果 note 必须进入缓存（否则 5 分钟内重复查询拿不到提示） ────────────
// 不能真联网，所以这里是**结构断言**：note 走的是 `value = {...value, note}`（新建对象），
// 而缓存存的是引用；先 cache.set 再加 note ⇒ 命中缓存时拿到的正是那个没有 note 的旧对象，
// 而「同一句 query 连着问几次」恰恰是模型最容易开始重试的场景（issue #17 的修复点）。
await test('webSearch：空结果提示在写缓存之前生成（缓存命中也要带 note）', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'web-search.js'), 'utf8');
  const noteAt = source.indexOf('没有搜到结果');
  const cacheAt = source.indexOf('cache.set(cacheKey');
  assert.ok(noteAt > 0, 'webSearch 必须给空结果附 note');
  assert.ok(cacheAt > 0, 'webSearch 必须有 5 分钟查询缓存');
  assert.ok(noteAt < cacheAt, 'note 必须在 cache.set 之前生成：缓存存的是 value 的引用，反过来写会让缓存命中丢掉提示');
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
