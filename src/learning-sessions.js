import { unwrap } from './dsh-client.js';

// Only bridge-recorded headless sessions are candidates. Titles are not ownership evidence.
export function createLearningSessionCleanup({ api, getSessionIds, getProtectedSessionIds, isReady, sanitize, onArchived = () => {}, timeoutMs = 15000 }) {
  let pending = null;
  const candidates = () => [...new Set(getSessionIds())];
  const failure = (statusCode, message) => Object.assign(new Error(message), { statusCode });
  return {
    status: () => ({ tracked: candidates().length, cleanupBusy: Boolean(pending), dshReady: isReady() }),
    async cleanup({ wait = false } = {}) {
      while (wait && pending) await pending;
      if (pending) throw failure(409, '正在清理学习会话，请稍后再试');
      if (!isReady()) throw failure(503, 'DSH 当前不可用');
      let release;
      pending = new Promise(resolve => { release = resolve; });
      try {
        const result = { archived: [], alreadyArchived: [], skipped: [], failed: [] };
        const ids = candidates();
        if (!ids.length) return result;
        const [workspace, response] = await Promise.all([
          api.readWorkspaceState({ timeoutMs }),
          api.callUnary('session/list', {}, AbortSignal.timeout(timeoutMs)),
        ]);
        const listed = unwrap(response, 'session/list');
        if (!Array.isArray(listed?.items) || !Array.isArray(workspace?.archivedSessionIds)) {
          throw new Error('DSH 未返回有效的会话或归档列表');
        }
        const archived = new Set(workspace.archivedSessionIds);
        const sessions = new Map(listed.items.map(item => [item?.sessionId, item]));
        for (const sessionId of ids) {
          const item = sessions.get(sessionId);
          const label = { sessionId };
          // Recheck local ownership at each write: active learning processes and the main
          // agent may change while earlier sessions are being archived.
          if (getProtectedSessionIds().has(sessionId)) {
            result.skipped.push({ ...label, reason: '当前学习、主角色或记忆整理会话' });
          } else if (archived.has(sessionId)) {
            result.alreadyArchived.push(label);
          } else if (!item) {
            result.skipped.push({ ...label, reason: 'DSH 会话列表中不存在' });
          } else if (item.running !== false) {
            result.skipped.push({ ...label, reason: 'DSH 会话仍在运行或无法确认已结束' });
          } else {
            try {
              // DSH also rejects activity that started after the list snapshot. Never force-stop it.
              unwrap(await api.callUnary('workspace/archiveSession', { sessionId }, AbortSignal.timeout(timeoutMs)), 'workspace/archiveSession');
              result.archived.push(label);
            } catch (error) {
              result.failed.push({ ...label, error: sanitize(String(error?.message ?? error)).slice(0, 500) });
            }
          }
        }
        if (result.archived.length) onArchived(result.archived.length);
        return result;
      } catch (error) {
        throw failure(502, sanitize(String(error?.message ?? error)).slice(0, 700));
      } finally { pending = null; release(); }
    },
  };
}
