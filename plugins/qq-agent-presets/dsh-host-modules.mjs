import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const HOST_PACKAGES = new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host']);

/** Locate the process's DSH entry, never a profile or a second local installation. */
function hostRequire(entry) {
  if (typeof entry !== 'string' || !entry) {
    throw new Error('QQ 压缩模块必须由 DSH 宿主或 CLI 加载：缺少运行入口');
  }
  const file = fs.realpathSync(path.resolve(entry));
  let directory = path.dirname(file);
  for (;;) {
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest)) {
      const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (!HOST_PACKAGES.has(metadata.name)) {
        throw new Error('QQ 压缩模块必须由 DSH 宿主或 CLI 加载，不能使用桥接私有 DSH 依赖');
      }
      return createRequire(file);
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('无法确认当前 DSH 运行入口；QQ 压缩模块不会回退到另一份 DSH 安装');
}

/** Resolve the exact shared module files used by the running Host, including ASAR paths. */
export function resolveDshCompactionModules(entry = process.argv[1]) {
  const requireHost = hostRequire(entry);
  const compaction = requireHost.resolve('@deepseek-ai/dsh-compaction-basic');
  const llm = requireHost.resolve('@deepseek-ai/dsh-llm');
  const compactionLlm = createRequire(compaction).resolve('@deepseek-ai/dsh-llm');
  if (fs.realpathSync(compactionLlm) !== fs.realpathSync(llm)) {
    throw new Error('DSH 宿主的压缩与 LLM 模块来自不同实例，不能安全共享压缩错误处理');
  }
  return { compaction: pathToFileURL(compaction).href, llm: pathToFileURL(llm).href };
}

export async function loadDshCompactionModules() {
  const resolved = resolveDshCompactionModules();
  const [compaction, llm] = await Promise.all([import(resolved.compaction), import(resolved.llm)]);
  if (typeof compaction.default !== 'function' || typeof llm.BlockAssembler !== 'function'
      || typeof llm.LlmError?.fromFailure !== 'function') {
    throw new Error('当前 DSH 未提供 QQ 压缩所需的宿主 API，请更新 DSH 后重试');
  }
  return { BasicCompactionEngine: compaction.default, BlockAssembler: llm.BlockAssembler, LlmError: llm.LlmError };
}
