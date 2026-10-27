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
  assert.match(prefix, /\{\{model\}\}/);
  const used = [...JSON.stringify(persona.config).matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].filter((v) => !['provider', 'model'].includes(v)), []);
  assert.equal(Object.hasOwn(persona.config, 'text'), false);
  assert.match(prefix, /网页控制台任务和 QQ 提醒共用一个全局会话/);
  assert.match(prefix, /QQ 对话只是消息来源，不会为每个 QQ 对话单独建立 DSH 会话/);
});

test('global rest and recovery behavior is clear in the persona', () => {
  assert.match(prefix, /每个活动回合结束前，都必须把 `agent_rest` 作为最后一个工具调用/);
  assert.match(prefix, /范围为 1 秒至 12 小时/);
  assert.match(prefix, /有效 QQ 提醒也可以提前结束休息并启动一轮/);
  assert.match(prefix, /休息期间不会运行异常回合的指数恢复重试/);
  assert.match(prefix, /有限休息到期后会启动一个新回合/);
  assert.match(prefix, /按指数间隔尝试恢复，最长间隔为 30 分钟/);
  assert.match(prefix, /不要设置周期性模型心跳，也不要反复轮询/);
});

test('QQ is an on-demand source with metadata-only attention signals', () => {
  assert.match(prefix, /SnowLuma 是 QQ 消息通道/);
  assert.match(prefix, /完整的 SnowLuma MCP 工具集/);
  assert.match(prefix, /想了解账号可用的群和好友时，可以使用 `qq_list_conversations`/);
  assert.match(prefix, /新的 QQ 事件只会作为包含元数据的提醒到达/);
  assert.match(prefix, /不要自动读取每段对话/);
  assert.match(prefix, /qq_wait_for_messages/);
  assert.match(prefix, /QQ 对话只是消息来源，不会为每个 QQ 对话单独建立 DSH 会话/);
});

test('desktop and protected-app boundaries remain explicit', () => {
  assert.match(prefix, /让用户优先使用电脑/);
  assert.match(prefix, /受保护的项目与运行时应用/);
  for (const app of ['ChatGPT', 'DeepSeek Harness（DSH）', 'qq-bridge', 'SnowLuma']) {
    assert.ok(prefix.includes(app), `protected app boundary must name ${app}`);
  }
});

test('preset keeps the global tool guard and compaction settings', () => {
  assert.deepEqual(preset.map((row) => row.id), [
    'persona', 'tool-web', 'tool-ask-user', 'tool-todo', 'qq-tool-restrict', 'compaction',
  ]);
  assert.deepEqual(preset.find((row) => row.id === 'tool-web').config, { search: false, fetch: false });
  assert.equal(preset.find((row) => row.id === 'qq-tool-restrict').name, './qq-tool-restrict.mjs');
  const compaction = preset.find((row) => row.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.find((row) => row.id === 'tool-result-pruner').config, {
    thresholdChars: 50000, headChars: 45000, tailChars: 2000,
  });
});

console.log(`desktop-agent persona prefix: ${prefix.length} characters`);
