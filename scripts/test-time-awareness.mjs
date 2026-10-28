// 纯函数回归：QQ 消息的模型视图把时间格式化为 at/ago，便于全局陪伴者按需读取。
import assert from 'node:assert/strict';
import { compactModelMessage, compactModelData, describeAge, serializeModelData } from '../src/qq-model-view.js';

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const NOW = new Date(2026, 9, 18, 11, 31, 5).getTime();
const MIN = 60_000;

await test('模型视图将消息 epoch 转为 at/ago', () => {
  const compact = compactModelMessage({ seq: 7, sender: '小明', text: '在吗', time: NOW - 38 * MIN }, { now: NOW });
  assert.equal(compact.time, undefined);
  assert.equal(compact.ago, '38m');
  assert.equal(compact.at, '10:53');
  assert.equal(compact.text, '在吗');
});

await test('ago 单位为秒、分、时、天，未来时间显示 0s', () => {
  assert.equal(describeAge(NOW - 3000, NOW), '3s');
  assert.equal(describeAge(NOW - 59 * 1000, NOW), '59s');
  assert.equal(describeAge(NOW - 18 * MIN, NOW), '18m');
  assert.equal(describeAge(NOW - 5 * 60 * MIN, NOW), '5h');
  assert.equal(describeAge(NOW - 3 * 24 * 60 * MIN, NOW), '3d');
  assert.equal(describeAge(NOW + 5 * MIN, NOW), '0s');
});

await test('跨天消息在 at 中包含日期', () => {
  const compact = compactModelMessage({ text: '晚安', time: new Date(2026, 9, 16, 23, 40).getTime() }, { now: NOW });
  assert.equal(compact.at, '10-16 23:40');
  assert.equal(compact.ago, '1d');
});

await test('缺失时间或 0 时间保持原样', () => {
  assert.deepEqual(compactModelMessage({ text: '好', time: 0 }, { now: NOW }), { text: '好', time: 0 });
  assert.deepEqual(compactModelMessage({ text: '好' }, { now: NOW }), { text: '好' });
});

await test('同批消息与工具结果使用同一个 now', () => {
  const data = {
    messages: [
      { seq: 1, text: 'a', time: NOW - 70 * 1000 },
      { seq: 2, text: 'b', time: NOW - 10 * 1000 }
    ],
    newMessages: [{ seq: 4, text: 'y', time: NOW - 5 * MIN }]
  };
  const out = JSON.parse(serializeModelData(data, { now: NOW }));
  assert.equal(out.messages[0].ago, '1m');
  assert.equal(out.messages[1].ago, '10s');
  assert.equal(out.newMessages[0].ago, '5m');
  assert.equal(compactModelData(data, { now: NOW }).messages[1].ago, '10s');
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'} tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
