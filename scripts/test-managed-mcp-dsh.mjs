// Optional integration: installed DSH + independent temporary DSH_HOME + fake
// stdio servers. No production profile/state, QQ, credentials or model calls.
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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-managed-mcp-dsh-'));
try {
  const fixture = fileURLToPath(new URL('./fixtures/dsh-managed-mcp-host-check.mjs', import.meta.url));
  const patch = path.join(temporary, 'fixture.yml');
  const audit = path.join(temporary, 'mcp-audit.jsonl');
  // Headless has no manager by default; this entire manager is fixture-owned.
  fs.writeFileSync(patch, JSON.stringify([{ insert: [
    { id: 'fixture-mcp-manager', name: '@deepseek-ai/dsh-mcp-manager' },
    { id: 'qq-managed-mcp-host-check', name: fixture },
  ] }]));
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'ComSpec']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: path.join(temporary, 'home'), QQ_FIXTURE_NODE: process.execPath, QQ_FIXTURE_AUDIT: audit });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--expose-internals', cli, '--profile', 'headless', '--patch', patch, '--json', '-'], {
      cwd: temporary, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('isolated DSH MCP check timed out\n' + output)); }, 45000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-16000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, output }); });
    child.stdin.end();
  });
  assert.equal(result.code, 0, result.output);
  assert.ok(result.output.includes('QQ_MANAGED_MCP_HOST_CHECK_OK'), result.output);
  const events = fs.readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  // Discovery may use its own temporary child before JSON-RPC fallback. Count
  // initialized connections, while still checking closure of every child below.
  assert.equal(events.filter(row => row.server === 'qq' && row.event === 'initialize').length, 3, 'live, probe, targeted restart');
  assert.equal(events.filter(row => row.server === 'qq-memory' && row.event === 'initialize').length, 1, 'other server must not restart');
  assert.ok(!events.some(row => row.event === 'tools/call'));
  const started = events.filter(row => row.event === 'start').map(row => row.pid).sort();
  // Windows termination of a discovery child need not run JS exit handlers.
  // Check actual process liveness, never send a terminating signal ourselves.
  for (const pid of started) {
    let running = true;
    for (let attempt = 0; attempt < 20 && running; attempt++) {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') running = false; else throw error; }
      if (running) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(running, false, 'fake MCP child must be closed: ' + pid);
  }
  console.log('PASS installed DSH manages QQ registrations, probes safely, restarts only the target and disposes all children');
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('qq-managed-mcp-dsh-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
