import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { toolResultDiagnostics, nextLlmRetryState, llmRetryFromSnapshot } from '../src/dsh-diagnostics.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const text = value => ({ type: 'text', text: value });
const unavailable = '[image unavailable: image/png; no attachment store is mounted; raw image data remains available to programmatic callers]';
const result = (content, extra = {}) => ({ type: 'tool/result', data: { message: { content }, ...extra } });
const retry = { type: 'llm/retry', time: Date.parse('2026-11-16T03:00:00.000Z'), data: {
  retryId: 'r1', retry: 2, maxRetries: 5, delayMs: 2000, provider: 'fixture', mode: 'normal',
  failure: { code: 'RATE_LIMIT', message: 'provider busy fixture-secret' },
} };
const redact = value => value.replaceAll('fixture-secret', '***');

test('tool diagnostics distinguish structured failure and image rejection without retaining successful text or bytes', () => {
  const diagnostic = toolResultDiagnostics(result([
    text('private QQ message body'), { type: 'image', attachment: { attachmentId: 'sha256:fixture' } }, text(unavailable),
  ]));
  assert.equal(diagnostic.ok, true);
  assert.deepEqual(diagnostic.imageAdmission, { status: 'partial', accepted: 1, rejected: 1, reasons: ['no attachment store is mounted'] });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private QQ|private-image/);
  assert.equal(toolResultDiagnostics(result([text(JSON.stringify({ quoted: unavailable }))])).imageAdmission, undefined);
  const failed = toolResultDiagnostics(result([text('problem fixture-secret')], { error: { code: 'TEST_ERROR', name: 'ToolError' } }), redact);
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'TEST_ERROR');
  assert.equal(failed.errorName, 'ToolError');
  assert.equal(failed.error, 'problem ***');
  assert.equal(toolResultDiagnostics(result([text('ok')])).error, null);
});

test('retry diagnostics track start, completion and reconnect snapshots without replaying a fresh delay', () => {
  const waiting = nextLlmRetryState(null, retry, { redact });
  assert.equal(waiting.retryAt, retry.time + 2000);
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.reason, 'provider busy ***');
  assert.equal(nextLlmRetryState(waiting, { type: 'llm/retry-started', data: { retryId: 'other' } }), waiting);
  const started = nextLlmRetryState(waiting, { type: 'llm/retry-started', data: { retryId: 'r1' } });
  assert.equal(started.waiting, false);
  assert.equal(started.retryAt, null);
  assert.equal(nextLlmRetryState(started, { type: 'turn/end' }), null);
  assert.equal(nextLlmRetryState(started, { type: 'assistant/message' }), null);
  assert.equal(nextLlmRetryState(started, { type: 'assistant/attempt' }), started);
  assert.equal(nextLlmRetryState(waiting, { type: 'llm/retry-started', data: { retryId: 'r1', retry: 1 } }), waiting);
  assert.deepEqual(llmRetryFromSnapshot([{ event: retry }], redact), waiting);
  assert.equal(llmRetryFromSnapshot([{ event: retry }, { event: { type: 'turn/end' } }]), null);
  assert.equal(llmRetryFromSnapshot([{ event: { ...retry, time: undefined } }]).retryAt, null);
  assert.equal(nextLlmRetryState(null, { type: 'llm/retry', data: { retry: 'bad' } }), null);
});

test('diagnostics omit encoded images, redact before truncating and never count raw or failed images as admitted', () => {
  const image = { type: 'image', data: 'private-image-bytes', mimeType: 'image/png' };
  assert.equal(toolResultDiagnostics(result([image])).imageAdmission, undefined);
  assert.equal(toolResultDiagnostics({ type: 'tool/result', data: { message: { isError: true, content: [
    { type: 'image', attachment: { attachmentId: 'sha256:fixture' } }, text(unavailable),
  ] } } }).imageAdmission, undefined);
  const diagnostic = toolResultDiagnostics(result([text('x'.repeat(490) + 'fixture-secret')], {
    error: { code: 'fixture-secret', name: 'fixture-secret' },
  }), redact);
  assert.equal(diagnostic.errorCode, undefined);
  assert.equal(diagnostic.errorName, undefined);
  assert.doesNotMatch(diagnostic.error, /fixture/);
  const encoded = toolResultDiagnostics(result([text('error data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(800))], { error: { code: 'BAD' } }));
  assert.doesNotMatch(encoded.error, /iVBOR|AAAA|data:image/);
  const arbitrary = toolResultDiagnostics(result([text(unavailable.replace('no attachment store is mounted', 'private-message-body'))]));
  assert.doesNotMatch(JSON.stringify(arbitrary), /private-message-body/);
});

async function deliver(h, frames) {
  let done;
  const consumed = new Promise(resolve => { done = resolve; });
  h.api.events.mux = async function* () {
    for (const frame of frames) yield { payload: frame };
    done();
    await new Promise(() => {});
  };
  void h.pumpMux();
  await consumed;
}

test('real bridge logs structured errors and rejected images, keeps memory text private and exposes retry state', async () => {
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const get = async route => (await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    headers: { 'x-console-token': 'fixture-console-token' },
  })).json();
  try {
    const sessionId = await h.ensureDesktopAgentSession();
    h.api.readSessionState = async () => ({ cursor: 5, active: true, running: true, blank: false, pendingInput: [] });
    const frame = event => ({ type: 'session/event', sessionId, event });
    await deliver(h, [
      frame({ type: 'tool/call', data: { callId: '1', name: 'mcp__qq__qq_get_message_images', arguments: '{}' } }),
      frame({ ...result([text('private-success-body'), text(unavailable)]), data: { message: { source: { callId: '1' }, content: [text('private-success-body'), text(unavailable)] } } }),
      frame({ type: 'tool/call', data: { callId: '2', name: 'mcp__qq-memory__memory_search', arguments: '{"query":"private-memory-query"}' } }),
      frame({ type: 'tool/result', data: { error: { code: 'MEMORY_ERROR' }, message: { source: { callId: '2' }, content: [text('private-memory-error')] } } }),
      frame(retry),
    ]);
    const log = await get('/api/socialV2/tool-log?failed=1');
    assert.equal(log.entries.length, 2);
    assert.equal(log.entries[0].ok, true);
    assert.equal(log.entries[0].imageAdmission.rejected, 1);
    assert.equal(log.entries[1].errorCode, 'MEMORY_ERROR');
    assert.equal(log.entries[1].error, '[memory error omitted]');
    const all = JSON.stringify(await get('/api/socialV2/tool-log'));
    assert.doesNotMatch(all, /private-success-body|private-memory-query|private-memory-error/);
    const status = await get('/api/console/desktop-agent');
    assert.deepEqual(status.pendingInput, []);
    assert.equal(status.dshRetry.retry, 2);
    assert.equal(status.dshRetry.waiting, true);
    h.api.readSessionState = async () => ({ cursor: 5, active: true, running: false, blank: false, pendingInput: ['approval'] });
    const paused = await get('/api/console/desktop-agent');
    assert.equal(paused.dshRetry, null);
    assert.deepEqual(paused.pendingInput, ['approval']);
    await h.recreateDesktopAgentSession();
    h.api.readSessionState = async () => ({ cursor: 0, active: true, running: true, blank: false, pendingInput: [] });
    assert.equal((await get('/api/console/desktop-agent')).dshRetry, null, 'a new session cannot inherit the previous retry');
    assert.equal(h.calls.sent.length, 0);
    assert.equal(h.calls.prompts.length, 0);
    const rawLogs = fs.readdirSync(path.join(h.temp, 'state')).filter(name => /tool.*log/.test(name));
    for (const name of rawLogs) assert.doesNotMatch(fs.readFileSync(path.join(h.temp, 'state', name), 'utf8'), /private-success-body|private-memory-query|private-memory-error/);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});
