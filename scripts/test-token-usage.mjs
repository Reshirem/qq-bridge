import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModelCatalog, catalogPrices, quoteRates, usdCost } from '../src/model-catalog.js';
import { createTokenLedger } from '../src/token-ledger.js';

const fixture = (input) => ({
  service: { models: { m: { cost: { input, output: 3, cache_read: 0.2, cache_write: 1 } } } }
});
const b = { cacheMiss: 300000, cacheHit: 100000, cacheWrite: 50000, output: 10000 };
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('refresh only fills unpriced calls, including after restart and snapshot replay', async (t) => {
  const dir = workspace(t),
    dbFile = path.join(dir, 'usage.db'),
    priceFile = path.join(dir, 'prices.json');
  let ledger,
    data = fixture(1),
    hits = 0;
  const options = {
    file: priceFile,
    persist: (file, next) => fs.writeFileSync(file, JSON.stringify(next)),
    onRefresh: () => ledger.settle(),
    fetchCatalog: async () => ({
      ok: true,
      json: async () => {
        hits++;
        return data;
      }
    })
  };
  const catalog = createModelCatalog(options);
  const open = () => createTokenLedger({ file: dbFile, catalog });
  ledger = open();
  try {
    const event = (turn, seq, provider = 'service') => ({
      seq,
      time: Date.now(),
      type: 'assistant/message',
      data: { turn, step: 1, message: { source: { provider, model: 'm' } }, usage: b }
    });
    const ingest = (e) => ledger.ingestEvent({ sessionId: 's', event: e });
    ingest(event(1, 1));
    await catalog.refresh();
    const original = 0.4; // 0.30 miss + 0.02 read + 0.05 write + 0.03 output
    const near = (expected) => assert.ok(Math.abs(ledger.summary().totals.cost - expected) < 1e-9);
    near(original);
    data = fixture(5);
    await Promise.all([catalog.refresh(true), catalog.refresh(true)]);
    assert.equal(hits, 2);
    ingest(event(1, 1));
    ingest(event(2, 2));
    near(original + 1.6);
    ledger.ingestBaseline({
      sessionId: 's',
      projection: {
        asOfSeq: 3,
        values: {
          tokenUsage: {
            inputTokens: 600000,
            cacheReadTokens: 200000,
            cacheWriteTokens: 100000,
            outputTokens: 20000
          }
        }
      }
    });
    ingest(event(3, 4, 'unlisted'));
    near(2);
    assert.equal(ledger.summary().totals.pendingTokens, 460000);
    assert.equal(
      ledger.series().buckets.reduce((n, r) => n + (r.cost || 0), 0),
      2
    );
    assert.equal(ledger.conversation('main').turns.length, 3);
    data.unlisted = { models: { m: { cost: { input: 0, output: 0 } } } };
    await catalog.refresh(true);
    near(2);
    assert.equal(ledger.summary().totals.pendingTokens, 0);
    ledger.close();
    ledger = open();
    near(2);
    assert.equal(ledger.recent().find((r) => r.provider === 'unlisted').pending, false);
  } finally {
    ledger.close();
  }
});

test('catalog uses route, context thresholds, cache and reasoning rates, and throttles automatic refresh', async (t) => {
  const dir = workspace(t);
  const prices = catalogPrices({
    p: {
      models: {
        m: {
          cost: {
            input: 1,
            output: 3,
            reasoning: 2,
            cache_read: 0,
            tiers: [{ tier: { type: 'context', size: 10 }, input: 4, output: 5, reasoning: 6 }]
          }
        }
      }
    }
  });
  const row = { cacheMiss: 10, cacheHit: 0, cacheWrite: 0, output: 10, reasoning: 5 };
  assert.equal(usdCost(row, quoteRates(prices['p/m'], row)), 35 / 1e6);
  assert.equal(quoteRates(prices['p/m'], { ...row, cacheHit: 1 }).input, 4);
  let time = 86400000,
    hits = 0,
    fail = false;
  const file = path.join(dir, 'prices'),
    persist = (f, v) => fs.writeFileSync(f, JSON.stringify(v));
  const catalog = createModelCatalog({
    file,
    persist,
    now: () => time,
    fetchCatalog: async () => {
      hits++;
      if (fail) throw Error('offline');
      return { ok: true, json: async () => fixture(7) };
    }
  });
  await catalog.refresh();
  await catalog.refresh(false, true);
  assert.equal(hits, 1);
  time += 3600001;
  await catalog.refresh();
  assert.equal(hits, 1);
  await catalog.refresh(false, true);
  assert.equal(hits, 2);
  time += 86400001;
  fail = true;
  await assert.rejects(catalog.refresh(), /offline/);
  assert.equal(catalog.get('service', 'm').input, 7);
  await catalog.refresh();
  assert.equal(hits, 3);
  assert.equal(createModelCatalog({ file, persist }).get('service', 'm').input, 7);
});

test('legacy baseline and live samples keep their old currency and migrate once; features stay separate', (t) => {
  const dir = workspace(t),
    legacyFile = path.join(dir, 'old'),
    file = path.join(dir, 'new.db');
  const at = Date.parse('2026-11-07T20:00:00+08:00');
  const old = [
    {
      k: 'base',
      sid: 'old',
      seq: 10,
      t: at,
      key: 'desktop-agent',
      model: 'deepseek-flash',
      b: { cacheMiss: 1000000 }
    },
    { k: 'turn', sid: 'old', seq: 5, t: at, turn: 1, step: 1, b: { cacheMiss: 500000 } },
    { k: 'turn', sid: 'old', seq: 12, t: at, turn: 2, step: 1, b: { output: 1000000 } }
  ];
  fs.writeFileSync(legacyFile, old.map((x) => JSON.stringify(x)).join('\n'));
  const catalog = { get: () => null, auto() {}, status: () => ({}) };
  const options = {
    file,
    legacyFile,
    catalog,
    classifyLegacy: () => 'main',
    learningUsage: { inputTokens: 150 }
  };
  let ledger = createTokenLedger(options);
  try {
    const records = [
      {
        seq: 4,
        type: 'assistant/attempt',
        time: at,
        data: { turn: 1, step: 1, stream: [{ chunk: { type: 'usage', usage: { outputTokens: 5 } } }] }
      },
      { seq: 5, type: 'llm/retry-started', data: { turn: 1, step: 1, retry: 1 } },
      { seq: 6, type: 'assistant/message', time: at, data: { turn: 1, step: 1, usage: { outputTokens: 12 } } }
    ];
    ledger.importMemory('org', records, { provider: 'x', model: 'm' }, 6);
    ledger.importMemory('org', records, { provider: 'x', model: 'm' }, 6);
    const learning = {
      feature: 'learning',
      sessionId: 'batch',
      turn: 1,
      step: 1,
      seq: -1,
      usage: { inputTokens: 7 }
    };
    ledger.ingestSample(learning);
    ledger.ingestSample(learning);
    const summary = ledger.summary();
    assert.equal(summary.totals.legacyCost, 5);
    assert.equal(summary.totals.totalTokens, 2000000 + 150 + 17 + 7);
    assert.equal(summary.totals.pendingTokens, 174);
    assert.equal(ledger.conversation('memory').turns[0].steps, 2);
    assert.equal(ledger.conversation('main').turns.length, 2);
    ledger.close();
    ledger = createTokenLedger(options);
    assert.equal(ledger.summary().totals.legacyCost, 5);
    ledger.reset();
    ledger.close();
    ledger = createTokenLedger(options);
    assert.equal(ledger.summary().totals.totalTokens, 0);
    assert.equal(fs.readFileSync(legacyFile, 'utf8').split('\n').length, 3);
  } finally {
    ledger.close();
  }
});
