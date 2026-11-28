import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { parseQQCard, formatQQCardText, extractCardsFromSegments } from '../src/qq-card.js';
import { compactModelData } from '../src/qq-model-view.js';
import { formatForwardResponse } from '../src/forward.js';
import { createChatLearningStore } from '../src/chat-learning.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=',
  'base64'
);

test('parses group invitation Ark card without exposing internal mqqapi URL or tokens', () => {
  const raw = JSON.stringify({
    app: 'com.tencent.tuwen.lua',
    prompt: '[链接]邀请你加入群聊',
    bizsrc: 'qun.invite',
    meta: {
      news: {
        desc: '邀请你加入群聊“示例测试群”，进入可查看详情。',
        jumpUrl: 'mqqapi://group/invite_join?src_type=internal&version=1&groupcode=600010001&msgseq=9000000000000001&groupname=%E7%A4%BA%E4%BE%8B%E6%B5%8B%E8%AF%95%E7%BE%A4&senderuin=200010001&receiveruin=100010001',
        preview: 'https://p.qlogo.cn/gh/600010001/600010001/',
        tag: '邀请加群',
        title: '邀请你加入群聊',
      },
    },
    config: { token: 'fixture-ark-token-0123456789abcdef' },
  });

  const parsed = parseQQCard(raw);
  assert.ok(parsed);
  assert.equal(parsed.tag, '邀请加群');
  assert.equal(parsed.title, '邀请你加入群聊');
  assert.equal(parsed.url, undefined);
  assert.equal(parsed.previewUrl, undefined, 'group invite avatars must not be exposed as card covers');
  assert.deepEqual(parsed.invite, {
    groupId: '600010001',
    groupName: '示例测试群',
    seq: '9000000000000001',
    senderId: '200010001',
  });

  const summary = formatQQCardText(raw);
  assert.equal(summary, '[卡片：邀请加群｜邀请你加入群聊 — 邀请你加入群聊“示例测试群”，进入可查看详情。（群号 600010001）]');
  assert.doesNotMatch(summary, /mqqapi:\/\/|fixture-ark-token-0123456789abcdef/);
});

test('parses Bilibili miniapp detail_1 card and SDK share card, stripping tracking params cleanly', () => {
  const miniapp = JSON.stringify({
    app: 'com.tencent.miniapp_01',
    prompt: '[QQ小程序]示例视频标题',
    meta: {
      detail_1: {
        appid: '1109937557',
        title: '哔哩哔哩',
        desc: '示例视频标题',
        preview: 'https://pic.ugcimg.cn/example-cover/jpg1?sign=keepme&ts=1795767301',
        icon: 'http://miniapp.gtimg.cn/public/appicon/432b76be_200.jpg',
        host: { uin: 2875726738, nick: '分享者昵称' },
        qqdocurl: 'https://b23.tv/example01?share_source=qq',
      },
    },
  });
  const miniParsed = parseQQCard(miniapp);
  assert.equal(miniParsed.tag, '哔哩哔哩');
  assert.equal(miniParsed.desc, '示例视频标题');
  assert.equal(miniParsed.author, undefined, 'sharer host.nick must not be treated as content author');
  assert.equal(miniParsed.url, 'https://b23.tv/example01');
  assert.equal(miniParsed.previewUrl, 'https://pic.ugcimg.cn/example-cover/jpg1?sign=keepme&ts=1795767301');
  assert.equal(
    formatQQCardText(miniParsed),
    '[卡片：哔哩哔哩 — 示例视频标题 https://b23.tv/example01]'
  );

  const biliAndroid = JSON.stringify({
    app: 'com.tencent.miniapp_01',
    prompt: '[QQ小程序]根本没有这种生物！',
    meta: {
      detail_1: {
        appid: '1109937557',
        title: '哔哩哔哩',
        desc: '根本没有这种生物！',
        preview: 'https://qq.ugcimg.cn/v1/abc/def',
        qqdocurl: 'https://bili2233.cn/KlPfMOl?share_medium=android&share_source=qq&bbid=XX123&ts=1795742575265&p=2&t=45',
      },
    },
  });
  const biliParsed = parseQQCard(biliAndroid);
  assert.equal(biliParsed.url, 'https://bili2233.cn/KlPfMOl?p=2&t=45');

  const sdkShare = JSON.stringify({
    app: 'com.tencent.tuwen.lua',
    bizsrc: 'qqconnect.sdkshare',
    meta: {
      news: {
        tag: '哔哩哔哩',
        title: '直播间标题',
        desc: 'UP主：测试-房间号：123456',
        author: '示例UP主',
        jumpUrl: '//b23.tv/example02?spm_id_from=333.1007&utm_source=qq&ts=9999&xsec_token=keep-tok',
      },
    },
  });
  assert.equal(
    formatQQCardText(sdkShare),
    '[卡片：哔哩哔哩｜直播间标题 — UP主：测试-房间号：123456 / 作者：示例UP主 https://b23.tv/example02?ts=9999&xsec_token=keep-tok]'
  );
});

test('never truncates clean URLs when title/desc are very long and extracts compact structured cards', () => {
  const longTitle = '这是一个非常长的标题用来挤占文本预算'.repeat(15);
  const longDesc = '这是一段也很长的摘要说明文字内容'.repeat(15);
  const cleanUrl = 'https://www.example.com/articles/12345?id=98765&page=3';
  const raw = JSON.stringify({
    app: 'com.tencent.tuwen.lua',
    meta: {
      news: {
        tag: '专栏',
        title: longTitle,
        desc: longDesc,
        preview: 'https://cdn.example.com/cover.png?auth=secret-cdn-sig',
        jumpUrl: `${cleanUrl}&utm_medium=share&vd_source=track123`,
      },
    },
  });
  const text = formatQQCardText(raw);
  assert.ok(text.endsWith(`${cleanUrl}]`), `URL must stay completely intact, got: ${text}`);

  const cards = extractCardsFromSegments([
    { type: 'text', data: { text: '看这个' } },
    { type: 'card', data: { data: raw } },
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].url, cleanUrl);
  assert.equal(cards[0].hasCover, true);
  assert.equal('previewUrl' in cards[0], false, 'raw CDN previewUrl must not appear in structured cards');

  const fwd = formatForwardResponse({
    messages: [{
      message_id: '501',
      sender: { user_id: '100', nickname: '群友' },
      message: [{ type: 'card', data: { data: raw } }],
    }],
  });
  assert.equal(fwd.messages[0].cards.length, 1);
  assert.equal(fwd.messages[0].cards[0].url, cleanUrl);
  assert.equal(fwd.messages[0].media.length, 1);
  assert.equal(fwd.messages[0].media[0].kind, 'cardCover');
  assert.equal(fwd.messages[0].media[0].url, 'https://cdn.example.com/cover.png?auth=secret-cdn-sig');
});

test('rejects malformed, oversized, non-http, and credentialed URLs and strips control chars', () => {
  assert.equal(parseQQCard('not json'), null);
  assert.equal(parseQQCard('{"a":1}'), null);
  assert.equal(formatQQCardText('{bad json'), '[卡片消息]');
  assert.equal(parseQQCard('{"prompt":"' + 'x'.repeat(33_000) + '"}'), null);

  for (const badUrl of [
    'https://user:pass@example.com/secret',
    'javascript:alert(1)',
    'file:///C:/Windows/win.ini',
    'mqqapi://miniapp/open?id=1',
  ]) {
    const raw = JSON.stringify({
      prompt: 'line1\nline2\u200b\u0007',
      meta: {
        news: {
          tag: '标签\r\n伪造',
          title: '标题\n第二行',
          desc: '描述',
          jumpUrl: badUrl,
        },
      },
    });
    const parsed = parseQQCard(raw);
    assert.ok(parsed);
    assert.equal(parsed.url, undefined, `must reject URL: ${badUrl}`);
    assert.doesNotMatch(formatQQCardText(parsed), /[\r\n\u200b\u0007]/);
    assert.doesNotMatch(formatQQCardText(parsed), /user:pass|javascript:|file:|mqqapi:/);
  }
});

test('bridge integrates structured cards and SSRF-hardened cardCover retrieval across history, detail, images, detail crop, forwards, learning, and sticker collection', async (t) => {
  const cardPayload = JSON.stringify({
    app: 'com.tencent.miniapp_01',
    prompt: '[QQ小程序]测试视频标题',
    meta: {
      detail_1: {
        appid: '1109937557',
        title: '哔哩哔哩',
        desc: '测试视频标题',
        preview: 'https://cdn.example.com/bili-cover.jpg?sign=keep-sig',
        qqdocurl: 'https://b23.tv/Example99?share_medium=android&share_source=qq&bbid=XX99&ts=1795767301',
      },
    },
  });
  const ssrfPayload = JSON.stringify({
    app: 'com.tencent.miniapp_01',
    meta: {
      detail_1: {
        title: '内网探测',
        desc: 'SSRF 测试',
        preview: 'http://127.0.0.1:9/secret.png',
        qqdocurl: 'https://b23.tv/safe',
      },
    },
  });

  // 1. With mocked safeFetchBuffer: verify cards, hidden CDN URL, preview, original + crop detail, forward guard, sticker collect block
  const fetchedUrls = [];
  const cropCalls = [];
  const h = await bridgeHarness({
    config: { qqBackend: 'native' },
    globals: {
      safeFetchBuffer: async (url) => {
        fetchedUrls.push(url);
        return { url, statusCode: 200, buffer: TINY_PNG };
      },
      prepareImageDetail: async (buffer, mimeType, options) => {
        cropCalls.push({ mimeType, crop: options.crop ? structuredClone(options.crop) : null });
        return {
          ok: true,
          buffer,
          mimeType,
          representation: options.crop ? 'crop' : 'original',
          width: 1,
          height: 1,
          originalWidth: 1,
          originalHeight: 1,
          note: options.crop ? '原图局部裁剪' : '',
        };
      },
    },
  });
  h.bot.account = '42';
  h.bot.health = { connected: true };
  h.bot.emit('open');
  h.setReady(true);
  const session = await h.ensureDesktopAgentSession();
  const token = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/desktop-agent.json'), 'utf8')).agentToken;
  const server = h.startConsoleServer();
  if (!server.listening) await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await h.close(); });

  h.bot.raw = async (action, params) => {
    if (action === 'get_forward_msg') {
      return {
        messages: [{
          message_id: '888',
          sender: { user_id: '100', nickname: '转发人' },
          message: [{ type: 'card', data: { data: cardPayload } }],
        }],
      };
    }
    if (params.message_id === '502') {
      return {
        messages: [{
          message_id: '502', group_id: 456, user_id: 123, time: 1700000001,
          sender: { user_id: 123, nickname: '群友' },
          message: [{ type: 'card', data: { data: ssrfPayload } }],
        }],
      };
    }
    return {
      messages: [{
        message_id: '501', group_id: 456, user_id: 123, time: 1700000000,
        sender: { user_id: 123, nickname: '群友' },
        message: [{ type: 'card', data: { data: cardPayload } }],
      }],
    };
  };

  const req = async (route, body = undefined) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-console-token': 'fixture-console-token',
        'x-agent-call': '1',
        'x-agent-token': token,
        'x-agent-session-id': session,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, data: await res.json() };
  };

  // conversation-history returns clean card url & hasCover, strips raw CDN cover url from media, never fetches cover automatically
  const hist = await req('/api/socialV2/conversation-history?key=group:456&count=5');
  assert.equal(hist.status, 200);
  const histMsg = hist.data.messages[0];
  assert.deepEqual(histMsg.cards, [{ tag: '哔哩哔哩', desc: '测试视频标题', url: 'https://b23.tv/Example99', hasCover: true }]);
  assert.equal(histMsg.hasMedia, true);
  assert.deepEqual(histMsg.media, [{ kind: 'cardCover', summary: '哔哩哔哩卡片封面' }]);
  assert.deepEqual(compactModelData(hist.data).messages[0].media, [{ kind: 'cardCover', summary: '哔哩哔哩卡片封面', index: 1 }]);
  assert.equal(fetchedUrls.length, 0);

  // message-detail exposes structured cards and compacted media without raw CDN url
  const detail = await req('/api/socialV2/message-detail?key=group:456&messageId=id:501');
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.info.cards, histMsg.cards);
  assert.deepEqual(detail.data.info.media, [{ kind: 'cardCover', summary: '哔哩哔哩卡片封面', index: 1 }]);
  assert.equal(detail.data.info.hasMedia, true);

  // qq_get_message_images fetches cover via safeFetchBuffer and returns imageRef + image bytes without exposing raw CDN url
  const imgs = await req('/api/images/message?key=group:456&messageId=id:501');
  assert.equal(imgs.status, 200);
  assert.equal(imgs.data.images.length, 1);
  assert.equal(imgs.data.images[0].kind, 'cardCover');
  assert.equal(imgs.data.images[0].canFetchOriginal, true);
  assert.match(imgs.data.images[0].imageRef, /^qqimg:/);
  assert.equal('url' in imgs.data.images[0], false);
  assert.equal('url' in imgs.data.media[0], false);
  assert.deepEqual(fetchedUrls, ['https://cdn.example.com/bili-cover.jpg?sign=keep-sig']);

  // qq_get_image_detail supports quality=original + crop on registered cardCover imageRef
  const crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
  const detailImg = await req('/api/socialV2/image-detail', {
    key: 'group:456',
    imageRef: imgs.data.images[0].imageRef,
    quality: 'original',
    crop,
  });
  assert.equal(detailImg.status, 200);
  assert.equal(detailImg.data.images[0].kind, 'cardCover');
  assert.equal(detailImg.data.images[0].representation, 'crop');
  assert.deepEqual(cropCalls[0].crop, crop);

  // forward-message + forward-media: registered forward imageRef succeeds; arbitrary caller URL is rejected (400)
  const fwd = await req('/api/socialV2/forward-message?key=group:456&id=native:7700000000000000001');
  assert.equal(fwd.status, 200);
  const fwdMediaRef = fwd.data.messages[0].media[0].imageRef;
  assert.match(fwdMediaRef, /^qqimg:/);
  assert.equal('url' in fwd.data.messages[0].media[0], false, 'forward-message HTTP response must strip raw CDN cover url');
  const badFwd = await req('/api/socialV2/forward-media', {
    key: 'group:456',
    media: [{ kind: 'cardCover', url: 'https://attacker.invalid/pwn.png' }],
  });
  assert.equal(badFwd.status, 400);
  const badRefFwd = await req('/api/socialV2/forward-media', {
    key: 'group:456',
    media: [{ kind: 'cardCover', imageRef: imgs.data.images[0].imageRef }],
  });
  assert.equal(badRefFwd.status, 400, 'non-forward imageRef must not be accepted by forward-media');
  const okFwd = await req('/api/socialV2/forward-media', {
    key: 'group:456',
    media: [{ kind: 'cardCover', imageRef: fwdMediaRef }],
  });
  assert.equal(okFwd.status, 200);
  assert.equal(okFwd.data.images[0].kind, 'cardCover');
  assert.ok(okFwd.data.images[0].data);

  // collect-sticker refuses cardCover
  const collectRes = await req('/api/socialV2/collect-sticker', { key: 'group:456', messageId: 'id:501' });
  assert.equal(collectRes.status, 500);
  assert.match(collectRes.data.error, /卡片封面图不能收藏为 QQ 表情/);

  // chatLearning skips cardCover
  const learnDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-card-learn-'));
  t.after(() => fs.rmSync(learnDir, { recursive: true, force: true }));
  const learning = createChatLearningStore(path.join(learnDir, 'learning.json'));
  const enqueued = learning.enqueue('group:456', {
    messageId: '501', nativeAccount: '42', plain: '[卡片消息]',
    media: [{ kind: 'cardCover', url: 'https://cdn.example.com/bili-cover.jpg', summary: '哔哩哔哩卡片封面' }],
  }, { enabled: true, slang: false, stickers: true, sources: [], maxImages: 2 });
  assert.equal(enqueued, false);

  // 2. Real safeFetchBuffer (no globals override): verifies SSRF target http://127.0.0.1:9/secret.png is blocked cleanly
  const hReal = await bridgeHarness({ config: { qqBackend: 'native' } });
  hReal.bot.account = '42';
  hReal.bot.health = { connected: true };
  hReal.bot.emit('open');
  hReal.setReady(true);
  const sess2 = await hReal.ensureDesktopAgentSession();
  const tok2 = JSON.parse(fs.readFileSync(path.join(hReal.temp, 'state/desktop-agent.json'), 'utf8')).agentToken;
  const srv2 = hReal.startConsoleServer();
  if (!srv2.listening) await once(srv2, 'listening');
  t.after(async () => { await new Promise(resolve => srv2.close(resolve)); await hReal.close(); });
  hReal.bot.raw = async () => ({
    messages: [{
      message_id: '502', group_id: 456, user_id: 123, time: 1700000001,
      sender: { user_id: 123, nickname: '群友' },
      message: [{ type: 'card', data: { data: ssrfPayload } }],
    }],
  });
  const ssrfRes = await fetch(`http://127.0.0.1:${srv2.address().port}/api/images/message?key=group:456&messageId=id:502`, {
    headers: { 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-session-id': sess2, 'x-agent-token': tok2 },
  });
  const ssrfJson = await ssrfRes.json();
  assert.equal(ssrfRes.status, 200);
  assert.equal(ssrfJson.images[0].kind, 'cardCover');
  assert.equal(ssrfJson.images[0].data, undefined);
  assert.match(ssrfJson.images[0].text, /内网或本机受限地址/);
});
