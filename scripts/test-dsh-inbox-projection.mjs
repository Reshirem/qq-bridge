// Current DSH inbox projection parsing contract.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inboxItemsOfProjections,
  inboxItemIds,
} from '../src/dsh-client.js';

/** Minimal inbox item shape returned by DSH. */
const realInboxItem = (id, text) => ({
  content: [{ type: 'text', text }],
  source: { kind: 'user', rpcId: 'rpc-0000-0000-0000-000000000000' },
  role: 'user',
  id,
});
/** Session projection values used by the queue reader. */
const projectionValues = (inbox) => ({
  title: 'QQ 聊天',
  tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ...(inbox === undefined ? {} : { inbox }),
});

// ── 1. 投影解析 ─────────────────────────────────────────────────────────────
test('inbox 投影：两个边界一起取，顺序为 next-turn → next-step', () => {
  const values = projectionValues({
    'next-turn': [realInboxItem('m-1', '第一轮')],
    'next-step': [realInboxItem('m-2', '插话')],
  });
  assert.deepEqual(inboxItemsOfProjections(values).map((i) => i.id), ['m-1', 'm-2']);
});

test('inbox 投影：空队列返回空数组（不是错误）', () => {
  assert.deepEqual(inboxItemsOfProjections(projectionValues({ 'next-turn': [], 'next-step': [] })), []);
});

test('inbox 投影：能力缺失（无 inbox 键 / values 为 null）视为无待处理项', () => {
  // 会话没有活动 agent 时，投影表里可能没有 inbox 这一项。
  assert.deepEqual(inboxItemsOfProjections(projectionValues(undefined)), []);
  assert.deepEqual(inboxItemsOfProjections(null), []);
  // session/projections 对不存在的会话返回 null。
  assert.deepEqual(inboxItemsOfProjections(undefined), []);
});

test('inbox 投影：只有一个边界存在时也能解析（另一个是可选能力）', () => {
  assert.deepEqual(
    inboxItemsOfProjections(projectionValues({ 'next-turn': [realInboxItem('m-1', 'x')] })).map((i) => i.id),
    ['m-1'],
  );
  assert.deepEqual(
    inboxItemsOfProjections(projectionValues({ 'next-step': [] })).map((i) => i.id),
    [],
  );
});

test('inbox 投影：结构变了必须显式失败，不能静默当成空队列', () => {
  // 静默返回 [] 正是「队列清不掉却毫无提示」的成因。
  for (const bad of [
    { 'next-turn': null },
    { 'next-turn': {} },
    { 'next-turn': 'm-1' },
    { 'next-step': 3 },
  ]) {
    assert.throws(
      () => inboxItemsOfProjections(projectionValues(bad)),
      /invalid session inbox projection/,
      `结构 ${JSON.stringify(bad)} 应抛错`,
    );
  }
  assert.throws(() => inboxItemsOfProjections(projectionValues([])), /invalid session inbox projection/);
  assert.throws(() => inboxItemsOfProjections(projectionValues('inbox')), /invalid session inbox projection/);
});

// ── 2. itemId 抽取 ─────────────────────────────────────────────────────────
test('itemId 抽取：取出 MessageId 字符串', () => {
  assert.deepEqual(
    inboxItemIds([realInboxItem('m-1', 'a'), realInboxItem('m-2', 'b')]),
    ['m-1', 'm-2'],
  );
});

test('itemId 抽取：缺 id / id 非字符串必须抛错（否则 updateQueue 无从下手）', () => {
  for (const bad of [
    [{ content: [] }],
    [{ id: '' }],
    [{ id: 42 }],
    [{ id: null }],
    [null],
    [undefined],
  ]) {
    assert.throws(() => inboxItemIds(bad), /invalid session inbox item/, JSON.stringify(bad));
  }
});
