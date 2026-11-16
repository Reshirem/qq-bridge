import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDshCompactionModules } from '../plugins/qq-agent-presets/dsh-host-modules.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-compaction-host-'));
function packageAt(root, name, source = 'export default class {}') {
  const directory = path.join(root, 'node_modules', ...name.split('/'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }));
  const entry = path.join(directory, 'index.js');
  fs.writeFileSync(entry, source);
  return entry;
}
try {
  const valid = path.join(temporary, 'valid');
  const entry = packageAt(valid, '@deepseek-ai/dsh-desktop-host');
  const compaction = packageAt(valid, '@deepseek-ai/dsh-compaction-basic');
  const llm = packageAt(valid, '@deepseek-ai/dsh-llm');
  assert.deepEqual(resolveDshCompactionModules(entry), {
    compaction: pathToFileURL(compaction).href,
    llm: pathToFileURL(llm).href,
  });

  const unrelated = packageAt(valid, 'unrelated-host');
  assert.throws(() => resolveDshCompactionModules(unrelated), /必须由 DSH 宿主或 CLI 加载/);
  assert.throws(() => resolveDshCompactionModules(''), /缺少运行入口/);
  const missingRoot = path.join(temporary, 'missing');
  const missing = packageAt(missingRoot, '@deepseek-ai/dsh');
  assert.throws(() => resolveDshCompactionModules(missing), /Cannot find module/);

  const split = path.join(temporary, 'split');
  const splitHost = packageAt(split, '@deepseek-ai/dsh-desktop-host');
  const splitCompaction = packageAt(split, '@deepseek-ai/dsh-compaction-basic');
  packageAt(split, '@deepseek-ai/dsh-llm');
  packageAt(path.dirname(splitCompaction), '@deepseek-ai/dsh-llm');
  assert.throws(() => resolveDshCompactionModules(splitHost), /不同实例/,
    'a compaction-private llm copy must be rejected even when its version matches');
  console.log('PASS compaction resolves only the current DSH Host and rejects missing or split module trees');
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('qq-compaction-host-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
