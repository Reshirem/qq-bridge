// Static contract for the single global desktop-agent preset and its QQ capabilities.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const preset = yaml.load(fs.readFileSync(
  new URL('../dsh/agent-presets/desktop-agent/agent.cordis.yml', import.meta.url), 'utf8'),
);
const persona = preset.find((row) => row.id === 'persona');
const prefix = persona?.config?.prefix ?? '';

test('desktop-agent is the only session persona and preserves registered template variables', () => {
  assert.equal(persona?.name, '@deepseek-ai/dsh-persona');
  const used = [...JSON.stringify(persona.config).matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].filter((v) => !['provider', 'model'].includes(v)), []);
  assert.ok(!prefix.includes('{{cwd}}'), 'the removed DSH cwd variable must stay out of the prompt');
  assert.equal(Object.hasOwn(persona.config, 'text'), false);
});

test('activity turns end through the rest tool', () => {
  assert.match(prefix, /每个活动回合都必须以 `agent_rest` 作为最后一个工具调用/);
  assert.match(prefix, /调用后结束本轮，不再调用其他工具/);
});

test('QQ reminders are optional cues rather than required tasks', () => {
  assert.match(prefix, /SnowLuma 是 QQ 消息通道/);
  assert.match(prefix, /提醒，只是在告诉你可能有人找你或有新内容值得留意/);
  assert.match(prefix, /它们不要求你逐条回应/);
  assert.match(prefix, /你可以根据内容和时机判断是否查看、回应或暂时不处理/);
  assert.match(prefix, /qq_wait_for_messages/);
});

test('desktop and protected-app boundaries remain explicit', () => {
  assert.match(prefix, /尊重卡片对年龄称谓、关系和世界观的说明/);
  assert.match(prefix, /非人设定不自动套用现实人类的判断标准/);
  assert.ok(!prefix.includes('例如卡片若说明「幼崽」'), '固定前缀保持通用，不重复具体角色卡的例子');
  assert.match(prefix, /让用户优先使用电脑/);
  assert.match(prefix, /受保护的项目与运行时应用/);
  for (const app of ['ChatGPT', 'DeepSeek Harness（DSH）', 'qq-bridge', 'SnowLuma']) {
    assert.ok(prefix.includes(app), `protected app boundary must name ${app}`);
  }
});

test('preset keeps the global tool guard and compaction settings', () => {
  assert.deepEqual(preset.map((row) => row.id), [
    'persona', 'tool-web', 'qq-tool-restrict', 'compaction',
  ]);
  assert.equal(preset.some((row) => ['tool-ask-user', 'tool-todo'].includes(row.id)), false);
  assert.deepEqual(preset.find((row) => row.id === 'tool-web').config, { search: false, fetch: false });
  assert.equal(preset.find((row) => row.id === 'qq-tool-restrict').name, './qq-tool-restrict.mjs');
  const compaction = preset.find((row) => row.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.find((row) => row.id === 'tool-result-pruner').config, {
    thresholdChars: 50000, headChars: 45000, tailChars: 2000,
  });
});

console.log(`desktop-agent persona prefix: ${prefix.length} characters`);
