// The same schema handles old config files and partial WebUI updates. Writing the
// normalized result drops retired controls without rewriting unrelated settings.
const defaults = {
  send: { delayPerCharMs: 20 },
  feedback: { maxLength: 500 },
  sticker: { syncEnabled: true, syncTtlMs: 60000, maxListCount: 100 },
};

function settings(schema, saved, changes) {
  const result = {};
  for (const [key, fallback] of Object.entries(schema)) {
    const candidates = [changes?.[key], saved?.[key], fallback];
    if (typeof fallback === 'boolean') {
      result[key] = candidates.find(value => typeof value === 'boolean');
    } else {
      const number = Number(candidates.find(value => Number.isFinite(value)
        || (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))));
      result[key] = Math.max(0, Math.round(number));
    }
  }
  return result;
}

export function qqChannelConfig(saved = {}, changes = {}) {
  saved ??= {};
  changes ??= {};
  const keywords = changes.attentionKeywords ?? saved.attentionKeywords;
  const names = new Map();
  for (const item of Array.isArray(keywords) ? keywords : []) {
    if (typeof item !== 'string') continue;
    const word = item.trim().normalize('NFKC');
    if (word.length >= 2 && word.length <= 64 && !names.has(word.toLocaleLowerCase())) {
      names.set(word.toLocaleLowerCase(), word);
      if (names.size === 50) break;
    }
  }
  const config = {
    ...settings({ enabled: true }, saved, changes),
    attentionKeywords: [...names.values()],
    media: { maxBytes: 8 * 1024 * 1024, maxPixels: 64000000, maxCount: 5, ...saved.media, ...changes.media },
  };
  if (saved.tools || changes.tools) config.tools = { ...saved.tools, ...changes.tools };
  for (const [key, schema] of Object.entries(defaults)) {
    config[key] = settings(schema, saved[key], changes[key]);
  }
  // Old files and clients have one switch for all role stickers.
  for (const key of ['regularEnabled', 'marketEnabled']) {
    config.sticker[key] = [changes.sticker?.[key], changes.sticker?.enabled,
      saved.sticker?.[key], saved.sticker?.enabled, true].find(value => typeof value === 'boolean');
  }
  config.sticker.enabled = config.sticker.regularEnabled || config.sticker.marketEnabled;
  // Before the two switches were separated, disabling stickers disabled sync too.
  config.sticker.syncEnabled = settings({ syncEnabled: saved.sticker?.enabled !== false },
    saved.sticker, changes.sticker).syncEnabled;
  config.sticker.collect = settings({ enabled: true, maxPerMinute: 2, maxPerHour: 10 },
    saved.sticker?.collect, changes.sticker?.collect);
  config.send.delayPerCharMs = Math.min(1000, config.send.delayPerCharMs);
  config.feedback.maxLength = Math.max(1, config.feedback.maxLength);
  config.sticker.maxListCount = Math.max(1, Math.min(500, config.sticker.maxListCount));
  return config;
}
