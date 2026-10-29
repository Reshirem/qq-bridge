// setup-dsh.mjs 幂等性测试：在一个临时 DSH_HOME 里连跑两次，
// 断言不会产生重复的 MCP 条目 id（DSH 遇到重复 loader entry id 会启动崩溃）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dshModulesDir } from './dsh-modules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 夹具放系统临时目录，**不要**放仓库的 state/：harden-state-acl.mjs 会把 state/ 的
// 继承 ACE 去掉（只留当前用户 / SYSTEM / Administrators），于是 DSH 沙箱的能力 SID
// 不在 ACL 里，在沙箱内跑这个测试会直接 EPERM 建目录。
const tmpHome = path.join(os.tmpdir(), 'qq-bridge-setup-test-home');
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, 'profiles', 'web'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'plugins'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, 'profiles', 'web', 'cordis.patch.yml'), '# profile patch\n', 'utf8');
fs.writeFileSync(path.join(tmpHome, 'profiles', 'web', 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: { 'dsh-approval-toast': 'file:C:/x/dsh-approval-toast' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-approval-toast'] } },
}, null, 2), 'utf8');

function runSetup(label) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup-dsh.mjs'), 'web'], {
    // 保留最小 PATH（进程启动需要），但把 dsh CLI 排除在外 → 跳过自动 pnpm 安装那一步
    env: { ...process.env, DSH_HOME: tmpHome, PATH: path.dirname(process.execPath) },
    encoding: 'utf8',
    cwd: ROOT,
  });
  console.log(`\n--- ${label} (exit=${r.status}${r.error ? ' err=' + r.error.message : ''}) ---`);
  console.log((r.stdout || '').trim() || '(no stdout)');
  if (r.stderr?.trim()) console.log('STDERR:', r.stderr.trim());
  return r;
}

runSetup('第 1 次运行');
runSetup('第 2 次运行');

const finalPatch = fs.readFileSync(path.join(tmpHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');

// 断言 1：每个托管 id 恰好出现一次
let failed = 0;
for (const id of ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe']) {
  const n = finalPatch.split('\n').filter((l) => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`).test(l)).length;
  const ok = n === 1;
  if (!ok) failed += 1;
  console.log(`${ok ? '✅' : '❌'} id ${id} 出现 ${n} 次（期望 1）`);
}

// YAML 可解析且顶层是数组
const YAML = await import(pathToFileURL(path.join(dshModulesDir(), 'js-yaml/index.js')).href);
const yaml = YAML.default ?? YAML;
let doc;
try { doc = yaml.load(finalPatch); } catch (e) {
  console.log(`❌ YAML 解析失败: ${e.message}`); failed += 1;
}
if (doc) {
  const ok = Array.isArray(doc);
  console.log(`${ok ? '✅' : '❌'} YAML 顶层为数组（${Array.isArray(doc) ? doc.length + ' 项' : typeof doc}）`);
  if (!ok) failed += 1;
  const ids = doc.filter((e) => e?.insert).flatMap((e) => e.insert.map((x) => x.id));
  console.log(`   解析出的 MCP id: ${ids.join(', ')}`);
}

// profile package.json 含当前 bundle，且保留其他 bundle
const pkg = JSON.parse(fs.readFileSync(path.join(tmpHome, 'profiles', 'web', 'package.json'), 'utf8'));
const bundles = pkg.dsh.profile.bundles;
const okBundle = bundles.includes('qq-agent-presets') && bundles.includes('dsh-approval-toast');
console.log(`${okBundle ? '✅' : '❌'} profile bundles 正确: ${bundles.join(', ')}`);
if (!okBundle) failed += 1;
const depOk = String(pkg.dependencies['qq-agent-presets'] ?? '').startsWith('link:')
  && String(pkg.dependencies['dsh-approval-toast']).startsWith('file:');
console.log(`${depOk ? '✅' : '❌'} qq-agent-presets link 依赖已登记`);
if (!depOk) failed += 1;

// Preset is installed through the current bundle patch.
for (const p of ['desktop-agent']) {
  const patchFile = path.join(ROOT, 'plugins', 'qq-agent-presets', 'presets', `${p}.patch.yml`);
  const text = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  const ok = text.includes('@deepseek-ai/dsh-agent-preset') && new RegExp(`^\\s+id: ${p}$`, 'm').test(text);
  console.log(`${ok ? '✅' : '❌'} preset ${p} 的 patch 层就绪（含 @deepseek-ai/dsh-agent-preset 行 + config.id）`);
  if (!ok) failed += 1;
}
console.log(failed === 0 ? '\n✅ setup-dsh.mjs 幂等性测试通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
