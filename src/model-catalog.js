// models.dev prices are USD per million tokens, keyed by provider AND model.
import fs from 'node:fs';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = DAY / 24;
const valid = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function rates(cost, base) {
  const input = cost?.input ?? base?.input;
  const output = cost?.output ?? base?.output;
  if (!valid(input) || !valid(output)) return null;
  const read = cost?.cache_read ?? base?.cache_read ?? input;
  const write = cost?.cache_write ?? base?.cache_write ?? input;
  const reasoning = cost?.reasoning ?? base?.reasoning ?? output;
  return valid(read) && valid(write) && valid(reasoning)
    ? { input, output, cache_read: read, cache_write: write, reasoning }
    : null;
}
export function catalogPrices(data) {
  const prices = Object.create(null);
  for (const [provider, p] of Object.entries(data ?? {})) {
    for (const [model, m] of Object.entries(p?.models ?? {})) {
      const cost = m?.cost;
      const base = rates(cost);
      if (!base) continue;
      const tiers =
        Array.isArray(cost.tiers) && cost.tiers.length
          ? cost.tiers
          : cost.context_over_200k
            ? [{ tier: { type: 'context', size: 200000 }, ...cost.context_over_200k }]
            : [];
      prices[provider + '/' + model] = {
        ...base,
        tiers: tiers
          .filter((t) => t.tier?.type === 'context' && valid(t.tier.size) && rates(t, cost))
          .map((t) => ({ above: t.tier.size, ...rates(t, cost) }))
          .sort((a, b) => a.above - b.above)
      };
    }
  }
  if (!Object.keys(prices).length) throw new Error('models.dev 未返回有效价目表');
  return prices;
}
export function quoteRates(price, b) {
  if (!price) return null;
  const input = b.cacheMiss + b.cacheHit + b.cacheWrite;
  return (price.tiers ?? []).filter((t) => input > t.above).at(-1) ?? price;
}
export function usdCost(b, rate) {
  const reasoning = Math.min(b.reasoning || 0, b.output);
  return (
    (b.cacheMiss * rate.input +
      b.cacheHit * rate.cache_read +
      b.cacheWrite * rate.cache_write +
      (b.output - reasoning) * rate.output +
      reasoning * (rate.reasoning ?? rate.output)) /
    1e6
  );
}
export function createModelCatalog({
  file,
  persist,
  fetchCatalog = fetch,
  now = Date.now,
  onRefresh,
  log = () => {}
}) {
  let cache = { updatedAt: 0, prices: {} },
    pending,
    lastAttempt = -Infinity,
    error = '';
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version === 1 && saved.prices && Number.isFinite(saved.updatedAt)) cache = saved;
  } catch (e) {
    if (e.code !== 'ENOENT') log('价目表缓存读取失败', e.message);
  }
  function refresh(force = false, missing = false) {
    if (pending) return pending;
    const age = now() - cache.updatedAt;
    if (!force && ((cache.updatedAt && age < (missing ? HOUR : DAY)) || now() - lastAttempt < HOUR))
      return Promise.resolve();
    lastAttempt = now();
    pending = (async () => {
      const res = await fetchCatalog('https://models.dev/api.json', { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('models.dev HTTP ' + res.status);
      const next = { version: 1, updatedAt: now(), prices: catalogPrices(await res.json()) };
      persist(file, next);
      cache = next;
      onRefresh?.();
      error = '';
    })()
      .catch((e) => {
        error = e.message;
        log('刷新模型价目表失败', error);
        throw e;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }
  return {
    refresh,
    status: () => ({ updatedAt: cache.updatedAt, error, refreshing: Boolean(pending) }),
    get: (provider, model) => cache.prices[provider + '/' + model] ?? null,
    auto(missing = false) {
      void refresh(false, missing).catch(() => {});
    }
  };
}
