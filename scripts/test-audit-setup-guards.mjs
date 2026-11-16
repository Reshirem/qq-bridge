// Execute both real preset plugins against a captured tools service, without DSH/QQ.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Startup keeps its portable batch encoding and no longer changes file ACLs.
import fs from 'node:fs';
{
  const bat = fs.readFileSync(path.join(root, 'start.bat'));
  const batText = bat.toString('latin1');
  const nonAscii = [...bat].filter((b) => b > 127).length;
  assert.equal(nonAscii, 0, 'start.bat 必须保持纯 ASCII（否则非 UTF-8 控制台会乱码）');
  assert.equal(batText.match(/(?<!\r)\n/g)?.length ?? 0, 0, 'start.bat 必须使用 CRLF');
  assert.ok(batText.includes('node src/bridge.js'), 'start.bat 必须继续启动桥接');
  const bridge = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  for (const source of [batText, bridge]) {
    assert.doesNotMatch(source, /state-acl|hardenStateDirAcl|hardenFile|icacls|\bRunAs\b/, '启动和配置写入不应修改 ACL 或提权');
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(pkg.scripts, 'harden-acl'), false);
  assert.equal(Object.hasOwn(pkg.scripts, 'diagnose:acl'), false);
  console.log('startup: ASCII/CRLF batch launches the bridge without ACL mutation or elevation');
}

// ── 合规不变量 L6：本程序**只探测、不部署** SnowLuma ────────────────────────────────
// 依据：SnowLuma EULA §5.4（中文为准）
//   「除事先取得著作权人的书面授权外……不得复制、修改、单独再分发或再许可该组件。
//     将其并入第三方安装包或 Docker 镜像、**通过自动化脚本部署**，或者将其用于任何商业用途，
//     均须事先取得书面授权。」
// 2026-09-20：`start_snowluma` / `stop_snowluma` 与 `snowluma.allowProcessControl` 已整体移除。
// 这条测试**防止它们（或同类能力）被无意加回来**——本项目唯一一条"删掉的功能不许复活"的约束。
{
  const host = fs.readFileSync(path.join(root, 'src/mcp-qq.js'), 'utf8');
  // ① 代码里不得再出现进程启停原语（注释中为记录原因可以提，故先剔掉纯注释行）
  const code = host.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  for (const bad of ['spawn(', 'taskkill', 'execFileSync', 'child_process']) {
    assert.ok(!code.includes(bad), `mcp-qq.js 不得再出现「${bad}」（违反 EULA §5.4 的 L6 不变量）`);
  }
  // ② 不得再注册这两个工具
  for (const tool of ['start_snowluma', 'stop_snowluma']) {
    assert.ok(!host.includes(`'${tool}'`), `不得再注册 ${tool}（EULA §5.4）`);
  }
  // ③ 配置项不得复活（代码与模板两侧都查）
  assert.ok(!code.includes('allowProcessControl'), 'mcp-qq.js 不得再读取 allowProcessControl');
  const example = fs.readFileSync(path.join(root, 'config.example.json'), 'utf8');
  assert.ok(!example.includes('allowProcessControl'), 'config.example.json 不得再提供 allowProcessControl');
  // ④ 两种后端共用只读状态工具。
  assert.ok(host.includes("'qq_status'"), 'qq_status（只读探活）必须保留');
  // ⑤ 包元数据必须声明许可证（独立复核发现此前缺失）
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT', 'package.json 必须声明 license 字段');
  console.log('L6 compliance: no SnowLuma process control, no allowProcessControl, license declared');
}
