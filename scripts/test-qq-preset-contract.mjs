// 固定自主 QQ 会话提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。
// 这些检查只能防止关键协议/能力被误删，不能证明聊天质量无损。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const preset = yaml.load(fs.readFileSync(
  new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8',
));
const persona = preset.find((row) => row.id === 'persona');
const prefix = persona?.config?.prefix ?? '';

test('qq-chat-v2 YAML resolves to the fixed session persona and template variables', () => {
  assert.equal(persona?.name, '@deepseek-ai/dsh-persona');
  assert.match(prefix, /\{\{model\}\}/);
  // DSH 0.2.1 起 agent loop 只注册 provider / model 两个提示词变量（0.2.0 还有 cwd），
  // 未知变量会让 system prompt 装配直接抛错 ⇒ 每回合 error、模型一次都不跑。
  // 这里钉住「只用已注册变量」，而不只是「有 {{model}}」。
  const used = [...JSON.stringify(persona.config).matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].filter((v) => !['provider', 'model'].includes(v)), []);
  assert.equal(Object.hasOwn(persona.config, 'text'), false);
});

test('local/admin tool restrictions and existing compaction budgets stay intact', () => {
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
  for (const text of ['你没有本地工具', '群友没有管理权限', 'API 令牌', '角色由桥接注入']) {
    assert.ok(prefix.includes(text), `missing safety rule: ${text}`);
  }
});

test('wake snapshots contain only a direct trigger and partial unread pages remain explicit', () => {
  assert.match(prefix, /快照才会自动附带那一条直接触发消息，不包含其它未读或最近历史/);
  assert.match(prefix, /普通群消息只缓存在桥接，不会自动唤醒/);
  assert.match(prefix, /partial=true 时按后续页返回的 readThroughSeq 继续/);
  assert.match(prefix, /readThroughSeq 是桥接本地的 seq，不是 QQ messageId/);
  assert.match(prefix, /首次进入会话、角色变化[^。]*qq_get_prompt/);
});

test('read acknowledgements use only an observed watermark without a pre-sleep gate', () => {
  assert.match(prefix, /qq_mark_read\(throughSeq=已读水位\)/);
  assert.match(prefix, /qq_set_wake_config\(config=新配置, throughSeq=已读水位\)/);
  assert.match(prefix, /没有水位时省略 throughSeq/);
  assert.doesNotMatch(prefix, /preSleepWait|沉睡前观察|5 分钟观察/);
});

test('reply quiet checks and active message waits are separate agent-directed choices', () => {
  assert.match(prefix, /【首答前】[^\n]*qq_wait_for_messages\(purpose="reply", quietMs=10000\)/);
  assert.match(prefix, /读取和思考花掉的时间也算，已安静足够就立即返回/);
  assert.match(prefix, /不要再重开一次普通长等待/);
  assert.match(prefix, /【等下文】[^\n]*purpose="messages", timeoutMs=60000~120000/);
  assert.match(prefix, /【回复后】[^\n]*qq_wait_for_messages\(purpose="messages"\)/);
  assert.match(prefix, /没有新的行动就不要启动周期性模型回合/);
  assert.doesNotMatch(prefix, /preSleepWaitRemainingMs|短静默不算沉睡前观察/);
});

test('social autonomy and visual, forwarding, sticker and web capabilities remain described', () => {
  for (const text of [
    '【反 AI 味：拒绝有求必应】', '【保持主体性】', '【学习群友策略】',
    '【不要当群管家/主持人】', '普通对话默认 1 条，最多 2 条', '不要用空格断句',
    '不会自动发送到 QQ', 'qq_get_message_images', 'qq_get_forward_msg', 'nestedForwardIds',
    'qq_send_poke', 'qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker',
    'qq_collect_sticker', 'qq_sticker_note', 'qq_get_self_image',
    'qq_set_sticker_remark', '只有管理端明确开启后才能用',
    'qq_list_voices', 'qq_send_voice', 'verified=true 才代表这条语音确实落地',
    '语音**默认是关闭的**', '不要假装发了语音',
    'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
  ]) assert.ok(prefix.includes(text), `missing capability or voice rule: ${text}`);
});

test('autonomy limits, fixed wake reasons and on-demand sleep remain described', () => {
  for (const text of [
    '群聊仅真实 @ 本人或经过验证的回复你会自动开启回合',
    '私聊消息会开启回合',
    '没有周期性模型心跳',
    '设置一次性睡眠',
    '不要用 [SILENT]',
    // 记忆面
    '【记忆卫生】', 'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear',
    // 黑话面
    'qq_slang_query', 'qq_slang_submit', '不重复提交',
    // 频率上限
    '普通闲聊约 3~5 轮一张', '别刷屏', '每条只能一张，不能附带文字', '当前回合确有理由时使用',
    // 会话令牌是硬前置，漏传会被拒绝。
    '作为 token 参数传入',
  ]) assert.ok(prefix.includes(text), `missing rule: ${text}`);
  assert.doesNotMatch(prefix, /triggers\.speakerIds|preSleepWait/);
});

console.log(`qq-chat-v2 persona prefix: ${prefix.length} characters (not a model-token estimate)`);
