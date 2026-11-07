#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installFile, moduleDir, pythonFile, callCli } from '../plugins/qq-agent-presets/maa-agent.mjs';

const usage = 'node scripts/maa-agent.mjs install [--source <Maa-Agent 源码目录>] [--python <Python 可执行文件>]\nnode scripts/maa-agent.mjs status | doctor | disable';
const disabledFile = path.join(moduleDir, 'disabled.json');
const navigationPatch = fileURLToPath(new URL('./maa-agent-navigation.patch', import.meta.url));
function run(command, args, cwd) {
  const p = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (p.error) throw p.error;
  if (p.status !== 0) throw new Error('安装步骤失败，退出码 ' + p.status);
}

function findPython(explicit) {
  const candidates = explicit ? [[explicit]] : process.platform === 'win32'
    ? [['py', '-3'], ['python'], [path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe')]]
    : [['python3'], ['python']];
  for (const [command, ...prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '-c', 'import sys, venv; sys.exit(sys.version_info < (3, 11))'], { windowsHide: true, timeout: 10000 });
    if (probe.status === 0) return [command, ...prefix];
  }
  throw new Error('需要 Python 3.11+，可使用 --python 指定解释器。');
}

function installNavigation(source) {
  const options = { cwd: source, windowsHide: true, stdio: 'ignore' };
  if (spawnSync('git', ['apply', '--reverse', '--check', navigationPatch], options).status === 0) return;
  if (spawnSync('git', ['apply', '--check', navigationPatch], options).status === 0) {
    run('git', ['apply', navigationPatch], source);
    console.log('已为 Maa-Agent 源码安装首页任务与主线导航支持。');
  } else {
    console.warn('当前 Maa-Agent 源码与导航补丁有差异，保留现有实现。请用 Maa-Agent 的 --help 确认 missions 和 stage 能力。');
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    source: { type: 'string' }, python: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) { console.log(usage); return; }
  if (positionals.length !== 1) throw new Error(usage);
  const [operation] = positionals;
  if (operation === 'disable') {
    if (fs.existsSync(installFile)) fs.renameSync(installFile, disabledFile);
    console.log('已禁用角色的游戏工具。重启 DSH 后原会话的工具列表会更新。已启动的游戏作业仍由 Maa-Agent 管理。');
    return;
  }
  if (operation === 'status') {
    console.log(fs.existsSync(installFile) ? fs.readFileSync(installFile, 'utf8') : 'Maa-Agent 可选模块未启用。');
    return;
  }
  if (operation === 'doctor') {
    if (!fs.existsSync(installFile)) throw new Error('请先安装 Maa-Agent 可选模块。');
    const result = await callCli(JSON.parse(fs.readFileSync(installFile, 'utf8')), ['doctor']);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (operation !== 'install') throw new Error(usage);
  const previousFile = fs.existsSync(installFile) ? installFile : disabledFile;
  const previous = fs.existsSync(previousFile) ? JSON.parse(fs.readFileSync(previousFile, 'utf8')) : {};
  const location = path.resolve(values.source || previous.source || fileURLToPath(new URL('../../Maa-Agent/', import.meta.url)));
  if (!fs.existsSync(path.join(location, 'maa_agent', 'cli.py')) || !fs.existsSync(path.join(location, 'pyproject.toml'))) {
    throw new Error('请用 --source 指定已克隆的 TURLEing/Maa-Agent 源码目录。');
  }
  const source = fs.realpathSync(location);
  installNavigation(source);
  fs.mkdirSync(moduleDir, { recursive: true });
  if (!fs.existsSync(pythonFile)) {
    const [python, ...prefix] = findPython(values.python);
    run(python, [...prefix, '-m', 'venv', path.join(moduleDir, 'venv')], source);
  }
  run(pythonFile, ['-m', 'pip', 'install', '-e', source], source);
  run(pythonFile, ['-c', 'import maa_agent.cli, maa.library, PIL.Image'], source);
  const environment = {};
  for (const key of ['MAA_AGENT_CLI', 'MAA_AGENT_PROFILE', 'MAA_AGENT_CONFIG_DIR', 'MAA_AGENT_DATA_DIR', 'MAA_CONFIG_DIR', 'MAA_DATA_DIR']) {
    const value = process.env[key] ?? previous.environment?.[key];
    if (value) environment[key] = value;
  }
  const runtime = path.resolve(source, process.env.MAA_AGENT_RUNTIME_DIR || (source === previous.source && previous.runtime) || '.runtime');
  const installation = { source, runtime, environment };
  fs.mkdirSync(path.join(moduleDir, 'copilots'), { recursive: true });
  const temp = installFile + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(installation, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temp, installFile);
  } finally { fs.rmSync(temp, { force: true }); }
  console.log('Maa-Agent 已安装。运行 node scripts/maa-agent.mjs doctor 检查设备，重启 DSH 后原会话即可加载新工具。');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
