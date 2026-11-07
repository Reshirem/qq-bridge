import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-maa-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['plugins/qq-agent-presets/maa-agent.mjs', 'scripts/maa-agent.mjs']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  }
  const state = path.join(root, 'state', 'maa-agent');
  const definitions = new Map();
  const ctx = {
    tools: { register(def) { definitions.set(def.name, def); } },
    get: () => ({ async saveImage({ data }) {
      assert.equal(data.toString(), 'fixture screenshot');
      return { attachmentId: 'fixture', mediaType: 'image/png', width: 16, height: 9, bytes: data.length };
    } }),
  };
  return { root, state, ctx, definitions, plugin: import(pathToFileURL(path.join(root, 'plugins/qq-agent-presets/maa-agent.mjs'))) };
}

test('a default QQ installation has no game tools or game data', async t => {
  const { root, state, plugin, ctx, definitions } = fixture(t);
  (await plugin).apply(ctx);
  assert.equal(definitions.size, 0);
  const status = spawnSync(process.execPath, [path.join(root, 'scripts/maa-agent.mjs'), 'status'], { encoding: 'utf8' });
  assert.equal(status.status, 0);
  assert.match(status.stdout, /未启用/);
  assert.equal(fs.existsSync(state), false);
});

test('game tools list loose and grouped plans, pass paths to Maa-Agent and stop when disabled', async t => {
  const { root, state, ctx, definitions, plugin } = fixture(t);
  const install = await plugin;
  const candidates = [['python3'], ['py', '-3'], ['python'], [path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe')]];
  const python = candidates.find(([cmd, ...args]) => spawnSync(cmd, [...args, '-c', 'import venv'], { windowsHide: true }).status === 0);
  if (!python) { t.skip('Python with venv is needed only for the subprocess fixture'); return; }
  const source = path.join(root, 'source with spaces');
  const runtime = path.join(source, '.runtime');
  const data = path.join(root, 'resources');
  const tiles = path.join(data, 'resource', 'Arknights-Tile-Pos');
  fs.mkdirSync(tiles, { recursive: true });
  fs.writeFileSync(path.join(tiles, 'overview.json'), JSON.stringify({ one: { stageId: 'main_01-01', code: '1-1' } }));
  const environment = { MAA_AGENT_DATA_DIR: data };
  fs.mkdirSync(path.join(source, 'maa_agent'), { recursive: true });
  fs.mkdirSync(path.join(state, 'copilots/H8-1'), { recursive: true });
  const grouped = path.join(state, 'copilots/H8-1/低配.json');
  const loose = path.join(state, 'copilots/主线.json');
  const downloaded = path.join(root, '下载的作业.json');
  fs.writeFileSync(grouped, JSON.stringify({ stage_name: 'hard_08-01', actions: [{ type: 'SpeedUp' }] }));
  fs.writeFileSync(loose, JSON.stringify({ stage_name: 'main_01-01', actions: [{ type: 'SpeedUp' }] }));
  fs.copyFileSync(loose, downloaded);
  fs.writeFileSync(path.join(state, 'copilots/损坏.json'), '{');
  fs.writeFileSync(install.installFile, JSON.stringify({ source, runtime, environment }));
  const venv = spawnSync(python[0], [...python.slice(1), '-m', 'venv', '--without-pip', path.join(state, 'venv')], { encoding: 'utf8', windowsHide: true });
  assert.equal(venv.status, 0, venv.stderr);
  fs.writeFileSync(path.join(source, 'maa_agent/__main__.py'), [
    'import sys, os, json',
    'from pathlib import Path',
    'a = sys.argv[1:]; r = Path(os.environ["MAA_AGENT_RUNTIME_DIR"])',
    'shot = r / "observations" / ("a" * 32 + ".png")',
    'shot.parent.mkdir(parents=True, exist_ok=True); shot.write_bytes(b"fixture screenshot")',
    'with open("calls", "a", encoding="utf8") as f: f.write(a[0] + "\\n")',
    'if a[0] == "--help": print("Maa-Agent CLI help"); sys.exit(0)',
    'if a[0] == "observe": data = dict(state="stage_ready", screenshot=str(shot))',
    'elif a[0] == "run-copilot":',
    '    assert Path(a[1]).is_file() and a[2] == "--expected-stage" and a[4:] == ["--expected-kills","400"]',
    '    data = dict(run_id="b" * 32, executor="queued", file=a[1], stage=a[3])',
    'elif a[0] == "poll": data = dict(executor="completed", game_result="unknown", after=dict(screenshot=str(shot)))',
    'elif a[0] == "verify": data = dict(outcome="full_clear", stars=3, screenshot=str(shot))',
    'else: data = dict(error="fixture failure")',
    'print(json.dumps(data)); sys.exit(1 if "error" in data else 0)',
  ].join('\n'));
  install.apply(ctx);
  const call = (name, args = {}) => definitions.get(name).execute(args, {});
  const { plans, warnings } = (await call('maa_copilots')).result;
  assert.deepEqual(plans.find(p => p.stage === '1-1'), { stage: '1-1', file: './主线.json' });
  const plan = plans.find(p => p.stage === 'H8-1');
  assert.deepEqual(plan, { stage: 'H8-1', file: '低配.json' });
  assert.match(warnings.join('\n'), /损坏\.json/);
  const { run_id, file } = (await call('maa_run_copilot', plan)).result;
  assert.equal(file, grouped);
  assert.equal((await call('maa_run_copilot', plans.find(p => p.stage === '1-1'))).result.file, loose);
  const direct = await call('maa_run_copilot', { stage: '1-1', file: downloaded });
  assert.equal(direct.result.file, downloaded);
  assert.equal(direct.result.stage, '1-1');
  assert.deepEqual(fs.readFileSync(path.join(source, 'calls'), 'utf8').trim().split(/\r?\n/), Array(3).fill('run-copilot'));
  assert.equal((await call('maa_cli', { args: ['--help'] })).result, 'Maa-Agent CLI help');
  const poll = await call('maa_poll', { runId: run_id, withImage: true });
  assert.equal(poll.result.game_result, 'unknown');
  assert.equal(definitions.get('maa_poll').output.render({}, poll)[1].attachment.attachmentId, 'fixture');
  assert.equal((await call('maa_verify')).result.stars, 3);
  await assert.rejects(call('maa_cancel', { runId: run_id }), /fixture failure/);
  const disable = spawnSync(process.execPath, [path.join(root, 'scripts/maa-agent.mjs'), 'disable']);
  assert.equal(disable.status, 0);
  await assert.rejects(call('maa_run_copilot', plan));
  assert.equal(install.isInstalledTool('maa_run_copilot'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'disabled.json'))), { source, runtime, environment });
  assert.ok(fs.existsSync(path.join(state, 'copilots/H8-1/低配.json')));
});
