// Loaded only by test-compaction-dsh.mjs in a separate DSH CLI with an empty DSH_HOME.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import DigitalRoleCompactionEngine from '../../plugins/qq-agent-presets/compaction-persona.mjs';

export const name = 'qq-compaction-host-check';

export async function apply() {
  const hostRequire = createRequire(process.argv[1]);
  const fromHost = async (specifier) => import(pathToFileURL(hostRequire.resolve(specifier)).href);
  const [{ default: BasicCompactionEngine }, { LlmError }, imageOffload] = await Promise.all([
    fromHost('@deepseek-ai/dsh-compaction-basic'),
    fromHost('@deepseek-ai/dsh-llm'),
    fromHost('@deepseek-ai/dsh-compaction-image-offload'),
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
    yield { type: 'text-delta', index: 0, text: 'fixture summary' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } };
  const result = await engine.summarize(input, agent, signal);
  assert.equal(result.summary[0].text, 'fixture summary');
  assert.equal(request.model, 'large');
  assert.equal(request.purpose, 'compaction');
  assert.equal(request.messages[0], input.messages[0]);
  process.stdout.write('QQ_COMPACTION_HOST_CHECK_OK\n', () => process.exit(0));
  // End this isolated test process before the CLI can schedule any model work.
  await new Promise(() => {});
}
