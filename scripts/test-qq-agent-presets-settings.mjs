// qq-agent-presets 设置与 system prompt 变量的离线注册期检验。
//
// 钉住的东西（这些是 `qq-agent-presets` 命名空间提供 ownerQQ 设置的前提，缺一即失败）：
//   ① entry id 恰好等于命名空间名（在 owner-settings.patch.yml 里，不是插件模块里）；
//   ② 插件模块导出 `Config`，且它是可用的 schemastery schema；
//   ③ `Config` 至少有一个带 `volatile` 标记的字段（否则 settings 写入会抛
//      "Plugin entry ... has no volatile fields"）；
//   ④ 插件不调用未提供的 settings.register()；命名空间来自 bundle entry 与 Config。
//   ⑤ systemPrompt 服务注册当前人格卡变量；provider 的读卡行为另有隔离测试。
//
// 不接触真实 DSH 进程；在线设置检查由 scripts/verify-dsh-current.mjs 覆盖。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'qq-agent-presets');
const NS = 'qq-agent-presets';

const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib', 'index.js')).href);
const patchText = fs.readFileSync(path.join(PLUGIN_DIR, 'owner-settings.patch.yml'), 'utf8');
const source = fs.readFileSync(path.join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');

test('插件导出 name / inject / Config / apply', () => {
  assert.equal(mod.name, 'qq-agent-presets');
  assert.ok(mod.inject.includes('settings'), '必须依赖 settings，以注册设置命名空间');
  assert.ok(mod.inject.includes('systemPrompt'), '必须依赖 systemPrompt，以注册人格卡变量');
  assert.equal(new Set(mod.inject).size, mod.inject.length, '服务依赖不能重复');
  assert.ok(mod.Config, '必须导出 Config 作为命名空间的 schema');
  assert.equal(typeof mod.apply, 'function');
});

test('owner-settings.patch.yml 的 entry id 恰好等于命名空间名', () => {
  const patch = yaml.load(patchText);
  const entries = patch.flatMap((row) => row.insert ?? []).filter((entry) => entry.id === NS);
  assert.equal(entries.length, 1, '应恰好有一个与命名空间同名的条目');
  assert.equal(entries[0].name, NS, '条目应加载实际的 qq-agent-presets 插件');
});

test('Config is a usable schemastery schema with only volatile ownerQQ', () => {
  const resolved = mod.Config({ ownerQQ: '12345' });
  assert.equal(typeof resolved.ownerQQ?.get, 'function', 'volatile 字段必须提供读取方法');
  assert.equal(resolved.ownerQQ.get(), '12345');
  assert.equal(mod.Config({ ownerQQ: '' }).ownerQQ.get(), '');
  assert.equal(mod.Config({}).ownerQQ.get(), undefined);

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

test('插件使用当前 settings 契约', () => {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(
    !/settings\s*\.\s*register\s*\(/.test(code),
    '插件不应调用 settings.register()；命名空间由 entry id 与导出的 Config 推导。',
  );
  // configure() 也要谨慎：auto:false 会关掉自动设置页策略，与默认行为相反。
  assert.ok(!/settings\s*\.\s*configure\s*\(/.test(code), 'apply 不应调用 settings.configure()');
});

test('apply 注册可调用的人格卡变量', () => {
  const variables = [];
  const systemPrompt = { variable: (name, provider) => variables.push({ name, provider }) };
  // settings 是声明的依赖，但 apply 不直接访问它；不要用缺少 systemPrompt 的假上下文模拟 DSH。
  mod.apply({ systemPrompt });
  assert.equal(variables.length, 1);
  assert.equal(variables[0].name, 'qq_bridge_active_role_card');
  assert.equal(typeof variables[0].provider, 'function');
});
