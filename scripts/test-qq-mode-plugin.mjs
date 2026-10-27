// qq-mode-console 插件的登记期静态检验。
//
// 钉住的东西（这些是 `qq-mode` 兼容命名空间提供 ownerQQ 设置的前提，缺一即失败）：
//   ① entry id 恰好等于命名空间名（在 cordis.patch.yml 里，不是插件模块里）；
//   ② 插件模块导出 `Config`，且它是可用的 schemastery schema；
//   ③ `Config` 至少有一个带 `volatile` 标记的字段（否则 settings 写入会抛
//      "Plugin entry ... has no volatile fields"）；
//   ④ 插件**不再**调用 0.2.0 已删除的 `ctx.settings.register()`。
//
// 为什么第 ④ 条要断言：0.1.x 的 `register(ns, schema, {base, applies})` 是当时的
// 注册路径，0.2.0 把它整条删掉了（命名空间改为从 loader entry 推导）。
// 旧代码在 0.2.0 下会被早退挡住而不报错，**看起来一切正常**——所以只有静态断言
// 能防止有人照着旧注释把那条死路加回来（一旦加回，日志就会开始说谎）。
//
// 不接触真实 DSH 进程；活 DSH 上由 scripts/verify-dsh-021-adaptation.mjs 检查命名空间
// 是否列出 ownerQQ，并由 scripts/probe-020-settings.mjs 验证其写入路径。运行模式不属于该命名空间。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'qq-mode-console');
const NS = 'qq-mode';

const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib', 'index.js')).href);
const patchText = fs.readFileSync(path.join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8');
const source = fs.readFileSync(path.join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');

test('插件导出 name / inject / Config / apply', () => {
  assert.equal(mod.name, 'qq-mode-console');
  assert.deepEqual(mod.inject, ['settings'], 'inject 必须声明 settings，命名空间才随 settings seam 就绪');
  assert.ok(mod.Config, '必须导出 Config —— 0.2.0 里这就是命名空间的 schema 来源');
  assert.equal(typeof mod.apply, 'function');
});

test('cordis.patch.yml 的 entry id 恰好等于命名空间名', () => {
  // ① 是三点契约里最容易写错的一条：id 写成插件包名（qq-mode-console）会让
  //    settings 定位失败并抛 No configurable plugin entry "qq-mode"。
  const ids = [...patchText.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(ids.includes(NS), `patch 里应有 id: ${NS}，实际 ${ids.join(', ')}`);
  assert.ok(!ids.includes('qq-mode-console'), 'entry id 不应是插件包名');
});

test('Config is a usable schemastery schema with only volatile ownerQQ', () => {
  const resolved = mod.Config({ ownerQQ: '12345' });
  assert.equal(resolved.ownerQQ, '12345');

  const json = mod.Config.toJSON();
  const refs = json.refs ?? {};
  const root = refs[String(json.uid)] ?? json;
  const fields = Object.keys(root.dict ?? {});
  assert.deepEqual(fields, ['ownerQQ'], 'the settings schema must not expose a runtime mode selector');
  const volatileFields = [];
  for (const [key, node] of Object.entries(root.dict ?? {})) {
    if (refs[String(node)]?.meta?.volatile === true) volatileFields.push(key);
  }
  assert.deepEqual(volatileFields, ['ownerQQ']);
});

test('不再调用 0.2.0 已删除的 ctx.settings.register', () => {
  // 只看可执行代码：注释里会提到 register 做历史说明。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(
    !/settings\s*\.\s*register\s*\(/.test(code),
    'ctx.settings.register() 在 DSH 0.2.0 已不存在：调用它会让 apply 抛 TypeError。'
    + '命名空间由 entry id + 导出的 Config 推导，无需注册。',
  );
  // configure() 也要谨慎：auto:false 会关掉自动设置页策略，与默认行为相反。
  assert.ok(!/settings\s*\.\s*configure\s*\(/.test(code), 'apply 不应调用 settings.configure()');
});

test('apply 在缺少 settings 服务时也不抛（静默降级）', () => {
  assert.doesNotThrow(() => mod.apply({}), 'apply 必须容忍没有 ctx.settings 的环境');
});
