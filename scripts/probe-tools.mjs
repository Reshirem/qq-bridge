// Inspect the loaded DSH profile and the bound character's latest QQ tool receipt.
import fs from 'node:fs';
import { discoverDshBaseUrl } from '../src/dsh-client.js';
import { probeCookie, probeRpc } from './probe-auth.mjs';

const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8').replace(/^\uFEFF/, '');
const config = JSON.parse(read('config.json'));
const { baseUrl } = await discoverDshBaseUrl(process.env.DSH_BASE_URL || config.dsh?.baseUrl, {
  enabled: !process.env.DSH_BASE_URL,
});
const rpc = probeRpc(probeCookie({ base: baseUrl }), { base: baseUrl });
const inventory = await rpc('pluginManager/listPlugins', {});
if (!inventory?.ok) throw Error(inventory?.error?.message || '读取 DSH 插件清单失败');
const ids = inventory.value.filter(row => row.moduleName === '@deepseek-ai/dsh-mcp-client')
  .map(row => row.patchId || row.entryId.split(':').at(-1));
if (!ids.includes('mcp-qq') || ids.some(id => ['mcp-snowluma', 'mcp-snowluma-host'].includes(id))) {
  throw Error('DSH 尚未完成 QQ 工具迁移，已加载的 MCP 条目：' + ids.join(', '));
}
console.log('DSH 已注册 mcp__qq__*');

const sessionId = JSON.parse(read('state/desktop-agent.json')).sessionId;
const configured = String(config.consoleToken || '').trim();
const token = /^[A-Za-z0-9_-]{16,128}$/.test(configured) ? configured : read('state/console-token').trim();
const res = await fetch('http://127.0.0.1:' + (config.consolePort || 3100) + '/api/socialV2/tool-log?limit=500', {
  headers: { 'x-console-token': token }, signal: AbortSignal.timeout(5000),
});
if (!res.ok) throw Error('读取桥接工具日志失败，HTTP ' + res.status);
const { entries } = await res.json();
const latest = entries.findLast(row => row.sessionId === sessionId && row.type === 'result' && row.tool?.startsWith('mcp__qq__'));
if (!latest) {
  console.log('当前角色最近的工具记录中尚无新前缀的执行回执');
  process.exitCode = 2;
} else {
  console.log(latest.time, latest.tool, latest.ok ? '成功' : '失败');
  if (!latest.ok) process.exitCode = 1;
}
