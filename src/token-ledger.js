import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ZERO_BUCKETS, addBuckets, normalizeUsage, totalTokensOf, priceUsage } from './model-prices.js';
import { quoteRates, usdCost } from './model-catalog.js';

export const BUCKET_LADDER_MS = [
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  3 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  2 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000
];

/** 在不超过 maxBuckets 的前提下选最细的桶。 */
export function pickBucketMs(windowMs, maxBuckets) {
  for (const candidate of BUCKET_LADDER_MS) {
    if (windowMs / candidate <= maxBuckets) return candidate;
  }
  return BUCKET_LADDER_MS[BUCKET_LADDER_MS.length - 1];
}

/**
 * 从 assistant stream 记录里取最后一个 usage 采样。
 * 与 DSH `dsh-token-meter` 的 `lastAssistantStreamChunk(stream, 'usage')` 同义。
 */
export function usageFromStream(stream) {
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const chunk = stream[i];
    const usage = chunk?.chunk?.usage ?? chunk?.usage;
    if (usage !== undefined) return usage;
  }
  return undefined;
}

/**
 * 取一条会话事件携带的 provider usage（原始桶，未归一化）。
 * 与 DSH `usageOf(event)` 一致：assistant/message 优先用 data.usage，
 * 否则回落到 assistant/attempt / assistant/message 的 stream 尾部采样。
 */
export function usageOfEvent(event) {
  if (!event || typeof event !== 'object') return undefined;
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage;
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  return usageFromStream(event.data?.stream);
}

const cols = ['cacheMiss', 'cacheHit', 'cacheWrite', 'output'];
const counts = (b) => cols.map((k) => b[k]);
const featureKeys = new Set(['main', 'memory', 'learning', 'other']);

export function createTokenLedger({
  file,
  legacyFile,
  legacyTable,
  classifyLegacy,
  learningUsage,
  catalog,
  now = Date.now
}) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, feature TEXT NOT NULL,
      baseSeq INTEGER DEFAULT -1, cacheMiss INTEGER DEFAULT 0, cacheHit INTEGER DEFAULT 0,
      cacheWrite INTEGER DEFAULT 0, output INTEGER DEFAULT 0, legacySeq INTEGER DEFAULT -1,
      legacyTokens INTEGER DEFAULT 0, legacyCost REAL DEFAULT 0, scanned INTEGER DEFAULT -1);
    CREATE TABLE IF NOT EXISTS calls (sid TEXT NOT NULL, turn INTEGER, step INTEGER, retry INTEGER,
      seq INTEGER, t INTEGER, provider TEXT, model TEXT, cacheMiss INTEGER, cacheHit INTEGER,
      cacheWrite INTEGER, output INTEGER, reasoning INTEGER, legacy INTEGER NOT NULL, cost REAL, rate TEXT,
      PRIMARY KEY(sid,turn,step,retry)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS calls_time ON calls(t);
    CREATE INDEX IF NOT EXISTS calls_sequence ON calls(sid,seq) WHERE seq>=0;
    CREATE TABLE IF NOT EXISTS retries (sid TEXT, turn INTEGER, step INTEGER, seq INTEGER, retry INTEGER,
      PRIMARY KEY(sid,turn,step,seq)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS calls_pending ON calls(provider, model) WHERE legacy=0 AND cost IS NULL;`);
  const statementCache = new Map();
  function sql(query) {
    if (!statementCache.has(query)) statementCache.set(query, db.prepare(query));
    return statementCache.get(query);
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  function ensure(sid, feature) {
    if (!featureKeys.has(feature)) throw new Error('未知用量分类 ' + feature);
    sql(
      "INSERT INTO sessions(sid,feature) VALUES(?,?) ON CONFLICT(sid) DO UPDATE SET feature=excluded.feature WHERE sessions.feature='other'"
    ).run(sid, feature);
  }
  function writeBase(sid, seq, b) {
    sql(
      'UPDATE sessions SET baseSeq=?,cacheMiss=?,cacheHit=?,cacheWrite=?,output=? WHERE sid=? AND baseSeq<=?'
    ).run(seq, ...counts(b), sid, seq);
  }
  function put(row) {
    sql(`INSERT OR REPLACE INTO calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.sid,
      row.turn,
      row.step,
      row.retry,
      row.seq,
      row.t,
      row.provider || '',
      row.model || '',
      ...counts(row.b),
      row.b.reasoning ?? 0,
      row.legacy,
      row.cost ?? null,
      row.rate ? JSON.stringify(row.rate) : null
    );
  }
  function importLegacy() {
    if (sql("SELECT 1 FROM meta WHERE key='migrated'").get()) return;
    // Fold the last projection and the latest event for each old sample exactly as the old WebUI did.
    const sessions = new Map();
    const raw = legacyFile && fs.existsSync(legacyFile) ? fs.readFileSync(legacyFile, 'utf8') : '';
    for (const line of raw.split('\n')) {
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof r?.sid !== 'string' || !r.sid) continue;
      if (
        r.k === 'turn' &&
        (!Number.isSafeInteger(r.turn) || !Number.isSafeInteger(r.step) || !Number.isSafeInteger(r.seq))
      )
        continue;
      const s = sessions.get(r.sid) ?? { calls: new Map() };
      sessions.set(r.sid, s);
      if (r.key) s.key = r.key;
      if (r.k === 'turn') {
        const key = [r.turn, r.step, r.retry ?? 0].join('/');
        if (!s.calls.has(key) || s.calls.get(key).seq < r.seq) s.calls.set(key, r);
      } else if (r.k === 'base' && (!s.base || r.seq >= s.base.seq)) s.base = r;
      else if (r.k === 'evict' && (!s.evict || r.dropped > s.evict.dropped)) s.evict = r;
    }
    transaction(() => {
      for (const [sid, s] of sessions) {
        ensure(sid, classifyLegacy?.(sid, s.key) ?? 'other');
        let buckets = normalizeUsage(s.base?.b),
          seq = s.base?.seq ?? -1;
        const oldCost = (r, b) => priceUsage(b, { model: r.model, at: r.t, table: legacyTable }).cost.total;
        let cost = s.base ? oldCost(s.base, buckets) : 0;
        if (s.evict && !(s.base && s.evict.maxSeq >= 0 && s.base.seq >= s.evict.maxSeq)) {
          buckets = addBuckets(buckets, normalizeUsage(s.evict.b));
          cost += s.evict.cost || 0;
          seq = Math.max(seq, s.evict.maxSeq ?? -1);
        }
        for (const r of s.calls.values()) {
          const b = normalizeUsage(r.b);
          const amount = oldCost(r, b);
          put({ ...r, retry: r.retry ?? 0, b, cost: amount, legacy: 1 });
          if (!s.base || r.seq > s.base.seq) {
            buckets = addBuckets(buckets, b);
            cost += amount;
          }
          seq = Math.max(seq, r.seq);
        }
        writeBase(sid, seq, buckets);
        sql('UPDATE sessions SET legacySeq=?,legacyTokens=?,legacyCost=? WHERE sid=?').run(
          seq,
          totalTokensOf(buckets),
          cost,
          sid
        );
      }
      const b = normalizeUsage(learningUsage);
      if (totalTokensOf(b)) {
        ensure('learning-history', 'learning');
        writeBase('learning-history', 0, b);
      }
      sql("INSERT INTO meta VALUES('legacyCurrency',?),('legacySymbol',?),('migrated','1')").run(
        legacyTable?.currency ?? 'CNY',
        legacyTable?.symbol ?? '¥'
      );
    });
  }
  importLegacy();
  function ingestSample({ sessionId, feature, turn, step, retry = 0, seq, at, provider, model, usage }) {
    if (!sessionId || !Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return;
    const b = normalizeUsage(usage);
    if (!totalTokensOf(b)) return;
    // A snapshot may start after the retry marker; the same durable event still has one sequence.
    if (seq >= 0 && sql('SELECT 1 FROM calls WHERE sid=? AND seq=?').get(sessionId, seq)) return;
    const old = sql('SELECT * FROM calls WHERE sid=? AND turn=? AND step=? AND retry=?').get(
      sessionId,
      turn,
      step,
      retry
    );
    if (old && old.seq >= seq) return;
    ensure(sessionId, feature);
    const { legacySeq } = sql('SELECT legacySeq FROM sessions WHERE sid=?').get(sessionId);
    // Old baselines already include this history in their frozen legacy currency.
    const legacy = old?.legacy || (seq >= 0 && seq <= legacySeq) ? 1 : 0;
    if (old?.legacy) return;
    provider ||= old?.provider;
    model ||= old?.model;
    const savedRate = old?.rate ? JSON.parse(old.rate) : null;
    const rate = legacy ? null : (savedRate ?? quoteRates(catalog.get(provider, model), b));
    const cost = rate ? usdCost(b, rate) : null;
    put({ sid: sessionId, turn, step, retry, seq, t: at || now(), provider, model, b, legacy, cost, rate });
    if (!rate && !legacy && provider && model) catalog.auto(true);
  }
  function ingestEvent({ sessionId, feature = 'main', event, provider, model }) {
    if (!event?.data) return;
    const { turn, step } = event.data;
    if (event.type === 'llm/retry-started') {
      if (Number.isSafeInteger(turn) && Number.isSafeInteger(step) && Number.isSafeInteger(event.seq)) {
        sql('INSERT OR IGNORE INTO retries VALUES(?,?,?,?,?)').run(
          sessionId,
          turn,
          step,
          event.seq,
          event.data.retry ?? 1
        );
      }
      return;
    }
    const usage = usageOfEvent(event);
    if (!usage) return;
    if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return;
    const marker = sql(
      'SELECT retry FROM retries WHERE sid=? AND turn=? AND step=? AND seq<=? ORDER BY seq DESC LIMIT 1'
    ).get(sessionId, turn, step, event.seq ?? -1);
    ingestSample({
      sessionId,
      feature,
      turn,
      step,
      retry: marker?.retry ?? 0,
      seq: event.seq ?? -1,
      at: event.time,
      provider: event.data.message?.source?.provider ?? event.data.provider ?? provider,
      model: event.data.message?.source?.model ?? usage.model ?? event.data.model ?? model,
      usage
    });
  }
  function ingestRecords({ sessionId, feature = 'main', records, selection }) {
    for (const item of records ?? []) {
      const event = item.event ?? item;
      if (event.type === 'model/selection') selection = event.data;
      ingestEvent({ sessionId, feature, event, ...selection });
    }
  }
  function ingestBaseline({ sessionId, feature = 'main', projection }) {
    const b = projection?.values?.tokenUsage;
    if (!b || !Number.isSafeInteger(projection.asOfSeq)) return;
    ensure(sessionId, feature);
    writeBase(sessionId, projection.asOfSeq, normalizeUsage(b));
  }
  function settle() {
    transaction(() => {
      for (const row of sql('SELECT * FROM calls WHERE legacy=0 AND cost IS NULL').all()) {
        const rate = quoteRates(catalog.get(row.provider, row.model), row);
        if (rate)
          sql(
            'UPDATE calls SET cost=?,rate=? WHERE sid=? AND turn=? AND step=? AND retry=? AND cost IS NULL'
          ).run(usdCost(row, rate), JSON.stringify(rate), row.sid, row.turn, row.step, row.retry);
      }
    });
  }
  const legacyCurrency = sql("SELECT value FROM meta WHERE key='legacyCurrency'").get()?.value ?? 'CNY';
  const legacySymbol = sql("SELECT value FROM meta WHERE key='legacySymbol'").get()?.value ?? '¥';
  function summary() {
    const groups = new Map();
    // Only the tokens after a session's last projection are additive. Costs always belong to individual calls.
    const rows = sql(`SELECT s.*, COUNT(c.sid) steps, COUNT(DISTINCT c.turn) turns,
      ${cols.map((k) => 'COALESCE(SUM(CASE WHEN (c.seq>s.baseSeq OR (s.baseSeq=-1 AND c.seq=-1)) THEN c.' + k + ' ELSE 0 END),0) AS live_' + k).join(',')},
      COALESCE(SUM(CASE WHEN c.legacy=0 THEN c.cost END),0) cost,
      COALESCE(SUM(CASE WHEN c.legacy=0 AND c.cost IS NOT NULL THEN ${cols.map((k) => 'c.' + k).join('+')} ELSE 0 END),0) pricedTokens
      FROM sessions s LEFT JOIN calls c ON c.sid=s.sid GROUP BY s.sid`).all();
    function group(key) {
      return {
        key,
        buckets: { ...ZERO_BUCKETS },
        turns: 0,
        steps: 0,
        cost: 0,
        legacyCost: 0,
        pendingTokens: 0
      };
    }
    const totals = group('total');
    for (const r of rows) {
      const g = groups.get(r.feature) ?? group(r.feature);
      groups.set(r.feature, g);
      const usage = Object.fromEntries(cols.map((k) => [k, r[k] + r['live_' + k]]));
      for (const v of [g, totals]) {
        v.buckets = addBuckets(v.buckets, usage);
        v.turns += r.turns;
        v.steps += r.steps;
        v.cost += r.cost;
        v.legacyCost += r.legacyCost;
        v.pendingTokens += Math.max(0, totalTokensOf(usage) - r.legacyTokens - r.pricedTokens);
      }
    }
    totals.totalTokens = totalTokensOf(totals.buckets);
    totals.inputTokens = totals.totalTokens - totals.buckets.output;
    totals.cacheHitRate = totals.inputTokens ? totals.buckets.cacheHit / totals.inputTokens : 0;
    const models = sql(
      "SELECT DISTINCT provider,model FROM calls WHERE provider<>'' AND model<>'' ORDER BY provider,model"
    )
      .all()
      .map((r) => ({ ...r, price: catalog.get(r.provider, r.model) }));
    const features = [...featureKeys].filter((key) => groups.has(key)).map((key) => groups.get(key));
    return {
      ok: true,
      symbol: '$',
      legacySymbol,
      legacyCurrency,
      totals,
      features,
      conversations: features, // Compatibility with older console clients.
      prices: { ...catalog.status(), models }
    };
  }
  function conversation(key, { turnLimit = 200 } = {}) {
    if (!featureKeys.has(key)) return null;
    const rows = sql(`SELECT c.sid sessionId,c.turn,MAX(t) endedAt,COUNT(*) steps,
      ${cols.map((k) => 'SUM(c.' + k + ') ' + k).join(',')},
      SUM(CASE WHEN legacy=0 THEN cost ELSE 0 END) cost,SUM(CASE WHEN legacy=1 THEN cost ELSE 0 END) legacyCost,
      SUM(CASE WHEN legacy=0 AND cost IS NULL THEN (${cols.map((k) => 'c.' + k).join('+')}) ELSE 0 END) pendingTokens
      FROM calls c JOIN sessions s ON s.sid=c.sid WHERE feature=? GROUP BY c.sid,c.turn
      ORDER BY endedAt DESC LIMIT ?`).all(key, turnLimit);
    return { ok: true, key, legacySymbol, turns: rows.map((r) => ({ ...r, buckets: normalizeUsage(r) })) };
  }
  function recent(limit = 50) {
    return sql(`SELECT c.*,feature AS key,t AS time, CASE WHEN legacy=1 THEN cost ELSE 0 END AS legacyCost
      FROM calls c JOIN sessions s ON s.sid=c.sid ORDER BY t DESC LIMIT ?`)
      .all(limit)
      .map(({ rate, legacy, cost, ...r }) => ({
        ...r,
        cost: legacy ? 0 : cost,
        pending: !legacy && cost == null
      }));
  }
  function series({ hours = 24, maxBuckets = 48, at = now() } = {}) {
    const bucketMs = pickBucketMs(hours * 3600000, maxBuckets);
    const end = (Math.floor(at / bucketMs) + 1) * bucketMs,
      count = Math.ceil((hours * 3600000) / bucketMs),
      start = end - count * bucketMs;
    const buckets = Array.from({ length: count }, (_, i) => ({
      t: start + i * bucketMs,
      cost: 0,
      legacyCost: 0,
      tokens: 0,
      steps: 0,
      turns: 0,
      keys: []
    }));
    for (const r of sql(`SELECT CAST(t/? AS INTEGER)*? t, SUM(CASE WHEN legacy=0 THEN cost ELSE 0 END) cost,
      SUM(CASE WHEN legacy=1 THEN cost ELSE 0 END) legacyCost, SUM(${cols.map((k) => 'c.' + k).join('+')}) tokens,
      ${cols.map((k) => 'SUM(c.' + k + ') ' + k).join(',')}, COUNT(*) steps, COUNT(DISTINCT c.sid||'/'||turn) turns,
      GROUP_CONCAT(DISTINCT feature) features FROM calls c JOIN sessions s ON s.sid=c.sid
      WHERE t>=? AND t<? GROUP BY CAST(t/? AS INTEGER)`).all(bucketMs, bucketMs, start, end, bucketMs)) {
      Object.assign(buckets[(r.t - start) / bucketMs], r, { keys: r.features.split(',') });
    }
    return {
      ok: true,
      symbol: '$',
      legacySymbol,
      bucketMs,
      buckets,
      countedSamples: buckets.reduce((n, b) => n + b.steps, 0)
    };
  }
  return {
    ingestEvent,
    ingestBaseline,
    ingestSample,
    settle,
    summary,
    conversation,
    recent,
    series,
    legacySymbol,
    ingestSnapshotRecords(input) {
      transaction(() => ingestRecords(input));
    },
    hasUnpriced() {
      return Boolean(
        sql(
          "SELECT 1 FROM calls WHERE legacy=0 AND cost IS NULL AND provider<>'' AND model<>'' LIMIT 1"
        ).get()
      );
    },
    cursor(sid) {
      return sql('SELECT scanned FROM sessions WHERE sid=?').get(sid)?.scanned ?? -1;
    },
    importMemory(sessionId, records, selection, throughSeq) {
      transaction(() => {
        ensure(sessionId, 'memory');
        ingestRecords({ sessionId, feature: 'memory', records, selection });
        sql('UPDATE sessions SET scanned=MAX(scanned,?) WHERE sid=?').run(throughSeq, sessionId);
      });
    },
    reset() {
      transaction(() => {
        db.exec('DELETE FROM calls; DELETE FROM sessions; DELETE FROM retries');
      });
    },
    close() {
      db.close();
    }
  };
}
