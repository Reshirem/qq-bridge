import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { LEARNING_SYSTEM_PROMPT } from './chat-learning.js';

export function learningPatch({ model, provider, imageServer, imageManifest, nodePath = process.execPath }) {
  const operations = [
    { id: 'agent-default-model', config: model },
    { id: 'system-prompt', config: { personaPrefix: LEARNING_SYSTEM_PROMPT } },
    { id: 'session-title-llm', disabled: true },
    { insert: [{ id: 'qq-learning-tool-guard', name: fileURLToPath(new URL('./learning-tool-guard.mjs', import.meta.url)).replaceAll('\\', '/') }] },
  ];
  if (imageManifest) operations.push({ insert: [{ id: 'qq-learning-images', name: '@deepseek-ai/dsh-mcp-client', config: {
    serverName: 'qq-learning-images', transport: 'stdio', command: nodePath, args: [imageServer, imageManifest], toolCallTimeoutMs: 30000,
  } }] });
  if (provider) {
    operations.push(provider);
    if (provider.config.providers[model.provider]?.apiKeyEnv) operations.push({ id: 'credentials', disabled: false });
  }
  for (const id of [
    'tool-working-directory', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
    'tool-skill', 'tool-subagent-control', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow',
    'tool-todo', 'tool-goal', 'tool-web', 'tool-plugin-manager',
  ]) operations.push({ id, disabled: true });
  return yaml.dump(operations, { lineWidth: -1, noRefs: true });
}

export function parseLearningResult(text) {
  const result = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
  if (!result || !Array.isArray(result.slang) || !Array.isArray(result.stickers)) throw new Error('学习模型没有返回 slang / stickers JSON');
  return result;
}

// A separate headless process receives only batch text + an image-only MCP.
// No QQ, memory, shell, browser or arbitrary file tools are mounted here.
export async function runLearningHeadless({ cli, approvalPolicy, root, stateDir, model, provider, task, images, signal, spawnProcess = spawn, timeoutMs = 300000 }) {
  if (cli.shell && /[\r\n\0"&|<>^%]/.test(cli.command)) throw new Error('DSH CLI 路径含不支持的命令字符');
  signal?.throwIfAborted();
  const prefix = path.join(stateDir, `chat-learning-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  const patch = `${prefix}.yml`, manifest = `${prefix}.json`;
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    fs.writeFileSync(manifest, JSON.stringify(images), { mode: 0o600 });
    fs.writeFileSync(patch, learningPatch({ model, provider, imageServer: path.join(root, 'src', 'mcp-learning-images.js'), imageManifest: images.length ? manifest : null }), { mode: 0o600 });
    return await new Promise((resolve, reject) => {
      const child = spawnProcess(cli.command, [...cli.args, '--profile', 'headless', '--patch', patch, ...(approvalPolicy ? ['--approval-policy', 'never'] : []), '--json', '-'], {
        cwd: root, env: { ...process.env, ...cli.env }, shell: cli.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buffer = '', final = null, terminalReason = null, sessionId = '', failure = '', imageRead = false, outputBytes = 0;
      const usage = { inputTokens: 0, outputTokens: 0 };
      const imageCalls = new Set();
      const stop = reason => { failure ||= reason; child.kill(); };
      const onAbort = () => stop('后台学习已取消');
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const deadline = setTimeout(() => stop('后台学习超过 5 分钟，已终止'), timeoutMs);
      deadline.unref?.();
      const readLine = line => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line), type = String(event.type).replace(/[./-]+/g, '_');
          if (type === 'session') sessionId = String(event.sessionId || '');
          if (type === 'status' && event.phase === 'turn_start') terminalReason = null;
          if (type === 'status' && event.phase === 'turn_end') terminalReason = event.reason;
          if (type === 'status' && event.phase === 'step_end' && event.usage) {
            for (const key of ['inputTokens', 'outputTokens']) usage[key] += Math.max(0, Number(event.usage[key]) || 0);
          }
          if (type === 'error') stop('DSH 学习进程报告错误，请检查 DSH 配置');
          if (type === 'tool_call') {
            const name = String(event.tool ?? event.toolName ?? event.name ?? '');
            if (!/(?:^|__)learning_images$/.test(name)) stop('学习进程尝试调用未授权工具');
            else imageCalls.add(String(event.callId ?? event.toolCallId ?? event.id ?? ''));
          }
          if (type === 'tool_result' && imageCalls.has(String(event.callId ?? event.toolCallId ?? event.id ?? '')) && event.status === 'completed' && !event.error && !event.isError) {
            if (/image unavailable|image admission rejected/i.test(String(event.result))) stop('DSH 未能接收学习图片，拒绝保存未经看图的结果');
            else imageRead = true;
          }
          if (type === 'final') final = event;
        } catch { stop('DSH 学习事件不是合法 JSON'); }
      };
      // setEncoding preserves multibyte Chinese characters split across pipe chunks.
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > 16_000_000) { stop('学习输出超过上限'); return; }
        buffer += chunk;
        if (buffer.length > 2_000_000) { buffer = ''; stop('学习输出行超过上限'); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) { readLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      });
      // Drain diagnostic output but do not retain credentials or source text in logs.
      child.stderr.on('data', () => {});
      child.on('error', () => { failure ||= '无法启动 DSH 学习进程，请检查 CLI 路径'; });
      child.stdin.on('error', () => { failure ||= '无法向学习进程发送资料'; });
      child.on('close', code => {
        clearTimeout(deadline); signal?.removeEventListener('abort', onAbort);
        if (buffer.trim()) readLine(buffer);
        try {
          if (failure) throw new Error(failure);
          // The installed CLI reports the durable reason on status/turn_end;
          // newer projections also carry it on final. Explicit null is not completion.
          const reason = final && Object.hasOwn(final, 'reason') ? final.reason : terminalReason;
          if (code !== 0 || !sessionId || !final || reason?.kind !== 'completed') throw new Error(`DSH 学习未正常完成（退出码 ${code}）`);
          const result = parseLearningResult(final.text);
          if (result.stickers.length && !imageRead) throw new Error('模型未成功看图，拒绝保存表情描述');
          resolve({ ...result, sessionId, usage });
        } catch (error) { error.usage = usage; reject(error); }
      });
      child.stdin.end(task, 'utf8');
    });
  } finally {
    for (const file of [patch, manifest]) { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
}
