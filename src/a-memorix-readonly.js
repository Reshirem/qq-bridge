import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const READER_SCRIPT = path.join(ROOT, 'scripts', 'a-memorix-readonly-list.py');
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function boundedLimit(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
}

export function listAMemorixParagraphs({ stateDir, namespace, query = '', origin = 'all', timeStart = '', timeEnd = '', cursor = '', limit = DEFAULT_LIMIT } = {}) {
  const python = path.join(stateDir, 'venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(python) || !fs.existsSync(READER_SCRIPT)) {
    return Promise.reject(new Error('A_Memorix 本机只读账本读取器未安装完整'));
  }

  const request = JSON.stringify({
    stateDir,
    namespace,
    query: String(query || '').slice(0, 2000),
    origin: String(origin || 'all'),
    timeStart: String(timeStart || ''),
    timeEnd: String(timeEnd || ''),
    cursor: String(cursor || '').slice(0, 1024),
    limit: boundedLimit(limit)
  });

  return new Promise((resolve, reject) => {
    // This helper's JSON is decoded by Node as UTF-8; force Python stdout/stderr
    // to UTF-8 too because Windows otherwise uses the active GBK code page.
    execFile(python, ['-X', 'utf8', READER_SCRIPT, request], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || '').trim().replace(/^ERROR:\s*/, '').slice(0, 400);
        reject(new Error(detail || '读取本机 A_Memorix 记录失败'));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('本机只读账本读取器返回了无效结果'));
      }
    });
  });
}
