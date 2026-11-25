import assert from 'node:assert/strict';
import test from 'node:test';
import { parseQQCard, formatQQCardText } from '../src/qq-card.js';

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

test('parses Bilibili miniapp detail_1 card and SDK http/https share card cleanly', () => {
  const miniapp = JSON.stringify({
    app: 'com.tencent.miniapp_01',
    prompt: '[QQ小程序]示例视频标题',
    meta: {
      detail_1: {
        appid: '1109937557',
        title: '哔哩哔哩',
        desc: '示例视频标题',
        qqdocurl: 'https://b23.tv/example01?share_source=qq',
      },
    },
  });
  const miniParsed = parseQQCard(miniapp);
  assert.equal(miniParsed.tag, '哔哩哔哩');
  assert.equal(miniParsed.desc, '示例视频标题');
  assert.equal(miniParsed.url, 'https://b23.tv/example01?share_source=qq');
  assert.equal(
    formatQQCardText(miniParsed),
    '[卡片：哔哩哔哩 — 示例视频标题 https://b23.tv/example01?share_source=qq]'
  );

  const sdkShare = JSON.stringify({
    app: 'com.tencent.tuwen.lua',
    bizsrc: 'qqconnect.sdkshare',
    meta: {
      news: {
        tag: '哔哩哔哩',
        title: '直播间标题',
        desc: 'UP主：测试-房间号：123456',
        jumpUrl: 'https://b23.tv/example01',
      },
    },
  });
  assert.equal(
    formatQQCardText(sdkShare),
    '[卡片：哔哩哔哩｜直播间标题 — UP主：测试-房间号：123456 https://b23.tv/example01]'
  );
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
