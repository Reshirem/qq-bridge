import assert from 'node:assert/strict';
import { classifyIncomingWake, isBootstrapWakeReason, shouldAttachWakeSnapshot, wakeReasonBase } from '../src/autonomy-policy.js';

const selfId = '999';

assert.equal(classifyIncomingWake({ kind: 'private', message: [], selfId }), 'private', 'private messages are direct wakes');
assert.equal(classifyIncomingWake({
  kind: 'group',
  selfId,
  message: [{ type: 'at', data: { qq: selfId } }]
}), 'atMention', 'native @ to the bot wakes');
assert.equal(classifyIncomingWake({
  kind: 'group',
  selfId,
  message: [{ type: 'at', data: { qq: 'all' } }]
}), null, '@all is not a mention of the bot');
assert.equal(classifyIncomingWake({
  kind: 'group',
  selfId,
  message: [{ type: 'text', data: { text: '@鲸鱼 你怎么看' } }]
}), null, 'plain-text name or @ text is not a native mention');
assert.equal(classifyIncomingWake({ kind: 'group', selfId, message: [], replyTargetIsSelf: true }), 'atMention', 'verified reply-to-self wakes');
assert.equal(classifyIncomingWake({ kind: 'group', selfId, message: [], replyTargetIsSelf: false }), null, 'ordinary group messages do not wake');
assert.equal(classifyIncomingWake({ kind: 'unknown', selfId, message: [] }), null, 'unknown channels fail closed');
assert.equal(classifyIncomingWake({
  kind: 'group', selfId, message: [], text: '刚才聊到小鲸了', roleCardNames: ['小鲸']
}), 'roleCardName:小鲸', 'the supplied selected persona-card name wakes');
assert.equal(classifyIncomingWake({
  kind: 'group', selfId, message: [], text: '刚才聊到旧卡了', roleCardNames: ['当前卡']
}), null, 'a non-selected persona-card name does not wake');
assert.equal(classifyIncomingWake({
  kind: 'group', selfId, message: [], text: '小鲸', roleCardNames: []
}), null, 'persona-card names do not wake when there is no selected role');

assert.equal(wakeReasonBase('bootstrap:atMention@seq12'), 'atMention', 'bootstrap reason retains its direct trigger');
assert.equal(wakeReasonBase('timeout'), 'timeout');
assert.equal(isBootstrapWakeReason('bootstrap'), true);
assert.equal(isBootstrapWakeReason('bootstrap:atMention@seq12'), true);
assert.equal(isBootstrapWakeReason('atMention@seq12'), false);
assert.equal(shouldAttachWakeSnapshot('atMention@seq12'), true, 'only the direct trigger wake gets an automatic snapshot');
assert.equal(shouldAttachWakeSnapshot('private@seq3'), true);
assert.equal(shouldAttachWakeSnapshot('bootstrap:atMention@seq12'), true);
assert.equal(shouldAttachWakeSnapshot('bootstrap'), false, 'a manual bootstrap does not auto-read buffered messages');
assert.equal(shouldAttachWakeSnapshot('timeout'), false, 'explicit timer wake does not auto-read buffered messages');
assert.equal(shouldAttachWakeSnapshot('admin'), false, 'manual background wake leaves reads to the session');

console.log('Autonomous wake policy checks passed.');
