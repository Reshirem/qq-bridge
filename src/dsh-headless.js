import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

export function memoryOrganizerDesktopProvider(modelSelection) {
  const provider = String(modelSelection.provider ?? '').trim();
  const model = String(modelSelection.model ?? '').trim();
  if (!provider || !model) return null;
  const dshHome = String(process.env.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh');
  const profilePath = path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
  if (!fs.existsSync(profilePath)) return null;

  const lines = fs.readFileSync(profilePath, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => /^-\s*id:\s*['"]?llm-pi-ai['"]?\s*$/.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^-\s*(?:id|insert):/.test(line));
  let entry;
  try {
    const parsed = yaml.load(lines.slice(start, end < 0 ? undefined : end).join('\n'));
    entry = Array.isArray(parsed) ? parsed[0] : null;
  } catch (error) {
    throw new Error(`读取 DSH Desktop provider 配置失败：${error?.message ?? error}`);
  }

  const configured = entry?.config?.providers?.[provider];
  if (!configured) return null;
  const allowedFields = [
    'apiKeyEnv', 'displayName', 'api', 'baseURL', 'models', 'modelOverrides', 'compat',
    'defaultContextWindow', 'defaultMaxTokens', 'defaultInput', 'reasoning', 'thinkingFormat'
  ];
  const unsupportedFields = Object.keys(configured).filter((key) => !allowedFields.includes(key));
  if (unsupportedFields.length > 0) {
    throw new Error(`DSH Desktop provider ${provider} 含整理器未支持的配置字段：${unsupportedFields.join(', ')}`);
  }

  const providerConfig = Object.fromEntries(
    Object.entries(configured).filter(([key]) => key !== 'models')
  );
  if (Array.isArray(configured.models)) {
    const selectedModel = configured.models.find((item) => String(item?.id ?? '') === model);
    if (!selectedModel) throw new Error(`DSH Desktop provider ${provider} 未配置模型 ${model}`);
    providerConfig.models = [selectedModel];
  }
  return {
    id: 'llm-pi-ai',
    name: String(entry.name || '@deepseek-ai/dsh-llm-pi-ai'),
    disabled: false,
    config: { providers: { [provider]: providerConfig } }
  };
}

export function memoryOrganizerCliLaunch(configuredPath = '') {
  const configured = String(configuredPath || process.env.DSH_CLI_PATH || '').trim();
  let cliPath = configured;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const desktopCli = path.join(
      process.env.LOCALAPPDATA,
      'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'
    );
    if (!cliPath && fs.existsSync(desktopCli)) cliPath = desktopCli;
  }
  cliPath ||= 'dsh';

  // DSH Desktop ships dsh.cmd as a wrapper around Electron's Node mode. Launch
  // that target directly so paths with spaces never pass through cmd.exe parsing.
  if (process.platform === 'win32' && path.basename(cliPath).toLowerCase() === 'dsh.cmd') {
    const binDir = path.dirname(cliPath);
    const installRoot = path.resolve(binDir, '..', '..', '..', '..');
    const executable = path.join(installRoot, 'DeepSeek Harness.exe');
    const appAsar = path.join(installRoot, 'resources', 'app.asar');
    if (fs.existsSync(executable) && fs.existsSync(appAsar)) {
      return {
        command: executable,
        args: [
          '--expose-internals',
          path.join(appAsar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
        ],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        shell: false
      };
    }
  }
  return { command: cliPath, args: [], env: {}, shell: process.platform === 'win32' };
}
