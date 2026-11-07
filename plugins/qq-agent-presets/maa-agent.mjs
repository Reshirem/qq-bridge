import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const moduleDir = fileURLToPath(new URL('../../state/maa-agent/', import.meta.url));
export const installFile = path.join(moduleDir, 'install.json');
const catalogDir = path.join(moduleDir, 'copilots');
const pythonRelative = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
export const pythonFile = path.join(moduleDir, 'venv', pythonRelative);
export const name = 'qq-maa-agent';
export const inject = ['tools'];

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const kills = { type: 'integer', description: '剿灭目标击杀数，默认 400' };
const withImage = { ...boolean, description: '附上游戏截图，视觉模型可按需开启' };
const stage = { ...string, description: '关卡显示名，例如 H8-1' };

const tools = {
  maa_cli: ['直接调用已安装的 Maa-Agent CLI。例如 ["missions"] 打开日常、周常任务页，["home"] 回首页，["--help"] 列出命令。', { args: { type: 'array', items: string } }, ['args']],
  maa_doctor: ['检查 Maa-Agent、maa-cli、Core 资源和 ADB 连接。', {}],
  maa_observe: ['观察明日方舟当前页面、关卡和识别结果。可选附图。', { withImage }],
  maa_copilots: ['列出本机 copilots 目录中的作业，包含文件路径和可识别的游戏关卡。stage 为空时可从游戏准备页确认。', {}],
  maa_stage: ['打开关卡并停在作战准备页。主线可从首页或终端出发，活动关从对应章节地图出发。检查 stage_verified。剿灭使用 annihilation=true。', { stage, annihilation: boolean }, ['stage']],
  maa_run_copilot: ['按作业路径运行，主线可从首页或终端自动选关。第 4 编队会被改写，可能消耗理智。返回 run_id 后用 maa_poll 跟进同一场。', { stage, file: { ...string, description: '本地作业的绝对路径，或 maa_copilots 返回的文件名或相对路径' }, expectedKills: kills }, ['stage', 'file']],
  maa_poll: ['查询一次作业的 executor、game_result 和结算证据。省略 runId 可找回近期运行编号。', { runId: string, withImage }],
  maa_verify: ['根据当前结算画面核验星数或剿灭击杀数。仅 executor=completed 不能确认通关，证据不足时保留 unknown。', { expectedKills: kills, withImage }],
  maa_cancel: ['请求停止指定运行的执行器，再用 maa_poll 确认。游戏中的战斗可能继续。', { runId: string }, ['runId']],
};

export function isInstalledTool(tool) {
  return Object.hasOwn(tools, tool) && fs.existsSync(installFile);
}

export async function callCli(installation, args, signal) {
  const env = { ...process.env, ...installation.environment, MAA_AGENT_RUNTIME_DIR: installation.runtime, PYTHONIOENCODING: 'utf-8' };
  let stdout;
  try {
    ({ stdout } = await exec(pythonFile, ['-m', 'maa_agent', ...args], {
      cwd: installation.source, env, signal, timeout: 180000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    }));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Maa-Agent 的虚拟环境或源码目录缺失，请重新运行可选安装。');
    if (typeof error.code !== 'number' || !error.stdout?.trim()) throw error;
    // doctor returns its check list with exit code 1, as do other structured CLI failures.
    let failure;
    try { failure = JSON.parse(error.stdout); } catch { throw error; }
    if (args[0] === 'doctor' && Array.isArray(failure.checks)) return failure;
    throw new Error(failure.error || 'Maa-Agent 命令失败');
  }
  try { return JSON.parse(stdout); } catch { return stdout.trim(); } // --help uses plain text.
}

async function stageCodes(installation, signal) {
  const env = { ...process.env, ...installation.environment, PYTHONIOENCODING: 'utf-8' };
  let data = env.MAA_AGENT_DATA_DIR || env.MAA_DATA_DIR;
  if (!data) {
    const result = await exec(pythonFile, ['-c', 'from maa_agent.config import Settings; print(Settings.load().data)'], {
      cwd: installation.source, env, signal, windowsHide: true,
    });
    data = result.stdout.trim();
  }
  const overview = JSON.parse(await fs.promises.readFile(path.join(data, 'resource', 'Arknights-Tile-Pos', 'overview.json'), 'utf8'));
  const codes = new Map();
  for (const { stageId, code, name } of Object.values(overview)) {
    const display = stageId?.startsWith('camp_') ? name : code;
    if (display && display !== 'Unknown') {
      codes.set(stageId, display);
      codes.set(display, display);
    }
  }
  return codes;
}

async function listPlans(installation, signal) {
  const plans = [], files = [];
  const visited = new Set();
  function scan(dir) {
    const real = fs.realpathSync(dir);
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      const stat = entry.isSymbolicLink() ? fs.statSync(target, { throwIfNoEntry: false }) : entry;
      if (stat?.isDirectory()) scan(target);
      else if (stat?.isFile() && entry.name.toLowerCase().endsWith('.json')) files.push(target);
    }
  }
  scan(catalogDir);
  const warnings = [];
  let codes = new Map();
  if (files.length) {
    try { codes = await stageCodes(installation, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      warnings.push('未能读取 MaaCore 关卡表，可按游戏准备页指定关卡：' + error.message);
    }
  }
  for (const target of files) {
    const dir = path.dirname(target);
    const relative = path.relative(catalogDir, target).split(path.sep).join('/');
    try {
      const plan = JSON.parse(await fs.promises.readFile(target, 'utf8'));
      if (!plan?.stage_name || !Array.isArray(plan.actions) || !plan.actions.length) {
        warnings.push(relative + '：缺少作业的 stage_name 或 actions');
        continue;
      }
      const folderStage = path.dirname(dir) === catalogDir ? path.basename(dir) : null;
      const stage = codes.get(plan.stage_name) ?? folderStage;
      // A legacy stage folder can still return its basename. Other paths are
      // explicitly relative so two files with the same name stay distinguishable.
      const file = folderStage && stage === folderStage ? path.basename(target) : './' + relative;
      plans.push({ stage, file, ...(!stage ? { stageId: plan.stage_name } : {}) });
    } catch (error) {
      warnings.push(relative + '：' + error.message);
    }
  }
  return warnings.length ? { plans, warnings } : { plans };
}

function planPath(stage, file) {
  if (path.isAbsolute(file)) return file;
  if (path.basename(file) === file) {
    const legacy = path.join(catalogDir, stage, file);
    if (fs.existsSync(legacy)) return legacy;
  }
  return path.resolve(catalogDir, file);
}

function recentRuns(runtimeDir) {
  const runs = path.join(runtimeDir, 'runs');
  if (!fs.existsSync(runs)) return [];
  return fs.readdirSync(runs, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => ({ run_id: e.name, time: fs.statSync(path.join(runs, e.name)).mtimeMs }))
    .sort((a, b) => b.time - a.time).slice(0, 12);
}

function cliArgs(tool, input) {
  const expectedKills = input.expectedKills ?? 400;
  switch (tool) {
    case 'maa_cli': return input.args;
    case 'maa_doctor': return ['doctor'];
    case 'maa_observe': return ['observe'];
    case 'maa_verify': return ['verify', '--expected-kills', String(expectedKills)];
    case 'maa_stage':
      return input.annihilation === true ? ['annihilation', '--expected-stage', input.stage] : ['stage', input.stage];
    case 'maa_run_copilot':
      return ['run-copilot', planPath(input.stage, input.file), '--expected-stage', input.stage, '--expected-kills', String(expectedKills)];
    case 'maa_poll':
    case 'maa_cancel':
      return [tool === 'maa_poll' ? 'poll' : 'cancel', input.runId];
    default: throw new Error('未知的 Maa-Agent 操作');
  }
}

async function screenshot(ctx, file) {
  if (!file) return { imageNote: '本次结果尚无截图' };
  const attachments = ctx.get('attachments');
  if (!attachments) return { imageNote: 'DSH 的图像附件服务不可用' };
  const image = await attachments.saveImage({ data: await fs.promises.readFile(file), mediaType: 'image/png', name: path.basename(file) });
  return { image };
}

export function apply(ctx) {
  if (!fs.existsSync(installFile)) return;
  for (const [tool, [description, properties, required = []]] of Object.entries(tools)) {
    ctx.tools.register({
      name: tool, description, timeoutMs: 190000,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: {
        schema: { type: 'object' },
        render(_args, value) {
          const content = [{ type: 'text', text: JSON.stringify(value.result) }];
          if (value.image) content.push({ type: 'image', attachment: value.image });
          if (value.imageNote) content.push({ type: 'text', text: value.imageNote });
          return content;
        },
      },
      async execute(input, execution) {
        const installation = JSON.parse(fs.readFileSync(installFile, 'utf8'));
        if (tool === 'maa_copilots') return { result: await listPlans(installation, execution.signal) };
        if (tool === 'maa_poll' && input.runId === undefined) return { result: { runs: recentRuns(installation.runtime) } };
        const args = cliArgs(tool, input);
        const result = await callCli(installation, args, execution.signal);
        if (input.withImage !== true) return { result };
        const file = tool === 'maa_poll' ? (result.after ?? result.before)?.screenshot : result.screenshot;
        try { return { result, ...await screenshot(ctx, file) }; }
        catch (error) { return { result, imageNote: '无法附上截图：' + error.message }; }
      },
    });
  }
}
