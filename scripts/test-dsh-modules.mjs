import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dshModulesDir, dshProfileDir } from './dsh-modules.mjs';

const keys = ['DSH_HOME', 'DSH_PROFILE', 'DSH_INSTALL_MODULES', 'DSH_MODULES'];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-modules-audit-'));
const setHome = (home) => { process.env.DSH_HOME = home; };
const clearOverrides = () => {
  delete process.env.DSH_PROFILE;
  delete process.env.DSH_INSTALL_MODULES;
  delete process.env.DSH_MODULES;
};

try {
  clearOverrides();
  const validHome = path.join(temp, 'valid');
  const validProfile = path.join(validHome, 'profiles', 'desktop');
  const validModules = path.join(validProfile, 'node_modules');
  const personaDir = path.join(validModules, '@deepseek-ai', 'dsh-persona');
  fs.mkdirSync(path.join(personaDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(validProfile, 'package.json'), JSON.stringify({ name: 'fixture-profile' }));
  fs.writeFileSync(path.join(personaDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-persona', main: 'lib/index.js' }));
  fs.writeFileSync(path.join(personaDir, 'lib', 'index.js'), 'module.exports = {};');
  setHome(validHome);
  assert.equal(dshModulesDir(), validModules, 'a real DSH package should locate its profile node_modules');
  assert.equal(dshProfileDir('desktop'), path.join(validHome, 'profiles', 'desktop'));
  assert.throws(() => dshProfileDir('..\\outside'), /DSH profile 名称无效/, 'profile arguments must not escape the profile directory');

  const yamlOnlyHome = path.join(temp, 'yaml-only');
  const yamlOnlyProfile = path.join(yamlOnlyHome, 'profiles', 'desktop');
  fs.mkdirSync(path.join(yamlOnlyProfile, 'node_modules', 'js-yaml'), { recursive: true });
  fs.writeFileSync(path.join(yamlOnlyProfile, 'package.json'), JSON.stringify({ name: 'fixture-profile' }));
  fs.writeFileSync(path.join(yamlOnlyProfile, 'node_modules', 'js-yaml', 'index.js'), 'module.exports = {};');
  setHome(yamlOnlyHome);
  assert.throws(dshModulesDir, /无法定位含 @deepseek-ai\/dsh-persona/, 'generic js-yaml must not masquerade as an installed DSH profile');
  process.env.DSH_PROFILE = 'desktop';
  assert.equal(dshProfileDir(), yamlOnlyProfile, 'DSH_PROFILE should select the profile used by deployment verification');

  const override = path.join(temp, 'explicit-node-modules');
  process.env.DSH_INSTALL_MODULES = override;
  assert.equal(dshModulesDir(), override, 'an explicit module directory must take precedence');
  console.log('PASS DSH module discovery requires a DSH-specific package and honors explicit overrides');
} finally {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('qq-dsh-modules-audit-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
