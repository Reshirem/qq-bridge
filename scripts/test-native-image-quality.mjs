import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeQQ } from '../src/native-qq.js';

const MiB = 1024 * 1024;
const digest = 'a'.repeat(32);
const locator = {file:digest, key:'group:456', messageId:'123'};
const metadata = (overrides = {}) => ({
  file:'preview.png', representation:'preview', width:485, height:647,
  originalWidth:null, originalHeight:null, originalAvailable:false,
  originalUnavailableReason:'not_cached', ...overrides,
});
const original = (overrides = {}) => metadata({
  file:'original.png', representation:'original', width:3072, height:4096,
  originalWidth:3072, originalHeight:4096, originalAvailable:true,
  originalUnavailableReason:null, ...overrides,
});
const missingOriginal = () => metadata({file:null, representation:'original', width:null, height:null});
function fixture(t) {
  const bot = new NativeQQ(process.cwd());
  bot.account = '42';
  bot.call = async () => { throw Error('unexpected QQ request'); };
  t.after(() => bot.close());
  return bot;
}

test('preview returns dimensions and distinguishes a fetchable original from a cached original', async t => {
  const bot = fixture(t), reads = [];
  bot.read = async (action, params) => { reads.push({action,params}); return metadata(); };
  const result = await bot.getImage({...locator,quality:'preview'});
  assert.deepEqual(result, {...metadata(),canFetchOriginal:true});
  assert.deepEqual(reads, [{action:'media',params:{type:'image',md5:digest,maxBytes:8 * MiB,quality:'preview'}}]);
  assert.equal((await bot.getImage({file:digest,quality:'preview'})).canFetchOriginal, false,
    'a missing original needs a source locator before it can be downloaded');
  bot.read = async () => metadata({originalAvailable:true,originalWidth:3072,originalHeight:4096,originalUnavailableReason:null});
  const cached = await bot.getImage({...locator,quality:'preview'});
  assert.equal(cached.originalAvailable, true);
  assert.equal(cached.originalWidth, 3072);
  assert.equal(cached.canFetchOriginal, true);
});

test('an original cache miss downloads and polls for a verified original, never settling for a preview', async t => {
  const bot = fixture(t), reads = [], calls = [];
  bot.read = async (action, params) => {
    reads.push({action,params});
    return reads.length < 3 ? missingOriginal() : original();
  };
  bot.call = async (action, params) => { calls.push({action,params}); return {requested:true}; };
  const result = await bot.getImage({...locator,quality:'original'});
  assert.deepEqual(result, {...original(),canFetchOriginal:true});
  assert.equal(reads.length, 3);
  assert.ok(reads.every(read => read.params.quality === 'original' && read.params.maxBytes === 32 * MiB));
  assert.deepEqual(calls, [{action:'fetch_message_image',params:{peer:{chatType:2,peerUid:'456'},messageId:'123',md5:digest,quality:'original'}}]);
});

test('explicit originals reject preview or legacy-reader responses rather than relabeling them', async t => {
  const bot = fixture(t);
  for (const response of [metadata(), original({originalAvailable:false}), 'preview.png', null]) {
    bot.read = async () => response;
    await assert.rejects(bot.getImage({...locator,quality:'original'}), /画质信息|未使用预览代替/);
  }
});

test('original requests never switch to a market preview or CDN', async t => {
  const bot = fixture(t), reads = [], calls = [];
  bot.read = async (action, params) => { reads.push(params); return reads.length === 1 ? missingOriginal() : original(); };
  bot.call = async (action, params) => { calls.push(action); return {requested:true}; };
  const params = {...locator,quality:'original',emojiId:'b'.repeat(32),emojiPackageId:'42'};
  const result = await bot.getImage(params);
  assert.equal(result.representation, 'original');
  assert.ok(reads.every(read => read.type === 'image'));
  assert.deepEqual(calls, ['fetch_message_image']);
  reads.length = 0;
  await assert.rejects(bot.getImage({quality:'original',emojiId:'b'.repeat(32),emojiPackageId:'42'}), /不支持读取原图/);
  assert.equal(reads.length, 0);
});

test('preview and original requests retain forward source checks even on cache hits', async t => {
  const bot = fixture(t), calls = [];
  bot.call = async (action, params) => { calls.push({action,params}); return {verified:true}; };
  bot.read = async (_action, params) => params.quality === 'original' ? original() : metadata();
  for (const quality of ['preview','original']) {
    await bot.getImage({...locator,quality,forwardId:'native:111'});
  }
  assert.deepEqual(calls.map(call => call.action), ['check_forward_image','check_forward_image']);
  assert.ok(calls.every(call => call.params.forwardId === 'native:111' && call.params.messageId === '123' && call.params.md5 === digest));
  let reads = 0;
  bot.read = async () => { reads++; return original(); };
  bot.call = async () => { throw Error('source mismatch'); };
  await assert.rejects(bot.getImage({...locator,quality:'original',forwardId:'native:222'}), /source mismatch/);
  assert.equal(reads, 0);
});

test('different qualities or byte limits do not share in-flight results; matching defaults do', async t => {
  const bot = fixture(t), pending = [];
  bot.read = (action, params) => new Promise(resolve => pending.push({action,params,resolve}));
  t.after(() => { for (const entry of pending) entry.resolve(null); });
  const legacy = bot.getImage({file:digest,maxBytes:8 * MiB});
  const preview = bot.getImage({file:digest,quality:'preview'});
  const full = bot.getImage({file:digest,quality:'original',maxBytes:8 * MiB});
  const larger = bot.getImage({file:digest,quality:'original',maxBytes:32 * MiB});
  assert.equal(bot.getImage({file:digest,quality:'preview',maxBytes:8 * MiB}), preview);
  assert.equal(bot.getImage({file:digest,quality:'original'}), larger);
  assert.equal(new Set([legacy,preview,full,larger]).size, 4);
  assert.equal(pending.length, 4);
  for (const entry of pending) entry.resolve(entry.params.quality === 'original' ? original()
    : entry.params.quality === 'preview' ? metadata() : 'legacy.png');
  const results = await Promise.all([legacy,preview,full,larger]);
  assert.deepEqual(results[0], {file:'legacy.png'});
  assert.equal(results[1].representation, 'preview');
  assert.equal(results[2].representation, 'original');
  assert.equal(results[3].representation, 'original');
  assert.equal(bot.imageRequests.size, 0);
});

test('quality and 32 MiB original bounds are validated before touching caches or downloads', async t => {
  const bot = fixture(t);
  let reads = 0;
  bot.read = async () => { reads++; return original(); };
  for (const quality of [null, '', 'full', true, 1, [], {}]) {
    await assert.rejects(bot.getImage({...locator,quality}), /quality/);
    await assert.rejects(bot.raw('get_image', {...locator,quality}), /quality/);
  }
  for (const maxBytes of [null, true, 0, -1, 1.5, '33554432', NaN, Infinity, 32 * MiB + 1]) {
    await assert.rejects(bot.getImage({...locator,quality:'original',maxBytes}), /maxBytes/);
    await assert.rejects(bot.getImage({...locator,quality:'preview',maxBytes}), /maxBytes/);
  }
  await assert.rejects(bot.getImage({...locator,maxBytes:32 * MiB}), /maxBytes/);
  assert.equal(reads, 0);
  assert.equal((await bot.getImage({...locator,quality:'original',maxBytes:32 * MiB})).originalAvailable, true);
  const previewSource = await bot.getImage({...locator,quality:'preview',maxBytes:32 * MiB});
  assert.equal(previewSource.representation, 'original', 'preview generation may read an original source when thumbnails are missing');
});

test('oversized originals are explained without claiming availability or attempting repeated downloads', async t => {
  const bot = fixture(t);
  bot.read = async () => metadata({originalWidth:8000,originalHeight:6000,originalUnavailableReason:'source_too_large'});
  const result = await bot.getImage({...locator,quality:'preview'});
  assert.equal(result.originalAvailable, false);
  assert.equal(result.canFetchOriginal, false);
  assert.equal(result.originalUnavailableReason, 'source_too_large');
  assert.equal(result.originalWidth, 8000);
  bot.read = async () => { throw Error('QQ 本地图片缓存均超过读取大小上限（33554432 字节），未重复下载'); };
  for (let i = 0; i < 2; i++) await assert.rejects(bot.getImage({...locator,quality:'original'}), /大小上限/);
});

test('quality metadata never exposes arbitrary reader fields or advertises an unsupported market original', async t => {
  const bot = fixture(t);
  bot.read = async () => metadata({originalUnavailableReason:'unsupported',width:'485',height:-1,secret:'never forward this'});
  const result = await bot.getImage({quality:'preview',emojiId:'b'.repeat(32),emojiPackageId:'42'});
  assert.equal(result.canFetchOriginal, false);
  assert.equal(result.originalAvailable, false);
  assert.equal(result.width, null);
  assert.equal(result.height, null);
  assert.equal(result.secret, undefined);
});

test('account changes still discard original and preview responses', async t => {
  const bot = fixture(t);
  let release;
  bot.read = () => new Promise(resolve => { release = resolve; });
  for (const quality of ['preview','original']) {
    const pending = bot.getImage({...locator,quality});
    bot.account = String(Number(bot.account) + 1);
    release(quality === 'original' ? original() : metadata());
    await assert.rejects(pending, /账号或连接已改变/);
  }
});

test('native-verified converted caches are previews and caller paths never reach the reader', async t => {
  const bot = fixture(t), reads = [], calls = [];
  bot.read = async (action, params) => {
    reads.push({action,params});
    return params.verifiedPreviewPath ? metadata({file:'converted.jpg',requiresDecode:true,originalUnavailableReason:'invalid_cache'})
      : metadata({file:null,originalUnavailableReason:'invalid_cache'});
  };
  bot.call = async (action, params) => {
    calls.push({action,params});
    return {requested:false,verifiedPreviewPath:'native-thumb0.png'};
  };
  const result = await bot.getImage({...locator,quality:'preview',verifiedPreviewPath:'untrusted.png'});
  assert.equal(result.file, 'converted.jpg');
  assert.equal(result.representation, 'preview');
  assert.equal(result.originalAvailable, false);
  assert.equal(result.requiresDecode, true);
  assert.equal(reads[0].params.verifiedPreviewPath, undefined);
  assert.equal(reads[1].params.verifiedPreviewPath, 'native-thumb0.png');
  assert.equal(calls[0].params.verifiedPreviewPath, undefined);
  assert.equal(calls[0].params.quality, 'preview');
});

test('prefetch retains its path result while marking native converted previews for decoding', async t => {
  const bot = fixture(t), reads = [];
  bot.read = async (_action, params) => {
    reads.push(params);
    return params.verifiedPreviewPath ? metadata({file:'converted.jpg',requiresDecode:true}) : null;
  };
  bot.call = async () => ({requested:false,verifiedPreviewPath:'native-thumb0.png'});
  assert.deepEqual(await bot.getImage(locator), {file:'converted.jpg',requiresDecode:true});
  assert.equal(reads[1].quality, 'preview');
  assert.equal(reads[1].maxBytes, 20 * MiB);
});

test('original reads ignore native preview locators even if an older runtime returns one', async t => {
  const bot = fixture(t), reads = [];
  bot.read = async (_action, params) => {
    reads.push(params);
    return reads.length === 1 ? missingOriginal() : original();
  };
  bot.call = async () => ({verifiedPreviewPath:'converted.png'});
  const result = await bot.getImage({...locator,quality:'original'});
  assert.equal(result.representation, 'original');
  assert.ok(reads.every(p => !p.verifiedPreviewPath && p.quality === 'original'));
});

test('account or reader changes during native preview lookup cancel before reading that path', async t => {
  const bot = fixture(t);
  let release, reads = 0;
  bot.read = async () => { reads++; return metadata({file:null}); };
  bot.call = () => new Promise(resolve => { release = resolve; });
  const pending = bot.getImage({...locator,quality:'preview'});
  while (!release) await new Promise(resolve => setImmediate(resolve));
  bot.account = '43';
  release({requested:false,verifiedPreviewPath:'other-account.png'});
  await assert.rejects(pending, /账号或连接已改变/);
  assert.equal(reads, 1);
});
