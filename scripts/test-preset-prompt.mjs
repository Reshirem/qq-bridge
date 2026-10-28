// 全局 desktop-agent 提示词改写（src/preset-prompt.js）的离线契约。
// 这些检查保证控制台保存不会破坏 YAML、丢失其它条目或改变提示词语义。
// 不连 DSH、不连 QQ、不写任何生产文件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';
import {
  PRESET_BLOCKING_SUBSTRINGS,
  PRESET_REQUIRED_MARKERS,
  extractPresetPrefix,
  locatePresetPromptBlock,
  presetBlockingSubstrings,
  presetPromptBlockers,
  presetPromptWarnings,
  renderPresetPromptYaml,
} from '../src/preset-prompt.js';

const PRESET_PATH = new URL('../dsh/agent-presets/desktop-agent/agent.cordis.yml', import.meta.url);
const source = fs.readFileSync(PRESET_PATH, 'utf8');
const originalPrefix = extractPresetPrefix(source);

// 运行时固定使用 desktop-agent，因此提示词校验只维护必要的渠道背景。
test('固定会话预设保留 QQ 渠道说明', () => {
  const prefix = extractPresetPrefix(source);
  assert.equal(typeof prefix, 'string', '应能抽出 persona.prefix');
  const blockers = presetPromptBlockers(prefix);
  assert.deepEqual(blockers, [], `固定预设不应有阻断项，实际：${blockers.join('；')}`);
  assert.deepEqual(presetBlockingSubstrings(), PRESET_BLOCKING_SUBSTRINGS);
});

test('真实预设能定位到 persona 的 prefix 块', () => {
  const loc = locatePresetPromptBlock(source);
  assert.ok(loc, '应能定位 prefix 块');
  assert.equal(loc.lines[loc.keyLine].trim(), 'prefix: >-');
  assert.ok(loc.blockEnd > loc.keyLine + 1, 'prefix 块应包含内容行');
  assert.ok(loc.entryEnd > loc.blockEnd, 'persona 条目应在 prefix 块之后还有内容');
});

test('抽出的是 YAML 解析后的真实字符串（折叠标量已展开）', () => {
  assert.equal(typeof originalPrefix, 'string');
  assert.ok(originalPrefix.length > 2000, `提示词应有实质内容，实际 ${originalPrefix.length} 字符`);
  for (const marker of PRESET_REQUIRED_MARKERS) {
    assert.ok(originalPrefix.includes(marker), `内置提示词应包含渠道说明：${marker}`);
  }
  assert.ok(originalPrefix.includes('{{model}}'), '应保留模板变量');
});

test('原样写回是幂等的，且不改变提示词语义', () => {
  const rewritten = renderPresetPromptYaml(source, originalPrefix);
  assert.equal(extractPresetPrefix(rewritten), originalPrefix, '读回应与原提示词逐字一致');
  // 再写一次仍稳定
  assert.equal(renderPresetPromptYaml(rewritten, originalPrefix), rewritten);
});

test('改写只动 prefix，其它条目与文件头注释原样保留', () => {
  const next = renderPresetPromptYaml(source, `${originalPrefix}\n\n【新增段落】测试内容。`);
  const before = yaml.load(source);
  const after = yaml.load(next);
  assert.deepEqual(after.map((row) => row.id), before.map((row) => row.id), '条目 id 顺序不变');
  for (const id of before.map((row) => row.id)) {
    if (id === 'persona') continue;
    assert.deepEqual(after.find((row) => row.id === id), before.find((row) => row.id === id), `条目 ${id} 不应被改动`);
  }
  assert.deepEqual(
    after.find((row) => row.id === 'persona').config.suffix,
    before.find((row) => row.id === 'persona').config.suffix,
    'persona 的 suffix 不应被改动',
  );
  // 文件头注释（前 6 行）必须原样保留
  assert.deepEqual(next.split('\n').slice(0, 6), source.split('\n').slice(0, 6), '文件头注释应保留');
  assert.ok(next.includes('prefix: |-'), '应使用字面量块写回');
});

test('特殊内容可安全往返（空行、缩进、Markdown、模板变量、CJK 标点）', () => {
  const tricky = [
    '# 标题',
    '',
    '- 列表项：含冒号: 和 # 井号',
    '    - 缩进 4 空格的子项',
    '',
    '```js',
    'const a = 1; // { 括号 } 也不能破坏 YAML',
    '```',
    '',
    '【中文段落】含全角标点：，。！？——以及 {{model}} / {{cwd}} 变量',
    '结尾不留多余空行',
  ].join('\n');
  // 必须在保留必要渠道说明的前提下追加特殊内容，否则会被阻断校验拦下
  const next = renderPresetPromptYaml(source, `${originalPrefix}\n\n${tricky}`);
  assert.equal(extractPresetPrefix(next), `${originalPrefix}\n\n${tricky}`);
  const rows = yaml.load(next);
  assert.equal(rows.length, yaml.load(source).length, '其它条目数量不变');
});

test('危险输入被拒绝，且不产生半截结果', () => {
  assert.throws(() => renderPresetPromptYaml(source, ''), /不能为空/);
  assert.throws(() => renderPresetPromptYaml(source, '   \n  \n'), /不能为空/);
  assert.throws(() => renderPresetPromptYaml(source, 'x'.repeat(200 * 1024)), /过长/);
  assert.throws(() => renderPresetPromptYaml('foo: bar\n', 'x'), /无法定位/);
  assert.throws(() => renderPresetPromptYaml('- id: other\n  config:\n    prefix: >-\n      x\n', 'x'), /无法定位/);
});

test('删掉必要的 QQ 渠道说明或正文过短时阻断保存', () => {
  // 正文过短
  assert.throws(() => renderPresetPromptYaml(source, '太短了'), /过短/);
  // 逐条移除渠道说明，必须被拦住
  for (const needle of PRESET_BLOCKING_SUBSTRINGS) {
    const tampered = originalPrefix.replace(needle, '（已删除）');
    assert.throws(
      () => renderPresetPromptYaml(source, tampered),
      new RegExp(`缺少 QQ 渠道说明「${needle}」`),
      `删除「${needle}」后仍被允许保存`,
    );
  }
  // 只做无损追加则应当通过
  assert.doesNotThrow(() => renderPresetPromptYaml(source, `${originalPrefix}\n\n【补充】一句新规则。`));
  const clean = presetPromptBlockers(originalPrefix);
  assert.deepEqual(clean, [], `内置提示词不应有阻断项，实际：${clean.join('；')}`);
});

test('写回沿用文件主导行尾，且不吞掉块尾空行', () => {
  const next = renderPresetPromptYaml(source, originalPrefix);
  const crlf = (next.match(/\r\n/g) ?? []).length;
  const lfOnly = (next.match(/\n/g) ?? []).length - crlf;
  assert.ok(crlf > 0, 'CRLF 文件写回后应仍使用 CRLF');
  assert.equal(lfOnly, 0, '写回后不应残留/新增 LF-only 行');
  assert.ok(next.includes('prefix: |-\r\n'), '新增行应使用 CRLF');
  // 块之后的内容（空行、注释、后续条目）必须逐字保留
  const before = locatePresetPromptBlock(source);
  const after = locatePresetPromptBlock(next);
  assert.deepEqual(
    next.split('\n').slice(after.blockEnd),
    source.split('\n').slice(before.blockEnd),
    'prefix 块之后的内容应逐字不变（含块尾空行与注释）',
  );
  assert.ok(source.split('\n').slice(before.blockEnd).some((l) => l.trim() === ''), '样本应确实包含块尾空行，否则该断言无意义');
});

test('只含空格/Tab 的行也能安全往返（不会被当成空行读丢）', () => {
  const spaced = [
    ...originalPrefix.split('\n').slice(0, 3),
    '   ',
    '\t',
    ' 带前后空格的正文 ',
    '正常一行',
  ].join('\n');
  // 前 3 行来自原文，因此 QQ 渠道说明仍然齐全
  const next = renderPresetPromptYaml(source, spaced);
  assert.equal(extractPresetPrefix(next), spaced, '空白行必须原样保留');
});

test('缺少 QQ 渠道背景时给出警告（但不阻断保存）', () => {
  assert.deepEqual(presetPromptWarnings(originalPrefix), [], '内置提示词不应有警告');
  const stripped = originalPrefix.replace(PRESET_REQUIRED_MARKERS[0], '');
  const warnings = presetPromptWarnings(stripped);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /会话与工具边界/);
  assert.ok(presetPromptWarnings('').some((w) => /内容为空/.test(w)));
});
