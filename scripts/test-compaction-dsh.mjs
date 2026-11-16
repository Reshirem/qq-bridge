// Optional integration against installed DSH Desktop, without real-model or QQ calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const install = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness');
const executable = process.env.DSH_DESKTOP_EXECUTABLE || path.join(install, 'DeepSeek Harness.exe');
const cli = process.env.DSH_CLI_ENTRY || path.join(path.dirname(executable), 'resources', 'app.asar', 'dsh',
  'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
if (!fs.existsSync(executable)) throw new Error('This optional check requires installed DSH Desktop');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-compaction-dsh-'));
try {
  const fixture = fileURLToPath(new URL('./fixtures/dsh-compaction-host-check.mjs', import.meta.url));
  const patch = path.join(temporary, 'fixture.yml');
  fs.writeFileSync(patch, JSON.stringify([{ insert: [{ id: 'qq-compaction-host-check', name: fixture }] }]));
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'ComSpec']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: path.join(temporary, 'home') });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--expose-internals', cli, '--profile', 'headless', '--patch', patch, '--json', '-'], {
      cwd: temporary, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('isolated DSH compaction check timed out\n' + output)); }, 45000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-16000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
    child.stdin.end();
  });
  assert.equal(result.code, 0, result.output);
  assert.ok(result.output.includes('QQ_COMPACTION_HOST_CHECK_OK'), result.output);
  console.log('PASS installed DSH shares compaction/LLM classes, recovers image offload and protects model switches');
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('qq-compaction-dsh-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
