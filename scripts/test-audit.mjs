// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-sleep-commands.mjs', 'test-sleep-schedule.mjs', 'test-sleep-schedule-routes.mjs',
  'test-attention-delivery.mjs', 'test-qq-message-reference.mjs', 'test-native-message-references.mjs', 'test-qq-card.mjs',
  'test-poke-reminders.mjs', 'test-poke-send.mjs',
  'test-qq-backends.mjs', 'test-maa-agent.mjs',
  'test-forward.mjs', 'test-native-forward.mjs', 'test-forward-routes.mjs',
  'test-image-references.mjs', 'test-image-detail-routes.mjs', 'test-media-detail.mjs', 'test-native-image-quality.mjs',
  'test-chat-learning.mjs', 'test-access.mjs',
  'test-memory-curator.mjs', 'test-memory-consolidation.mjs', 'test-memory-organizer.mjs',
  'test-autonomy-policy.mjs', 'test-dsh-modules.mjs', 'test-audit-bridge.mjs', 'test-a-memorix-readonly.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  // DSH inbox 投影解析用于停止唯一全局 desktop-agent 前清理其排队工作。
  'test-dsh-inbox-projection.mjs',
  'test-dsh-diagnostics.mjs', 'test-dsh-mcp-management.mjs', 'test-dsh-mcp-routes.mjs',
  'test-compaction-host-modules.mjs',
  'test-md-to-plain.mjs', 'test-mux-reconnect.mjs',
  'test-qq-model-view.mjs', 'test-agent-preset-patches.mjs',
  'test-preset-prompt.mjs', 'test-preset-prompt-api.mjs',
  // 图片/表情链路（动图/表情包字段、CDN 兜底）+ 联网搜索
  // （DSH 同一路 DeepSeek 搜索、Bing RSS 兜底、凭据优先级与端点安全；
  //  本轮新增：空结果 note 必须在写缓存之前生成，否则缓存命中丢掉提示）。
  'test-media-search.mjs', 'test-media-normalize.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // 全局 desktop-agent 的本地执行护栏：注册期断言——
  // preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝，
  // 防止绕过桥接与会话边界直接操作 QQ/主机。
  'test-preset-local-tools.mjs',
  // qq-agent-presets settings use the bundle entry id and exported Config schema.
  'test-qq-agent-presets-settings.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
