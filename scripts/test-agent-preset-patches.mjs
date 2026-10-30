// Verify the generated preset can load the persona and tool guard in the DSH profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { BUNDLE_DIR, GUARD_SPECIFIER, PRESETS, REPO_ROOT, buildPatches, patchFileFor, presetRowId } from './build-agent-preset-patches.mjs';

for (const { file, changed } of buildPatches({ check: true })) {
  assert.equal(changed, false, `${file} 与 preset 源不一致，请重新生成`);
}

const bundle = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, 'package.json'), 'utf8'));
for (const name of PRESETS) {
  const patch = yaml.load(fs.readFileSync(patchFileFor(name), 'utf8'));
  const row = patch?.[0]?.insert?.find((entry) => entry.id === presetRowId(name));
  assert.equal(row?.name, '@deepseek-ai/dsh-agent-preset');
  assert.equal(row?.config?.id, name);
  assert.ok(bundle.dsh?.bundle?.patch?.includes(`./presets/${name}.patch.yml`));
  const plugins = row.config.plugins;
  assert.equal(plugins.find((plugin) => plugin.id === 'persona')?.name, '@deepseek-ai/dsh-persona');
  assert.equal(plugins.find((plugin) => plugin.id === 'qq-tool-restrict')?.name, GUARD_SPECIFIER);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'plugins', GUARD_SPECIFIER)));
  const compaction = plugins.find((plugin) => plugin.id === 'compaction');
  assert.equal(compaction?.config?.find((plugin) => plugin.id === 'compaction-basic')?.name, 'qq-agent-presets/compaction-persona.mjs');
  assert.ok(fs.existsSync(path.join(BUNDLE_DIR, 'compaction-persona.mjs')));
}
console.log('Generated preset patch is current and its required plugins resolve.');
