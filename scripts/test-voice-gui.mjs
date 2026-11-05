// Voice-core file boundaries run offline. The optional installed GUI is exercised through its actual CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { safeJoinLibrary, sanitizeUploadName, uniqueLibraryPath } from '../src/voice-core.js';
// 独立发语音工具在仓库上一级（不在本仓库里）：位置解析与"不在时怎么跳过"走共享口径。
import { skipVoiceTool, voiceToolDir, voiceToolPath } from './voice-tool-locator.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 安全：路径穿越与文件名净化');
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-lib-'));
  const lib = path.join(temp, 'library');
  fs.mkdirSync(lib);
  fs.writeFileSync(path.join(lib, 'ok.mp3'), Buffer.alloc(8, 1));
  fs.writeFileSync(path.join(path.dirname(lib), 'outside.mp3'), Buffer.alloc(8, 1));

  ok(safeJoinLibrary(lib, 'ok.mp3')?.endsWith('ok.mp3'), '库内正常文件放行');
  ok(safeJoinLibrary(lib, '../outside.mp3') === null, '拒绝 ../ 逃逸');
  ok(safeJoinLibrary(lib, '..\\outside.mp3') === null, '拒绝 ..\\ 逃逸（Windows 反斜杠）');
  ok(safeJoinLibrary(lib, '../../config.json') === null, '拒绝 ../../config.json');
  ok(safeJoinLibrary(lib, 'sub/../../x.mp3') === null, '拒绝多级混合穿越');
  ok(safeJoinLibrary(lib, '') === null, '拒绝空路径');
  ok(safeJoinLibrary(lib, 'a\0b.mp3') === null, '拒绝含 NUL 的路径');

  ok(sanitizeUploadName('../../evil.mp3') === 'evil.mp3', '上传名去掉目录部分');
  ok(sanitizeUploadName('C:\\Windows\\x.mp3') === 'x.mp3', '上传名去掉 Windows 路径');
  ok(sanitizeUploadName('a<b>c?.mp3') === 'a_b_c_.mp3', '上传名净化非法字符');
  ok(sanitizeUploadName('语音.wav') === '语音.wav', '保留中文名');
  ok(sanitizeUploadName('noext') === 'noext.mp3', '没有音频扩展名时补 .mp3');
  ok(sanitizeUploadName('...').endsWith('.mp3'), '纯点名不会变成隐藏文件');

  const p1 = uniqueLibraryPath(lib, 'ok.mp3');
  ok(p1.endsWith('ok-2.mp3'), '同名文件自动改名 ok-2.mp3', path.basename(p1));

  fs.rmSync(temp, { recursive: true, force: true });
}

async function checkGuiPort(equalsForm) {
  const ready = createServer();
  ready.listen(0, '127.0.0.1');
  await once(ready, 'listening');
  const port = ready.address().port;
  await new Promise(resolve => ready.close(resolve));
  const args = equalsForm ? ['--port=' + port] : ['--port', String(port)];
  const child = spawn(process.execPath, [voiceToolPath('voice-gui.mjs'), '--no-open', ...args], {
    cwd: voiceToolDir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  // Act only on this child's authenticated local URL. Keep its token out of the report.
  let output = '';
  child.stdout.setEncoding('utf8').on('data', data => { output = (output + data).slice(-4096); });
  child.stderr.resume();
  const closed = once(child, 'close');
  try {
    const deadline = Date.now() + 12000;
    const address = new RegExp('http://127[.]0[.]0[.]1:' + port + '/[^\\s]*?[?&]t=([A-Za-z0-9_-]+)');
    let match;
    while (!(match = address.exec(output))) {
      if (Date.now() > deadline) throw new Error('GUI did not announce the requested port: ' + port);
      await Promise.race([
        new Promise(resolve => setTimeout(resolve, 100)),
        closed.then(([code]) => { throw new Error('GUI exited during startup: ' + code); }),
      ]);
    }
    const base = 'http://127.0.0.1:' + port;
    const request = (route, init) => fetch(base + route, { signal: AbortSignal.timeout(10000), ...init });
    ok((await request('/api/library')).status === 401, args.join(' ') + ' 监听指定端口并要求鉴权');
    if (equalsForm) return;
    const headers = { 'x-voice-token': match[1] };
    const boot = await (await request('/api/bootstrap', { headers })).json();
    ok(boot.ok && Array.isArray(boot.library?.items) && Array.isArray(boot.targets?.groups), 'bootstrap 返回语音库与目标');
    const dryRun = async (name, target) => (await request('/api/send', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name, target, dryRun: true }),
    })).json();
    ok((await dryRun('../../config.json', 'group:1')).ok === false, '拒绝库外文件');
    const voice = boot.library?.items?.find(item => item.ok !== false);
    const group = boot.targets?.groups?.[0];
    if (voice && group) {
      const result = await dryRun(voice.name, group.key);
      ok(result.ok && result.dryRun === true, 'dry-run 返回预览');
    } else console.log('  跳过 dry-run 成功场景：语音库或目标为空。');
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
  }
}

if (!fs.existsSync(voiceToolPath('voice-gui.mjs'))) {
  skipVoiceTool('真实 voice-gui 端口、鉴权及 dry-run');
} else if (process.env.QQ_BRIDGE_TEST_LIVE !== '1') {
  console.log('跳过独立 GUI 进程检查；设置 QQ_BRIDGE_TEST_LIVE=1 可运行。');
} else {
  await checkGuiPort(false);
  await checkGuiPort(true);
  for (const flag of ['--port', '--port=invalid']) {
    const child = spawnSync(process.execPath, [voiceToolPath('voice-gui.mjs'), '--no-open', flag], {
      cwd: voiceToolDir(), timeout: 5000, windowsHide: true, encoding: 'utf8',
    });
    ok(!child.error && child.status > 0 && /端口|port/i.test(child.stderr + child.stdout), flag + ' 应因端口非法退出');
  }
}
console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
