import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpeg } from './ffmpeg-resolve.js';
import { sniffImage } from './media-normalize.js';

export const VIDEO_DEFAULTS = Object.freeze({
  maxVideoBytes: 50 * 1024 * 1024,
  hardMaxVideoBytes: 100 * 1024 * 1024,
  maxModelBytes: 1024 * 1024,
  defaultShortFrames: 6,
  defaultFrames: 9,
  maxFrames: 12,
  tileBox: 360,
  timeoutMs: 30000
});

const HARD_MAX_MODEL_BYTES = Math.floor(3.0 * 1024 * 1024);
const VIDEO_FORMAT_WHITELIST = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,flv';

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function formatVideoTimestamp(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Bounded read-only ISO BMFF / MP4 mvhd parser.
 * Walks only box headers (never buffers video payloads) to obtain duration in seconds.
 */
export function readMp4DurationSec(filePath) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 16) return 0;
    const fileSize = stat.size;
    fd = fs.openSync(filePath, 'r');
    const hdr = Buffer.allocUnsafe(16);

    const readBoxHeader = (offset, limitEnd) => {
      if (offset + 8 > limitEnd) return null;
      const n = fs.readSync(fd, hdr, 0, 16, offset);
      if (n < 8) return null;
      let size = hdr.readUInt32BE(0);
      const type = hdr.toString('ascii', 4, 8);
      let headerSize = 8;
      if (size === 1) {
        if (n < 16) return null;
        const bigSize = hdr.readBigUInt64BE(8);
        if (bigSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        size = Number(bigSize);
        headerSize = 16;
      } else if (size === 0) {
        size = limitEnd - offset;
      }
      if (!Number.isSafeInteger(size) || size < headerSize || offset + size > limitEnd) return null;
      return { type, size, headerSize, end: offset + size };
    };

    let offset = 0;
    for (let i = 0; i < 128 && offset < fileSize; i += 1) {
      const box = readBoxHeader(offset, fileSize);
      if (!box) break;
      if (box.type === 'moov') {
        let childOffset = offset + box.headerSize;
        for (let j = 0; j < 128 && childOffset < box.end; j += 1) {
          const child = readBoxHeader(childOffset, box.end);
          if (!child) break;
          if (child.type === 'mvhd') {
            const payloadStart = childOffset + child.headerSize;
            const payloadLen = child.end - payloadStart;
            if (payloadLen >= 20) {
              const mvhd = Buffer.allocUnsafe(Math.min(32, payloadLen));
              const readBytes = fs.readSync(fd, mvhd, 0, mvhd.length, payloadStart);
              const version = mvhd[0];
              if (version === 0 && readBytes >= 20) {
                const timescale = mvhd.readUInt32BE(12);
                const duration = mvhd.readUInt32BE(16);
                if (timescale > 0 && duration > 0) {
                  const sec = duration / timescale;
                  if (Number.isFinite(sec) && sec > 0 && sec <= 86400) return sec;
                }
              } else if (version === 1 && readBytes >= 32) {
                const timescale = mvhd.readUInt32BE(20);
                const duration = Number(mvhd.readBigUInt64BE(24));
                if (timescale > 0 && duration > 0 && Number.isFinite(duration)) {
                  const sec = duration / timescale;
                  if (Number.isFinite(sec) && sec > 0 && sec <= 86400) return sec;
                }
              }
            }
            return 0;
          }
          childOffset = child.end;
        }
        return 0;
      }
      offset = box.end;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

export function planVideoStoryboard(meta = {}, opts = {}) {
  const durationSec = Number.isFinite(Number(meta?.durationSec)) && Number(meta.durationSec) > 0
    ? Number(meta.durationSec)
    : 0;
  const hasStart = opts.startSec !== undefined && opts.startSec !== null;
  const hasEnd = opts.endSec !== undefined && opts.endSec !== null;
  let windowStart = 0;
  if (hasStart) {
    const raw = Number(opts.startSec);
    if (!Number.isFinite(raw) || raw < 0) throw new Error('startSec 必须是非负有限数字');
    if (durationSec > 0 && raw >= durationSec) throw new Error('startSec 超出视频时长');
    windowStart = raw;
  }
  let windowEnd = durationSec;
  if (hasEnd) {
    const raw = Number(opts.endSec);
    if (!Number.isFinite(raw) || raw <= 0) throw new Error('endSec 必须是正数');
    if (raw <= windowStart) throw new Error('endSec 必须大于 startSec');
    windowEnd = durationSec > 0 ? Math.min(durationSec, raw) : raw;
    if (windowEnd <= windowStart) throw new Error('endSec 必须大于 startSec');
  }

  let frames;
  if (opts.frames !== undefined && opts.frames !== null) {
    frames = clampInt(opts.frames, 1, VIDEO_DEFAULTS.maxFrames, VIDEO_DEFAULTS.defaultFrames);
  } else if (windowEnd > windowStart) {
    const span = Math.max(0.1, windowEnd - windowStart);
    frames = span < 1.5
      ? 3
      : (span <= 8 ? VIDEO_DEFAULTS.defaultShortFrames : clampInt(opts.videoFrames, 2, 12, VIDEO_DEFAULTS.defaultFrames));
  } else {
    frames = clampInt(opts.videoFrames, 2, 12, VIDEO_DEFAULTS.defaultShortFrames);
  }

  const layout = {
    1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [3, 2], 6: [3, 2],
    7: [4, 2], 8: [4, 2], 9: [3, 3], 10: [5, 2], 11: [4, 3], 12: [4, 3]
  }[frames] ?? [Math.ceil(Math.sqrt(frames)), Math.ceil(frames / Math.ceil(Math.sqrt(frames)))];
  const [cols, rows] = layout;

  let timestamps = null;
  if (windowEnd > windowStart) {
    const span = windowEnd - windowStart;
    const maxTarget = durationSec > 0.5 ? Math.max(windowStart, durationSec - 0.25) : Math.max(windowStart, windowEnd - 0.05);
    timestamps = Array.from({ length: frames }, (_, i) => {
      const target = windowStart + span * (i + 0.5) / frames;
      return Number(Math.min(Math.max(windowStart, target), maxTarget).toFixed(2));
    });
  }

  const tileBox = clampInt(opts.tileBox ?? opts.videoTile, 128, 480, VIDEO_DEFAULTS.tileBox);
  return { cols, rows, frames, durationSec, windowStart, windowEnd, timestamps, tileBox };
}

function runFfmpeg(ffmpeg, args, { timeoutMs = VIDEO_DEFAULTS.timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, error: `ffmpeg 启动失败：${error?.message ?? error}` });
      return;
    }
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      settle({ ok: false, error: `ffmpeg 超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.on('error', (error) => settle({
      ok: false,
      error: error?.code === 'ENOENT'
        ? '找不到 ffmpeg（设置环境变量 FFMPEG_PATH）'
        : `ffmpeg 不可用：${error?.message ?? error}`
    }));
    child.on('close', (code) => settle(code === 0 ? { ok: true } : { ok: false, error: `ffmpeg 退出码 ${code}` }));
  });
}

function makeTempWorkspace(tmpDir) {
  const base = tmpDir ? path.resolve(tmpDir) : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'qqb-video-'));
}

function cleanupWorkspace(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function readIfExists(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

export async function extractVideoStoryboard(filePath, opts = {}) {
  if (typeof filePath !== 'string' || !filePath) {
    return { ok: false, error: '视频文件路径无效' };
  }
  const maxVideoBytes = clampInt(
    opts.maxVideoBytes, 1024 * 1024, VIDEO_DEFAULTS.hardMaxVideoBytes, VIDEO_DEFAULTS.maxVideoBytes
  );
  const maxModelBytes = clampInt(
    opts.maxModelBytes, 64 * 1024, HARD_MAX_MODEL_BYTES, VIDEO_DEFAULTS.maxModelBytes
  );
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, error: '视频文件不存在或无法读取' };
  }
  if (!stat.isFile() || stat.size <= 0) {
    return { ok: false, error: '视频文件为空或不是普通文件' };
  }
  if (stat.size > maxVideoBytes) {
    return {
      ok: false,
      error: `视频体积 ${(stat.size / 1024 / 1024).toFixed(2)}MB 超过读取上限 ${(maxVideoBytes / 1024 / 1024).toFixed(0)}MB`
    };
  }

  const probedDuration = readMp4DurationSec(filePath);
  const metaDuration = probedDuration > 0
    ? probedDuration
    : (Number.isFinite(Number(opts.durationSec)) && Number(opts.durationSec) > 0 ? Number(opts.durationSec) : 0);

  let plan;
  try {
    plan = planVideoStoryboard({ durationSec: metaDuration }, opts);
  } catch (error) {
    return { ok: false, error: error?.message ?? '视频片段参数无效' };
  }

  let ffmpeg;
  try {
    ffmpeg = resolveFfmpeg({ ffmpegPath: opts.ffmpegPath ?? null });
  } catch (error) {
    return { ok: false, error: error?.message ?? '找不到 ffmpeg（设置环境变量 FFMPEG_PATH）' };
  }

  const globalArgs = [
    '-v', 'error', '-nostdin', '-y',
    '-max_alloc', '268435456', '-max_pixels', '16777216',
    '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1'
  ];
  const inputFlags = ['-protocol_whitelist', 'file', '-format_whitelist', VIDEO_FORMAT_WHITELIST];
  const timeoutMs = clampInt(opts.timeoutMs, 3000, 120000, VIDEO_DEFAULTS.timeoutMs);

  const dir = makeTempWorkspace(opts.tmpDir);
  try {
    const tiers = [
      { box: plan.tileBox, q: 4 },
      { box: Math.max(200, Math.round(plan.tileBox * 0.78)), q: 6 },
      { box: Math.max(160, Math.round(plan.tileBox * 0.6)), q: 8 }
    ];
    let lastError = '视频抽帧失败';

    for (let attempt = 0; attempt < tiers.length; attempt += 1) {
      const { box, q } = tiers[attempt];
      const outFile = path.join(dir, `storyboard-${attempt}.jpg`);
      let usedFrames = plan.frames;
      let usedCols = plan.cols;
      let usedRows = plan.rows;
      let usedTimestamps = plan.timestamps;
      let run = null;

      if (plan.timestamps && plan.timestamps.length) {
        const args = [...globalArgs];
        for (const t of plan.timestamps) {
          args.push(...inputFlags, '-ss', String(t), '-i', filePath);
        }
        const scaleExpr = `scale='min(${box},iw)':'min(${box},ih)':force_original_aspect_ratio=decrease:flags=lanczos,setsar=1`;
        let filterComplex;
        if (plan.timestamps.length === 1) {
          filterComplex = `[0:v]${scaleExpr}[out]`;
        } else {
          const steps = plan.timestamps.map((_, idx) => `[${idx}:v]${scaleExpr}[v${idx}]`);
          const refs = plan.timestamps.map((_, idx) => `[v${idx}]`).join('');
          filterComplex = `${steps.join(';')};${refs}concat=n=${plan.timestamps.length}:v=1:a=0,tile=${plan.cols}x${plan.rows}:padding=4:margin=4:color=white[out]`;
        }
        args.push('-filter_complex', filterComplex, '-map', '[out]', '-an', '-sn', '-dn', '-frames:v', '1', '-q:v', String(q), outFile);
        run = await runFfmpeg(ffmpeg, args, { timeoutMs });
      }

      if (!run?.ok) {
        if (run?.error) lastError = run.error;
        const span = plan.windowEnd > plan.windowStart ? Math.min(60, Math.max(0.5, plan.windowEnd - plan.windowStart)) : 12;
        const fps = Number(Math.max(0.05, Math.min(10, plan.frames / span)).toFixed(4));
        const scaleExpr = `scale='min(${box},iw)':'min(${box},ih)':force_original_aspect_ratio=decrease:flags=lanczos,setsar=1`;
        const vf = plan.frames === 1
          ? scaleExpr
          : `fps=${fps},${scaleExpr},tile=${plan.cols}x${plan.rows}:padding=4:margin=4:color=white`;
        const args = [
          ...globalArgs,
          ...inputFlags,
          ...(plan.windowStart > 0 ? ['-ss', String(plan.windowStart)] : []),
          ...(plan.windowEnd > plan.windowStart ? ['-t', String(span)] : ['-t', '60']),
          '-i', filePath,
          '-vf', vf, '-an', '-sn', '-dn', '-frames:v', '1', '-q:v', String(q), outFile
        ];
        run = await runFfmpeg(ffmpeg, args, { timeoutMs });
      }

      if (!run?.ok && plan.frames > 1) {
        if (run?.error) lastError = run.error;
        const scaleExpr = `scale='min(${box},iw)':'min(${box},ih)':force_original_aspect_ratio=decrease:flags=lanczos,setsar=1`;
        const args = [
          ...globalArgs,
          ...inputFlags,
          ...(plan.windowStart > 0 ? ['-ss', String(plan.windowStart)] : []),
          '-i', filePath,
          '-vf', scaleExpr, '-an', '-sn', '-dn', '-frames:v', '1', '-q:v', String(q), outFile
        ];
        run = await runFfmpeg(ffmpeg, args, { timeoutMs });
        if (run?.ok) {
          usedFrames = 1;
          usedCols = 1;
          usedRows = 1;
          usedTimestamps = [Number(plan.windowStart.toFixed(2))];
        }
      }

      if (!run?.ok) {
        lastError = run?.error || lastError;
        continue;
      }

      const out = readIfExists(outFile);
      if (out && out.length <= maxModelBytes) {
        const imgInfo = sniffImage(out);
        const dimText = Number(opts.width) > 0 && Number(opts.height) > 0
          ? `，${Number(opts.width)}×${Number(opts.height)}`
          : '';
        const durText = plan.durationSec > 0 ? ` ${Math.round(plan.durationSec)}s` : '';
        const sizeText = `${(stat.size / 1024 / 1024).toFixed(2)}MB`;
        const windowText = (opts.startSec != null || opts.endSec != null)
          ? `片段 ${formatVideoTimestamp(plan.windowStart)}–${formatVideoTimestamp(plan.windowEnd || plan.durationSec)}，`
          : '';
        const gridText = usedFrames > 1
          ? `${windowText}已抽 ${usedFrames} 帧拼成 ${usedCols}×${usedRows} 网格，行优先 左上→右下`
          : `${windowText}已提取 1 帧画面`;
        const tsText = Array.isArray(usedTimestamps) && usedTimestamps.length
          ? `，时间点 ${usedTimestamps.map(formatVideoTimestamp).join('/')}`
          : '';
        return {
          ok: true,
          buffer: out,
          mimeType: 'image/jpeg',
          width: imgInfo?.width ?? null,
          height: imgInfo?.height ?? null,
          durationSec: plan.durationSec,
          sizeBytes: stat.size,
          frameCount: usedFrames,
          cols: usedCols,
          rows: usedRows,
          timestamps: usedTimestamps,
          windowStart: plan.windowStart,
          windowEnd: plan.windowEnd,
          note: `视频${durText}${dimText}，${sizeText}；${gridText}${tsText}；仅含画面不含音频`
        };
      }
      lastError = out ? '输出拼图体积仍超过模型上限' : '视频解码未产出有效画面';
    }

    return { ok: false, error: lastError };
  } finally {
    cleanupWorkspace(dir);
  }
}
