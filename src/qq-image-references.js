import crypto from 'node:crypto';

// Session-local handles for media actually returned by QQ. Never accept a path,
// URL, or an unscoped digest as the detail endpoint's lookup key.
export function createQQImageReferences({ maxEntries = 2000, ttlMs = 24 * 60 * 60 * 1000, now = Date.now } = {}) {
  const entries = new Map();
  const identities = new Map();
  function remove(ref) {
    const entry = entries.get(ref);
    if (entry) identities.delete(entry.identity);
    entries.delete(ref);
  }
  function prune() {
    const cutoff = now() - ttlMs;
    for (const [ref, entry] of entries) if (entry.touched <= cutoff) remove(ref);
    while (entries.size > maxEntries) remove(entries.keys().next().value);
  }
  function remember({ account, key, media, context = {}, index = 1 }) {
    if (!account || !/^(group|private):[1-9]\d*$/.test(key) || !media || media.kind === 'face') return null;
    const savedMedia = {};
    for (const field of ['kind', 'file', 'url', 'emojiId', 'emojiPackageId', 'subType', 'summary', 'nativeForwardId', 'nativeMessageId']) {
      if (media[field] != null) savedMedia[field] = String(media[field]).slice(0, field === 'url' ? 8192 : 1024);
    }
    if (!savedMedia.file && !savedMedia.url && !savedMedia.emojiId) return null;
    const savedContext = { key, ...(context.messageId ? {messageId:String(context.messageId)} : {}),
      ...(context.forward ? {forward:true, forwardId:String(context.forwardId || savedMedia.nativeForwardId || '')} : {}) };
    const identity = JSON.stringify([String(account), key, savedContext, index, savedMedia]);
    prune();
    const existing = identities.get(identity);
    const ref = existing || `qqimg:${crypto.randomUUID()}`;
    if (existing) entries.delete(existing);
    entries.set(ref, {identity, account:String(account), key, media:savedMedia, context:savedContext, index, touched:now()});
    identities.set(identity, ref);
    prune();
    return ref;
  }
  function resolve(ref, {account, key}) {
    if (typeof ref !== 'string' || !/^qqimg:[0-9a-f-]{36}$/.test(ref)) return null;
    prune();
    const entry = entries.get(ref);
    if (!entry || !account || entry.account !== String(account) || entry.key !== key) return null;
    entries.delete(ref);
    entry.touched = now();
    entries.set(ref, entry);
    return {media:{...entry.media}, context:{...entry.context}, index:entry.index};
  }
  return { remember, resolve, clear() { entries.clear(); identities.clear(); } };
}
