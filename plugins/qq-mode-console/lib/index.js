import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

const DIAG = process.env.QQ_MODE_DIAG ?? path.join(os.tmpdir(), 'qq-mode-plugin.log');

function diag(message) {
  if (!DIAG) return;
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

export const name = 'qq-mode-console';
export const inject = ['settings'];
export const QQMODE_NAMESPACE = 'qq-mode';

// The historical namespace remains for profile compatibility; it now exposes
// only the operator identity setting and cannot select a runtime mode.
export const Config = z.object({
  ownerQQ: z.string()
    .description('管理员 QQ（ownerQQ）；留空表示不覆盖 config.json')
    .extra('volatile', true),
});

export function apply(ctx) {
  diag(`apply called; settings service=${typeof ctx.settings}; namespace=${QQMODE_NAMESPACE}`);
}
