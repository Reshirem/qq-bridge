// Loaded only by test-compaction-dsh.mjs in a separate DSH CLI with an empty DSH_HOME.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import DigitalRoleCompactionEngine, { stripOuterSummaryTags } from '../../plugins/qq-agent-presets/compaction-persona.mjs';

export const name = 'qq-compaction-host-check';

export async function apply(ctx) {
  const hostRequire = createRequire(process.argv[1]);
  const fromHost = async (specifier) => import(pathToFileURL(hostRequire.resolve(specifier)).href);
  const [{ default: BasicCompactionEngine }, { LlmError }, imageOffload, prunerMod] = await Promise.all([
    fromHost('@deepseek-ai/dsh-compaction-basic'),
    fromHost('@deepseek-ai/dsh-llm'),
    fromHost('@deepseek-ai/dsh-compaction-image-offload'),
    fromHost('@deepseek-ai/dsh-compaction-tool-result-pruner'),
  ]);
  assert.equal(Object.getPrototypeOf(DigitalRoleCompactionEngine), BasicCompactionEngine);
  assert.equal(DigitalRoleCompactionEngine.prototype._registerAutomaticCompaction,
    BasicCompactionEngine.prototype._registerAutomaticCompaction);
  const engine = Object.create(DigitalRoleCompactionEngine.prototype);
  engine.config = { modelPolicies: [], summarizationProvider: '', summarizationModel: '', maxTokens: 1000 };
  const agent = {
    session: { id: 'isolated-fixture', requestHeader: () => ({ config: { provider: 'fixture', model: 'large' } }), toolHistory: () => [] },
    options: {},
  };
  const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture history' }] }] };
  const signal = new AbortController().signal;
  engine.ctx = { llm: { async *stream() {
    yield { type: 'finish', reason: { kind: 'error', failure: {
      code: 'IMAGE_OFFLOAD_REQUIRED', message: 'fixture images need offload', offloadImages: 1,
    } } };
  } } };
  let failure;
  try { await engine.summarize(input, agent, signal); } catch (error) { failure = error; }
  assert.ok(failure instanceof LlmError, 'summary errors must share the Host LlmError identity');
  assert.equal(failure.failure.offloadImages, 1);

  const imageListeners = new Map();
  imageOffload.apply({
    sessions: { registerMessageProjection() {} },
    on: (event, callback) => imageListeners.set(event, callback),
  });
  const appended = [];
  const recovered = await imageListeners.get('compaction/summary-error')({
    session: {
      eventAt: () => ({ type: 'tool/result' }),
      deriveEventMessage: () => ({ content: [{ type: 'image', attachmentId: 'fixture-image' }] }),
      append: (type, data) => appended.push({ type, data }),
    },
    sourceEventSeqs: [7], error: failure, signal,
  }, () => false);
  assert.equal(recovered, true, 'the installed image-offload handler must recognize the bridge summary error');
  assert.deepEqual(appended, [{ type: 'image/offload', data: { targets: [{ seq: 7, imageIndexes: [0] }] } }]);

  const listeners = new Map();
  engine.ctx = { on: (event, callback) => listeners.set(event, callback), logger: { info() {}, warn() {} } };
  engine._registerAutomaticCompaction();
  const switchModel = listeners.get('agent/request');
  assert.equal(typeof switchModel, 'function', 'the current Host model-switch protection must be inherited');
  const smaller = { provider: 'fixture', model: 'small' };
  const measurements = [];
  engine.compactPressure = async (...args) => { measurements.push(args); return null; };
  assert.equal(await switchModel({ agent, signal }, async () => smaller), smaller);
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0][1].config, smaller);
  assert.equal(measurements[0][3], true, 'model switches must require context below the target threshold');
  engine.compactPressure = async () => { throw new Error('fixture target too small'); };
  await assert.rejects(switchModel({ agent, signal }, async () => smaller),
    (error) => error instanceof LlmError && error.code === 'MODEL_SWITCH_COMPACTION_FAILED');
  assert.equal(agent.session.requestHeader().config.model, 'large');

  let request;
  engine.ctx = { llm: { async *stream(options) {
    request = options;
    yield { type: 'text-delta', index: 0, text: '<compacted-summary>\n<compacted-summary>\nfixture summary\n</compacted-summary>\n</compacted-summary>' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } };
  const result = await engine.summarize(input, agent, signal);
  assert.equal(result.summary[0].text, 'fixture summary');
  assert.equal(request.model, 'large');
  assert.equal(request.purpose, 'compaction');
  assert.equal(request.messages[0], input.messages[0]);
  assert.deepEqual(
    stripOuterSummaryTags([
      { type: 'text', text: '<compacted-summary>\n' },
      { type: 'text', text: 'inner body' },
      { type: 'text', text: '\n</compacted-summary>' },
    ]),
    [{ type: 'text', text: 'inner body' }],
  );

  // Verify the repository preset's compaction-basic and tool-result-pruner config load cleanly under the installed Host.
  const presetText = fs.readFileSync(new URL('../../dsh/agent-presets/desktop-agent/agent.cordis.yml', import.meta.url), 'utf8');
  assert.match(presetText, /thresholdRatio:\s*0\.65/);
  assert.match(presetText, /retainRatio:\s*0\.04/);
  assert.match(presetText, /headroomTokens:\s*16384/);
  assert.match(presetText, /maxTokens:\s*8192/);
  const prunerConfig = prunerMod.resolveConfig({ thresholdChars: 50000, headChars: 20000, tailChars: 4000 });
  assert.equal(prunerConfig.thresholdChars, 50000);
  const loadedEngine = new DigitalRoleCompactionEngine(
    ctx.isolate(['compaction']),
    { thresholdRatio: 0.65, headroomTokens: 16384, retainRatio: 0.04, maxTokens: 8192, auto: false },
  );
  assert.equal(loadedEngine.config.thresholdRatio, 0.65);
  assert.equal(loadedEngine.config.retainRatio, 0.04);
  assert.equal(loadedEngine.config.headroomTokens, 16384);
  assert.equal(loadedEngine.config.maxTokens, 8192);
  process.stdout.write('QQ_COMPACTION_HOST_CHECK_OK\n', () => process.exit(0));
  // End this isolated test process before the CLI can schedule any model work.
  await new Promise(() => {});
}
