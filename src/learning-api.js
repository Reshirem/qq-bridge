// Console-only management. The bridge's central token/Origin checks run first.
export async function handleLearningRequest({ req, url, readBody, sendJson, res, headers, store, worker, config, saveConfig, assets, mimeFromBuffer, error = '' }) {
  const route = url.pathname;
  if (!(route === '/api/slang' || route.startsWith('/api/slang/') || route.startsWith('/api/learning/'))) return false;
  try {
    if (!store) { sendJson({ ok: false, error: error || '聊天学习库不可用，已保留原文件' }, 503); return true; }
    if (req.method === 'GET' && route === '/api/learning/status') {
      const state = store.snapshot(), sources = new Map();
      for (const item of state.queue) sources.set(item.key, (sources.get(item.key) || 0) + 1);
      sendJson({ ok: true, config, running: worker.running, pending: state.queue.length, failedMessages: state.queue.filter(m => (m.attempts || 0) >= 3).length, sources: [...sources].map(([key, count]) => ({ key, count })), lastRunAt: state.lastRunAt, nextRunAt: state.nextRunAt, lastError: state.lastError, lastResult: state.lastResult, runs: state.runs, dropped: state.dropped, words: state.slang.length, pictures: state.stickers.length, usage: state.usage });
    } else if (req.method === 'POST' && route === '/api/learning/settings') {
      const body = await readBody();
      if (body.sources !== undefined && (!Array.isArray(body.sources) || body.sources.some(k => typeof k !== 'string' || !/^(group|private):\d+$/.test(k)))) throw new Error('学习来源必须是合法 QQ 会话 key 列表');
      const updated = saveConfig(body);
      worker.cancel();
      sendJson({ ok: true, config: updated });
    } else if (req.method === 'POST' && route === '/api/learning/run') {
      if (!config.enabled) throw new Error('请先启用后台学习');
      if (worker.running) throw new Error('已有学习任务正在运行');
      if (!store.batch(config, Date.now(), true)) throw new Error('没有符合来源范围的待学习消息');
      void worker.tick(true).catch(() => {});
      sendJson({ ok: true, running: true }, 202);
    } else if (req.method === 'GET' && route === '/api/learning/stickers/image') {
      const entry = store.snapshot().stickers.find(e => e.id === url.searchParams.get('id') && e.scope === url.searchParams.get('scope'));
      if (!entry) { sendJson({ ok: false, error: '表情不存在' }, 404); return true; }
      const buffer = assets.read(entry.hash), mime = mimeFromBuffer(buffer);
      if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) throw new Error('不支持的图片格式');
      res.writeHead(200, { ...headers, 'content-type': mime }); res.end(buffer);
    } else {
      const kind = route.startsWith('/api/slang') ? 'slang' : 'stickers';
      const base = kind === 'slang' ? '/api/slang' : '/api/learning/stickers';
      if (req.method === 'GET' && route === base) {
        const query = String(url.searchParams.get('query') || '').toLowerCase(), scope = url.searchParams.get('scope'), status = url.searchParams.get('status');
        const list = store.snapshot()[kind].filter(e => (!scope || e.scope === scope) && (!status || e.status === status) && (!query || [e.content, e.meaning, e.desc, e.usage, ...(e.tags || [])].join(' ').toLowerCase().includes(query))).reverse();
        const offset = Math.max(0, Math.min(list.length, Math.floor(Number(url.searchParams.get('offset')) || 0)));
        sendJson({ ok: true, total: list.length, offset, items: list.slice(offset, offset + 30), hasMore: offset + 30 < list.length });
      } else if (req.method === 'POST' && route === base) {
        sendJson({ ok: true, entry: store.edit(kind, await readBody()) });
      } else if (req.method === 'POST' && route === `${base}/delete`) {
        const body = await readBody();
        store.remove(kind, String(body.id ?? ''), String(body.scope ?? ''));
        if (!worker.running) assets.collectUnused(store.snapshot().stickers.map(e => e.hash));
        sendJson({ ok: true });
      } else sendJson({ ok: false, error: '未知学习接口' }, 404);
    }
  } catch (error) { sendJson({ ok: false, error: error.message }, 400); }
  return true;
}
