// Offline integration tests. Every setup invocation receives its own repository and DSH_HOME.
// QQ_BRIDGE_TEST_YAML_ROOT is only useful when auditing with an intentionally read-only
// node_modules tree; normal installs resolve the declared js-yaml dependency directly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parserRoot = process.env.QQ_BRIDGE_TEST_YAML_ROOT || path.dirname(require.resolve('js-yaml/package.json'));
const yaml = (await import(pathToFileURL(path.join(parserRoot, 'dist/js-yaml.mjs')).href)).default;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-audit-setup-'));
let failures = 0;

// Exercise real npm installation and adapter imports entirely inside the fixture.
function copyOfflinePlugins(repo) {
  fs.cpSync(path.join(root, 'plugins'), path.join(repo, 'plugins'), {
    recursive: true,
    filter: (src) => !['node_modules', 'package-lock.json'].includes(path.basename(src)),
  });
  const manifest = path.join(repo, 'plugins/qq-agent-presets/package.json');
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const modules = {
    '@deepseek-ai/dsh-compaction-basic': 'export default class BasicCompactionEngine {}',
    '@deepseek-ai/dsh-llm': 'export class BlockAssembler {}\nexport class LlmError extends Error {}',
    '@deepseek-ai/schemastery': 'export default {}',
  };
  for (const name of Object.keys(pkg.dependencies)) {
    const dir = path.join(repo, 'fixture-packages', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), modules[name]);
    pkg.dependencies[name] = `file:../../fixture-packages/${name}`;
  }
  fs.writeFileSync(manifest, JSON.stringify(pkg));
}

function fixture(name, patch = '') {
  const base = path.join(sandbox, name);
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/setup-dsh.mjs'), path.join(repo, 'scripts/setup-dsh.mjs'));
  // setup-dsh.mjs 直接从仓库源生成 bundle patch，生成器必须一起进夹具。
  fs.copyFileSync(path.join(root, 'scripts/build-agent-preset-patches.mjs'), path.join(repo, 'scripts/build-agent-preset-patches.mjs'));
  // Patch generator validates the source prompt through this pure helper.
  fs.copyFileSync(path.join(root, 'src/preset-prompt.js'), path.join(repo, 'src/preset-prompt.js'));
  // setup-dsh.mjs checks ffmpeg availability using this standalone resolver.
  fs.copyFileSync(path.join(root, 'src/ffmpeg-resolve.js'), path.join(repo, 'src/ffmpeg-resolve.js'));
  fs.cpSync(path.join(root, 'dsh'), path.join(repo, 'dsh'), { recursive: true });
  copyOfflinePlugins(repo);
  fs.cpSync(parserRoot, path.join(repo, 'node_modules/js-yaml'), { recursive: true });
  fs.mkdirSync(path.join(home, 'profiles/web'), { recursive: true });
  const patchFile = path.join(home, 'profiles/web/cordis.patch.yml');
  fs.writeFileSync(patchFile, patch);
  fs.writeFileSync(path.join(home, 'profiles/web/package.json'), JSON.stringify({
    name: 'fixture-profile',
    dependencies: { existing: '1.0.0' },
    dsh: { profile: { bundles: ['existing'] } },
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path$|npm_)/i.test(key)));
  Object.assign(env, {
    PATH: path.dirname(process.execPath), DSH_HOME: home, HOME: home, USERPROFILE: home,
    QQ_BRIDGE_SKIP_DSH_INSTALL: '1', npm_config_offline: 'true',
    npm_config_cache: path.join(base, 'npm-cache'), npm_config_userconfig: path.join(home, '.npmrc'),
  });
  const run = (profile = 'web', extraEnv = {}) => spawnSync(process.execPath, [path.join(repo, 'scripts/setup-dsh.mjs'), profile], {
    env: { ...env, ...extraEnv }, cwd: repo, encoding: 'utf8', timeout: 15000,
  });
  return { repo, home, patchFile, run };
}

function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}

try {
  test('shared inserts, quoted IDs, flow YAML and unrelated nested arrays survive repeat setup', () => {
    const source = `# user patch\n- insert:\n    - id: mcp-snowluma\n      name: old\n    - id: custom\n      name: custom-plugin\n      config:\n        empty:\n          []\n        nested:\n          - id: mcp-snowluma-host\n            value: keep\n- insert:\n    - id: 'mcp-snowluma-host' # managed entry\n      name: old\n- {insert: [{id: mcp-web-search-safe, name: old}]}\n`;
    const plugin = '@deepseek-ai/dsh-mcp-client';
    const oldAdapter = { id: 'old-qq-adapter', name: plugin, config: { args: ['C:\\old\\qq-bridge\\src\\maa_mcp_server.py'] } };
    const independent = { id: 'mcp-maa', name: plugin, config: { serverName: 'maa', args: ['-m', 'independent_server'] } };
    const f = fixture('structured', source + yaml.dump([{ insert: [oldAdapter, independent] }]));
    const originalCustom = yaml.load(source)[0].insert[1];
    for (let i = 0; i < 2; i++) {
      const result = f.run();
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const doc = yaml.load(fs.readFileSync(f.patchFile, 'utf8'));
      const entries = doc.flatMap((op) => op.insert || []);
      assert.deepEqual(entries.find((entry) => entry.id === 'custom'), originalCustom);
      assert.ok(!entries.some(entry => entry.id === oldAdapter.id));
      assert.deepEqual(entries.find(entry => entry.id === independent.id), independent);
      for (const id of ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-qq-memory']) {
        assert.equal(entries.filter((entry) => entry.id === id).length, 1, `${id} duplicate`);
      }
      assert.equal(entries.filter((entry) => entry.id === 'mcp-web-search-safe').length, 0, '旧版网页 MCP 应移除');
      assert.equal(entries.find((entry) => entry.id === 'mcp-snowluma').config.toolCallTimeoutMs, 725000);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(f.home, 'profiles/web/package.json')));
    assert.equal(pkg.dependencies.existing, '1.0.0');
    assert.deepEqual(pkg.dsh.profile.bundles, ['existing', 'qq-agent-presets']);
    const bundle = path.join(f.home, 'plugins/qq-agent-presets');
    assert.equal(pkg.dependencies['qq-agent-presets'], `link:${bundle.replaceAll(path.sep, '/')}`);
    assert.ok(fs.statSync(path.join(bundle, 'presets/desktop-agent.patch.yml')).isFile());
  });

  test('malformed patch fails before replacing user configuration or presets', () => {
    const source = '- insert: [broken\n';
    const f = fixture('malformed', source);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(f.patchFile, 'utf8'), source);
  });

  test('profile traversal is rejected before filesystem changes', () => {
    const f = fixture('traversal');
    const result = f.run('../../escape');
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(f.home, 'escape')), false);
  });

  test('existing unrelated state, DSH settings and non-link plugin directory remain untouched', () => {
    const f = fixture('preserve', '[]\n');
    fs.mkdirSync(path.join(f.repo, 'state'), { recursive: true });
    const state = '{"sentinel":"leave-existing-state-alone"}\n';
    fs.writeFileSync(path.join(f.repo, 'state/unrelated.json'), state);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(f.repo, 'state/unrelated.json'), 'utf8'), state);
    const blocker = fixture('plugin-conflict', '[]\n');
    fs.mkdirSync(path.join(blocker.home, 'plugins/qq-agent-presets'), { recursive: true });
    fs.writeFileSync(path.join(blocker.home, 'plugins/qq-agent-presets/keep.txt'), 'keep');
    assert.notEqual(blocker.run().status, 0);
    assert.equal(fs.readFileSync(path.join(blocker.home, 'plugins/qq-agent-presets/keep.txt'), 'utf8'), 'keep');
  });

  if (process.platform === 'win32') test('Windows runs the npm .cmd shim with literal profile arguments', () => {
    const f = fixture('windows-cli');
    const bin = path.join(f.repo, 'bin');
    fs.mkdirSync(bin);
    const capture = path.join(bin, 'called.json');
    const cli = path.join(bin, 'fake-dsh.mjs');
    fs.writeFileSync(cli, `import fs from 'node:fs'; fs.writeFileSync(process.env.QQ_TEST_CAPTURE, JSON.stringify({args: process.argv.slice(2), home: process.env.DSH_HOME}));\n`);
    fs.writeFileSync(path.join(bin, 'dsh.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
    const profile = 'test&name%CD%!';
    const result = f.run(profile, {
      PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
      QQ_BRIDGE_SKIP_DSH_INSTALL: '0', QQ_TEST_CAPTURE: capture,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(capture), `CLI was not invoked: ${result.stdout}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture)), { args: ['plugin', '--profile', profile, 'install'], home: f.home });
  });
} finally {
  // Resolve the exact fixture root before removing this test's temporary files.
  assert.equal(path.dirname(path.resolve(sandbox)), path.resolve(os.tmpdir()));
  fs.rmSync(sandbox, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
