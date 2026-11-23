import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { curatorCandidates, curatorDecision, createCurator, readCuratorInventory } from '../src/memory-curator.js';
import { learningPatch } from '../src/learning-runner.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { apply as backgroundTools } from '../plugins/qq-agent-presets/background-tools.mjs';
import { apply as guard } from '../src/curator-tool-guard.mjs';

function row(id, source = 'group:10', origin = 'qq') {
  return {memoryId:id, content:'书架整理时先按主题分类，再按册数编号。' + id,
    metadata:{origin, sourceContext:source, evidenceReferences:[id]}, observedAt:'2026-11-20T00:00:00Z'};
}
function fixture(action = 'merge') {
  const rows = [row('a'), row('b')];
  const records = new Map(rows.map(r => [r.memoryId,r]));
  const state = {version:1, entries:{}};
  const calls = [];
  const gateway = {
    async read({memoryId,externalId}) {
      return memoryId ? records.get(memoryId) || null : [...records.values()].find(r => r.externalId === externalId) || null;
    },
    async save(input) {
      calls.push('save');
      records.set('new', {...input, memoryId:'new'});
      return {storedIds:['new'],skippedIds:[]};
    },
    async remove({memoryId}) { calls.push('remove'); return {deletedCount:Number(records.delete(memoryId))}; },
  };
  const deps = {state, persist(){}, gateway, list:async () => ({hits:[...records.values()]}),
    analyze:async () => {
      calls.push('analyze');
      return {text:JSON.stringify({action, members: action === 'keep' ? [] : [1,2], reason:'逐条核对', content:action === 'keep' ? '' : '核实后的书架分类步骤。'}), usage:{inputTokens:5,outputTokens:2}};
    }};
  return {records, rows, gateway, deps, state, calls};
}
test('candidates isolate sources and origins, exclude derived and superseded records, and track changed evidence', () => {
  const inputs = [row('a'), row('b'), row('other','group:11'), row('ambiguous','group:10 private:20'),
    row('unknown','旧记录'),row('self','group:10','assistant'),row('derived'),row('old')];
  inputs[6].metadata = {...inputs[6].metadata, curatorDecision:'x',supersedes:['old']};
  const [group] = curatorCandidates(inputs);
  assert.deepEqual(curatorCandidates(inputs).map(g=>g.rows.map(r=>r.memoryId)), [['a','b']]);
  assert.throws(()=>curatorDecision(JSON.stringify({action:'insight',members:[1,2],content:'x',reason:'y'}),group));
  assert.throws(()=>curatorDecision(JSON.stringify({action:'merge',members:[1,3],content:'x',reason:'y'}),group));
  assert.equal(curatorDecision(JSON.stringify({action:'merge',members:[1,2],content:'未核实数字 88888',reason:'整理'}),group).action,'keep');
  inputs[0].metadata.participants=['甲'];
  assert.notEqual(curatorCandidates(inputs)[0].id,group.id);
});
test('pause survives recreation, completed groups are not repeated and undo only removes the owned derivative', async () => {
  const f = fixture();
  const w = createCurator(f.deps);
  w.pause(true);
  await createCurator(f.deps).run();
  assert.deepEqual(f.calls,[]);
  w.pause(false);
  await w.run();
  assert.deepEqual(f.records.get('new').metadata.supersedes,['a','b']);
  assert.deepEqual(f.records.get('new').metadata.curatorSources,['a','b']);
  const restarted = createCurator(f.deps);
  await restarted.run();
  const [{id}] = restarted.status().recent;
  await restarted.undo(id);
  await restarted.run();
  assert.deepEqual(f.calls,['analyze','save','remove']);
  assert.deepEqual([...f.records.keys()], ['a','b']);
  assert.equal(restarted.status().recent[0].status,'undone');
});
test('lost write receipt recovers through external ID without repeating the model call or creating another output', async () => {
  const f = fixture('timeline');
  const save = f.gateway.save;
  f.gateway.save = async input => { await save(input); throw Error('连接中断'); };
  await assert.rejects(createCurator(f.deps).run(),/连接中断/);
  assert.equal(Object.values(f.state.entries)[0].status,'pending');
  await createCurator(f.deps).run();
  assert.equal(Object.values(f.state.entries)[0].status,'applied');
  assert.deepEqual(f.calls,['analyze','save']);
  assert.equal(f.records.get('new').metadata.supersedes,undefined);
});
test('a source edit during inference invalidates the decision and a modified output is never removed', async () => {
  const f = fixture();
  const analyze = f.deps.analyze;
  f.deps.analyze = async () => {
    const response = await analyze();
    f.records.set('a', {...f.rows[0],content:'编辑后的不同原文'});
    return response;
  };
  await createCurator(f.deps).run();
  assert.deepEqual(f.calls,['analyze']);
  assert.equal(Object.values(f.state.entries)[0].status,'stale');
  const g = fixture();
  const w = createCurator(g.deps);
  await w.run();
  g.records.get('new').content = '已被编辑';
  await assert.rejects(w.undo(w.status().recent[0].id), /已变化/);
  assert.equal(g.records.size,3);
});
test('reader rejects repeated cursors and the curator preset has no tool capability on either runner', async () => {
  await assert.rejects(readCuratorInventory(async()=>({hits:[],nextCursor:'same'})), /游标重复/);
  const presets = yaml.load(fs.readFileSync(new URL('../plugins/qq-agent-presets/presets/background.patch.yml',import.meta.url),'utf8'));
  const curator = presets[0].insert.find(p=>p.config.id==='memory-curator');
  assert.equal(curator.config.plugins[0].config.kind,'curator');
  const patch = yaml.load(learningPatch({mode:'curator',model:{provider:'test',model:'test'}}));
  assert.ok(patch.some(row=>row.insert?.some(p=>p.name.endsWith('/curator-tool-guard.mjs'))));
  const tools = { restrict(opts){assert.deepEqual(opts.allow,[])}, guard(check){assert.ok(check({name:'memory_save'}))} };
  guard({tools});
});

test('the named Host preset restricts the created agent and denies every tool execution', () => {
  let created, guardTool, prompt;
  backgroundTools({
    on(event, handler) { assert.equal(event,'agent/created'); created = handler; },
    tools:{guard(handler){guardTool=handler;}, register(){assert.fail('curator registered a tool');}},
    commands:{register(){}}, systemPrompt:{variable(_,factory){prompt=factory();}},
  }, {kind:'curator'});
  created({agent:{ctx:{tools:{restrict:rules => assert.deepEqual(rules.allow,[])}}}});
  assert.ok(guardTool({name:'memory_forget'}));
  assert.match(prompt,/旧记忆回顾员/);
});

test('console controls persist pause and schedule an inventory read through the production route', async t => {
  let scans = 0;
  const h = await bridgeHarness({config:{memory:{enabled:true,namespace:'fixture',apiKey:'fixture'}},
    globals:{listAMemorixParagraphs:async () => { scans++; return {hits:[],nextCursor:''}; }}});
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening',resolve));
  t.after(async () => {await new Promise(resolve=>server.close(resolve)); await h.close();});
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = {'x-console-token':'fixture-console-token','content-type':'application/json'};
  const post = (action, more={}) => fetch(base+'/api/memory/curator',{method:'POST',headers:{...headers,...more},body:JSON.stringify({action})});
  assert.equal((await post('pause', {'x-console-token':'wrong'})).status,401);
  assert.equal((await post('pause', {'x-agent-call':'1'})).status,403);
  assert.equal((await (await post('pause')).json()).curator.paused,true);
  const view = await (await fetch(base+'/api/memory/organizer',{headers})).json();
  assert.equal(view.organizer.curator.paused,true);
  assert.equal((await (await post('resume')).json()).curator.paused,false);
  assert.equal(scans,1);
});
