import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { unwrap, requireSequencedSessionProjection } from './dsh-client.js';
import { parseLearningResult } from './learning-runner.js';
import { MARKET_PAGE_SIZE } from './market-analysis.js';

export function learningSessionTitle(task, mode, now = new Date()) {
  const { key, pack } = JSON.parse(task);
  if (mode === 'market') return '商城表情分析 · ' + (String(pack || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '表情包');
  if (!key) return '后台学习 · 聊天批次';
  const time = now.toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `后台学习 · ${key} · ${time}`;
}

// Read the committed turn for this exact RPC. Other inputs in the same turn
// invalidate the result, including an operator steering a background session.
export async function runBackgroundTurn({ api, sessionId, preset, model, task, timeoutMs, signal, readRange, onEvent }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const rpc = async (method, payload) => unwrap(await api.callUnary(method, payload,
    AbortSignal.any([stop, AbortSignal.timeout(15000)])), method);
  const projection = requireSequencedSessionProjection(await rpc('session/projections', { sessionId }));
  if (projection?.values?.agentPreset !== preset) throw new Error('后台会话的 DSH preset 与任务不符');
  const state = await api.readSessionState(sessionId, { signal: stop });
  if (state?.running !== false || state.queue?.length || !Number.isSafeInteger(state.cursor)) throw new Error('后台会话尚未空闲或缺少持久游标');
  const current = projection.values.modelSelection?.next;
  if (!current || current.provider !== model.provider || current.model !== model.model || current.reasoningEffort !== model.reasoningEffort) {
    const selected = await rpc('commands/execute', {
      agentId: sessionId, line: '/qq-background-model ' + JSON.stringify(model), submittedAttachments: [],
    });
    if (selected?.result?.kind !== 'success') throw new Error('后台会话未能选择任务模型');
  }
  const requestId = randomUUID();
  let cursor = projection.asOfSeq;
  let myInput = false, otherInput = false, submitted = false;
  function trackInput(event) {
    if (event.type === 'turn/start') { myInput = false; otherInput = false; }
    if (event.type !== 'user/message') return;
    const source = event.data?.message?.source ?? event.data?.source;
    if (source?.rpcId === requestId) myInput = true;
    else if (source?.kind === 'user') otherInput = true;
  }
  try {
    submitted = true;
    const receipt = await rpc('session/prompt', { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: task }] });
    if (!receipt?.accepted) {
      submitted = false;
      throw new Error('DSH 未确认接收后台任务');
    }
    for (;;) {
      stop.throwIfAborted();
      const live = await api.readSessionState(sessionId, { signal: stop });
      if (!Number.isSafeInteger(live?.cursor)) throw new Error('无法读取后台会话进度');
      if (live.cursor > cursor) {
        const range = await readRange(sessionId, cursor, live.cursor, stop);
        if (!range.complete) throw new Error(range.error || '后台会话事件不完整');
        for (const row of range.records) {
          const ev = row.event ?? row;
          trackInput(ev);
          cursor = row.seq ?? ev.seq;
          if (!myInput) continue;
          if (otherInput) { submitted = false; throw new Error('后台回合包含其他输入，已停止处理'); }
          onEvent?.(ev);
          if (ev.type === 'turn/end') {
            submitted = false;
            if (ev.data?.reason?.kind !== 'completed') throw new Error('后台回合未正常完成');
            return;
          }
        }
      }
      await delay(500, undefined, { signal: stop });
    }
  } finally {
    if (submitted) {
      // Only withdraw our own inbox entry or interrupt a turn known to contain
      // our request. An operator can enqueue another turn in this same session.
      const cleanup = AbortSignal.timeout(8000);
      try {
        const live = await api.readSessionState(sessionId, { signal: cleanup });
        const queued = live?.queue?.find(item => item.rpcId === requestId);
        if (queued?.id) {
          await api.callUnary('session/updateQueue', { sessionId, itemId: queued.id, action: { kind: 'remove' } }, cleanup);
        } else if (live?.running && Number.isSafeInteger(live.cursor)) {
          // Refresh ownership through the current watermark even if prompt
          // acknowledgement was lost or cancellation arrived during polling.
          const remaining = await readRange(sessionId, cursor, live.cursor, cleanup);
          if (remaining.complete) {
            for (const row of remaining.records) {
              const ev = row.event ?? row;
              trackInput(ev);
              if (ev.type === 'turn/end') myInput = false;
            }
            if (myInput && !otherInput) await api.callUnary('session/cancel', { sessionId }, cleanup);
          }
        }
      } catch { /* A disconnected Host or an already-finished turn needs no further RPC. */ }
    }
  }
}

export function backgroundAnswerText(data) {
  const content = data?.message?.content ?? data?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content.filter(block => block?.type === 'text').map(block => block.text).join('') : '';
}

export function collectLearningTurn(mode, imageCount) {
  const calls = new Set(), pages = new Set();
  let text = '', sawImage = false;
  return {
    event({ type, data }) {
      const msg = data?.message;
      if (type === 'step/start') text = '';
      if (type === 'assistant/message') text = backgroundAnswerText(data);
      if (type === 'tool/call') {
        if (data.name !== 'mcp__qq-learning-images__learning_images') throw new Error('后台学习调用了非本批图片工具');
        calls.add(data.callId);
      }
      if (type === 'tool/result' && calls.delete(msg?.toolCallId ?? msg?.source?.callId) && !msg.isError && !data.error) {
        const blocks = msg.content ?? [];
        if (blocks.some(b => b.type === 'text' && /image unavailable|image admission rejected/i.test(b.text))) throw new Error('DSH 未能接收学习图片');
        const delivered = blocks.filter(b => b.type === 'image').length;
        if (!delivered) return;
        sawImage = true;
        for (const b of blocks) {
          const page = b.type === 'text' && /^QQ_PACK_PAGE=(\d+)$/.exec(b.text);
          if (!page) continue;
          const number = Number(page[1]);
          const expected = Math.min(MARKET_PAGE_SIZE, imageCount - (number - 1) * MARKET_PAGE_SIZE);
          if (number >= 1 && delivered === expected) pages.add(number);
        }
      }
    },
    result() {
      const result = parseLearningResult(text, mode);
      if (mode === 'market' && pages.size !== Math.ceil(imageCount / MARKET_PAGE_SIZE)) throw new Error('模型未读完整包表情图');
      if (result.stickers.length && !sawImage) throw new Error('模型未成功看图，拒绝保存表情描述');
      return result;
    },
  };
}
