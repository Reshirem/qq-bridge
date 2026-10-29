// qq-agent-presets bundle 内管理员设置插件的登记期静态检验。
//
// 钉住的东西（这些是 `qq-agent-presets` 命名空间提供 ownerQQ 设置的前提，缺一即失败）：
//   ① entry id 恰好等于命名空间名（在 owner-settings.patch.yml 里，不是插件模块里）；
//   ② 插件模块导出 `Config`，且它是可用的 schemastery schema；
//   ③ `Config` 至少有一个带 `volatile` 标记的字段（否则 settings 写入会抛
//      "Plugin entry ... has no volatile fields"）；
//   ④ 插件不调用未提供的 settings.register()；命名空间来自 bundle entry 与 Config。
//
// 不接触真实 DSH 进程；在线设置检查由 scripts/verify-dsh-current.mjs 覆盖。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'qq-agent-presets');
const NS = 'qq-agent-presets';

const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib', 'index.js')).href);
const patchText = fs.readFileSync(path.join(PLUGIN_DIR, 'owner-settings.patch.yml'), 'utf8');
const source = fs.readFileSync(path.join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');

test('插件导出 name / inject / Config / apply', () => {
  assert.equal(mod.name, 'qq-agent-presets');
  assert.deepEqual(mod.inject, ['settings'], 'inject 必须声明 settings，命名空间才随 settings seam 就绪');
  assert.ok(mod.Config, '必须导出 Config 作为命名空间的 schema');
  assert.equal(typeof mod.apply, 'function');
});

test('owner-settings.patch.yml 的 entry id 恰好等于命名空间名', () => {
  // ① 是三点契约里最容易写错的一条：id 必须与 settings 命名空间一致。
  const ids = [...patchText.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(ids.includes(NS), `patch 里应有 id: ${NS}，实际 ${ids.join(', ')}`);
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

test('apply 在缺少 settings 服务时也不抛（静默降级）', () => {
  assert.doesNotThrow(() => mod.apply({}), 'apply 必须容忍没有 ctx.settings 的环境');
});
