/** Read-only live evaluation. Never import the bridge or open the Gateway for writing. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAMemorixGateway } from '../src/a-memorix-gateway.js';
import { listAMemorixParagraphs } from '../src/a-memorix-readonly.js';
import { CURATOR_PROMPT, curatorSourcesMatch, curatorCandidates, curatorDecision, curatorTask, readCuratorInventory } from '../src/memory-curator.js';
import { memoryOrganizerCliLaunch, memoryOrganizerDesktopProvider } from '../src/dsh-headless.js';
import { runLearningHeadless } from '../src/learning-runner.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
if (!config.memory?.enabled) throw Error('长期记忆尚未启用');
const stateDir = path.join(root, 'state');
const records = await readCuratorInventory(cursor => listAMemorixParagraphs({
  stateDir:path.join(stateDir,'a-memorix'), namespace:config.memory.namespace || 'qq-bridge', cursor, limit:100,
}));
const candidates = curatorCandidates(records);
const byOrigin = Object.groupBy(candidates, group => group.key.split('/')[0]);
console.log(JSON.stringify({ records:records.length, groups:candidates.length,
  byOrigin:Object.fromEntries(Object.entries(byOrigin).map(([k,v]) => [k,v.length])) }));
// Cover both origins in a smoke evaluation; --all evaluates every candidate.
const selected = process.argv.includes('--all') ? candidates : Object.values(byOrigin).map(groups => groups[0]);
const model = { provider:'deepseek-official', model:'deepseek-flash', reasoningEffort:'max' };
for (const key of Object.keys(model)) if (config.dsh?.[key] !== undefined) model[key] = config.dsh[key];
const directory = path.join(stateDir, 'memory-curator-evaluations');
fs.mkdirSync(directory, {recursive:true});
const signature = createHash('sha256').update(JSON.stringify([config.memory.namespace, model, CURATOR_PROMPT])).digest('hex');
const report = path.join(directory, signature + '.json');
const entries = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : {};
const errors = [];
const gateway = createAMemorixGateway(config.memory);
const queue = selected.filter(g => !Object.hasOwn(entries,g.id));
async function evaluate() {
  for (let group; (group = queue.shift());) {
    try {
      if (!await curatorSourcesMatch(group.rows,gateway)) throw Error('候选原文已变化');
      const result = await runLearningHeadless({ cli:memoryOrganizerCliLaunch(config.memoryOrganizer?.cliPath),
        root,stateDir,model,provider:memoryOrganizerDesktopProvider(model),task:curatorTask(group),images:[],mode:'curator' });
      const decision = curatorDecision(result.text, group);
      entries[group.id] = { ...decision, sources:group.rows.map(r => r.memoryId), usage:result.usage, sessionId:result.sessionId };
      const temporary = report + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(entries), {mode:0o600});
      fs.renameSync(temporary, report);
    } catch (error) {
      errors.push({group:group.id.slice(0,12), error:error.message});
    }
  }
}
await Promise.all(Array.from({length:Math.min(queue.length,3)}, evaluate));
// Recheck cached model decisions against the current bridge-side rules.
const decisions = [];
let guarded = 0, verifiedSources = 0;
for (const group of selected) {
  const cached = entries[group.id];
  if (!cached) continue;
  if (!await curatorSourcesMatch(group.rows,gateway)) {
    errors.push({group:group.id.slice(0,12),error:'评估后原文版本不一致'});
    continue;
  }
  verifiedSources += group.rows.length;
  const verified = curatorDecision(JSON.stringify({...cached, members:cached.action === 'keep' ? [] : [1,2]}), group);
  if (verified.action !== cached.action) guarded++;
  decisions.push({...cached, ...verified});
}
const summary = {
  checkedAt:new Date().toISOString(), model, records:records.length, candidates:candidates.length, selected:selected.length,
  evaluated:decisions.length, verifiedSources, guarded, writes:0,
  actions:Object.fromEntries(Object.entries(Object.groupBy(decisions,d => d.action)).map(([k,v]) => [k,v.length])),
  inputTokens:decisions.reduce((n,d) => n+d.usage.inputTokens,0),
  outputTokens:decisions.reduce((n,d) => n+d.usage.outputTokens,0), errors,
};
const assessment = path.join(directory, process.argv.includes('--all') ? 'latest-full.json' : 'latest-sample.json');
const tmp = assessment + '.' + process.pid + '.tmp';
fs.writeFileSync(tmp, JSON.stringify({...summary, decisions},null,2), {mode:0o600});
fs.renameSync(tmp, assessment);
console.log(JSON.stringify({...summary,report:assessment}));
if (errors.length) process.exitCode = 1;
