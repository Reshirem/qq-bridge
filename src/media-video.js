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
  framesPerSheet: 9,
  defaultMaxSheets: 4,
  hardMaxSheets: 6,
  defaultFrames: 9,
  maxFrames: 36,
  hardMaxFrames: 54,
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

function gridLayout(frames) {
  return {
    1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [3, 2], 6: [3, 2],
    7: [4, 2], 8: [4, 2], 9: [3, 3], 10: [5, 2], 11: [4, 3], 12: [4, 3]
  }[frames] ?? [Math.ceil(Math.sqrt(frames)), Math.ceil(frames / Math.ceil(Math.sqrt(frames)))];
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

  const framesPerSheet = clampInt(opts.framesPerSheet ?? opts.videoFrames, 2, 12, VIDEO_DEFAULTS.framesPerSheet);
  const maxSheets = clampInt(
    opts.videoMaxSheets ?? opts.maxVideoSheets ?? opts.maxSheets,
    1, VIDEO_DEFAULTS.hardMaxSheets, VIDEO_DEFAULTS.defaultMaxSheets
  );
  const maxTotalFrames = Math.min(VIDEO_DEFAULTS.hardMaxFrames, framesPerSheet * maxSheets);

  let frames;
  let sheetCount;
  if (opts.frames !== undefined && opts.frames !== null) {
    frames = clampInt(opts.frames, 1, maxTotalFrames, framesPerSheet);
    if (windowEnd <= windowStart) {
      sheetCount = 1;
      frames = Math.min(frames, framesPerSheet);
    } else {
      sheetCount = Math.min(maxSheets, Math.max(1, Math.ceil(frames / framesPerSheet)));
    }
  } else if (windowEnd > windowStart) {
    const span = Math.max(0.1, windowEnd - windowStart);
    if (span < 1.5) {
      sheetCount = 1;
      frames = Math.min(framesPerSheet, 3);
    } else if (span <= 8) {
      sheetCount = 1;
      frames = Math.min(framesPerSheet, VIDEO_DEFAULTS.defaultShortFrames);
    } else if (span <= 20) {
      sheetCount = 1;
      frames = framesPerSheet;
    } else if (span <= 45) {
      sheetCount = Math.min(2, maxSheets);
      frames = sheetCount * framesPerSheet;
    } else if (span <= 90) {
      sheetCount = Math.min(3, maxSheets);
      frames = sheetCount * framesPerSheet;
    } else if (span <= 150) {
      sheetCount = Math.min(4, maxSheets);
      frames = sheetCount * framesPerSheet;
    } else if (span <= 240) {
      sheetCount = Math.min(5, maxSheets);
      frames = sheetCount * framesPerSheet;
    } else {
      sheetCount = maxSheets;
      frames = sheetCount * framesPerSheet;
    }
    frames = Math.min(maxTotalFrames, frames);
  } else {
    sheetCount = 1;
    frames = Math.min(framesPerSheet, VIDEO_DEFAULTS.defaultShortFrames);
  }

  let timestamps = null;
  if (windowEnd > windowStart) {
    const span = windowEnd - windowStart;
    const maxTarget = durationSec > 0.5 ? Math.max(windowStart, durationSec - 0.25) : Math.max(windowStart, windowEnd - 0.05);
    timestamps = Array.from({ length: frames }, (_, i) => {
      const target = windowStart + span * (i + 0.5) / frames;
      return Number(Math.min(Math.max(windowStart, target), maxTarget).toFixed(2));
    });
  }

  const sheets = [];
  let cursor = 0;
  const baseCount = Math.floor(frames / sheetCount);
  const extra = frames % sheetCount;
  for (let i = 0; i < sheetCount; i += 1) {
    const count = baseCount + (i < extra ? 1 : 0);
    const [cols, rows] = gridLayout(count);
    const sliceTs = timestamps ? timestamps.slice(cursor, cursor + count) : null;
    let swStart = windowStart;
    let swEnd = windowEnd;
    if (windowEnd > windowStart && sheetCount > 1) {
      const step = (windowEnd - windowStart) / frames;
      swStart = Number(Math.max(windowStart, windowStart + step * cursor).toFixed(2));
      swEnd = Number(Math.min(windowEnd, windowStart + step * (cursor + count)).toFixed(2));
    }
    sheets.push({
      index: i + 1,
      totalSheets: sheetCount,
      frames: count,
      cols,
      rows,
      timestamps: sliceTs,
      windowStart: swStart,
      windowEnd: swEnd,
    });
    cursor += count;
  }

  const tileBox = clampInt(opts.tileBox ?? opts.videoTile, 128, 480, VIDEO_DEFAULTS.tileBox);
  return {
    cols: sheets[0].cols,
    rows: sheets[0].rows,
    frames,
    sheetCount,
    sheets,
    maxTotalFrames,
    durationSec,
    windowStart,
    windowEnd,
    timestamps,
    tileBox,
  };
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

async function renderSheet({
  filePath, ffmpeg, globalArgs, inputFlags, maxModelBytes, timeoutMs,
  dir, sheetPlan, tileBox
}) {
  const tiers = [
    { box: tileBox, q: 4 },
    { box: Math.max(200, Math.round(tileBox * 0.78)), q: 6 },
    { box: Math.max(160, Math.round(tileBox * 0.6)), q: 8 }
  ];
  let lastError = '视频抽帧失败';

  for (let attempt = 0; attempt < tiers.length; attempt += 1) {
    const { box, q } = tiers[attempt];
    const outFile = path.join(dir, `storyboard-${sheetPlan.index}-${attempt}.jpg`);
    let usedFrames = sheetPlan.frames;
    let usedCols = sheetPlan.cols;
    let usedRows = sheetPlan.rows;
    let usedTimestamps = sheetPlan.timestamps;
    let run = null;

    if (sheetPlan.timestamps && sheetPlan.timestamps.length) {
      const args = [...globalArgs];
      for (const t of sheetPlan.timestamps) {
        args.push(...inputFlags, '-ss', String(t), '-i', filePath);
      }
      const scaleExpr = `scale='min(${box},iw)':'min(${box},ih)':force_original_aspect_ratio=decrease:flags=lanczos,setsar=1`;
      let filterComplex;
      if (sheetPlan.timestamps.length === 1) {
        filterComplex = `[0:v]trim=end_frame=1,setpts=PTS-STARTPTS,${scaleExpr}[out]`;
      } else {
        const steps = sheetPlan.timestamps.map((_, idx) => `[${idx}:v]trim=end_frame=1,setpts=PTS-STARTPTS,${scaleExpr}[v${idx}]`);
        const refs = sheetPlan.timestamps.map((_, idx) => `[v${idx}]`).join('');
        filterComplex = `${steps.join(';')};${refs}concat=n=${sheetPlan.timestamps.length}:v=1:a=0,tile=${sheetPlan.cols}x${sheetPlan.rows}:padding=4:margin=4:color=white[out]`;
      }
      args.push('-filter_complex', filterComplex, '-map', '[out]', '-an', '-sn', '-dn', '-frames:v', '1', '-q:v', String(q), outFile);
      run = await runFfmpeg(ffmpeg, args, { timeoutMs });
    }

    if (!run?.ok) {
      if (run?.error) lastError = run.error;
      const span = sheetPlan.windowEnd > sheetPlan.windowStart
        ? Math.min(90, Math.max(0.5, sheetPlan.windowEnd - sheetPlan.windowStart))
        : 12;
      const fps = Number(Math.max(0.05, Math.min(10, sheetPlan.frames / span)).toFixed(4));
      const scaleExpr = `scale='min(${box},iw)':'min(${box},ih)':force_original_aspect_ratio=decrease:flags=lanczos,setsar=1`;
      const vf = sheetPlan.frames === 1
        ? scaleExpr
        : `fps=${fps},${scaleExpr},tile=${sheetPlan.cols}x${sheetPlan.rows}:padding=4:margin=4:color=white`;
      const args = [
        ...globalArgs,
        ...inputFlags,
        ...(sheetPlan.windowStart > 0 ? ['-ss', String(sheetPlan.windowStart)] : []),
        ...(sheetPlan.windowEnd > sheetPlan.windowStart ? ['-t', String(span)] : ['-t', '60']),
        '-i', filePath,
        '-vf', vf, '-an', '-sn', '-dn', '-frames:v', '1', '-q:v', String(q), outFile
      ];
      run = await runFfmpeg(ffmpeg, args, { timeoutMs });
    }

    if (!run?.ok && sheetPlan.frames > 1) {
      if (run?.error) lastError = run.error;
      const scaleExpr = `scale='min(${box},iw)':'min(${box},ih)':force_original_aspect_ratio=decrease:flags=lanczos,setsar=1`;
      const args = [
        ...globalArgs,
        ...inputFlags,
        ...(sheetPlan.windowStart > 0 ? ['-ss', String(sheetPlan.windowStart)] : []),
        '-i', filePath,
        '-vf', scaleExpr, '-an', '-sn', '-dn', '-frames:v', '1', '-q:v', String(q), outFile
      ];
      run = await runFfmpeg(ffmpeg, args, { timeoutMs });
      if (run?.ok) {
        usedFrames = 1;
        usedCols = 1;
        usedRows = 1;
        usedTimestamps = [Number(sheetPlan.windowStart.toFixed(2))];
      }
    }

    if (!run?.ok) {
      lastError = run?.error || lastError;
      continue;
    }

    const out = readIfExists(outFile);
    if (out && out.length <= maxModelBytes) {
      const imgInfo = sniffImage(out);
      return {
        ok: true,
        index: sheetPlan.index,
        buffer: out,
        mimeType: 'image/jpeg',
        width: imgInfo?.width ?? null,
        height: imgInfo?.height ?? null,
        frameCount: usedFrames,
        cols: usedCols,
        rows: usedRows,
        timestamps: usedTimestamps,
        windowStart: sheetPlan.windowStart,
        windowEnd: sheetPlan.windowEnd,
      };
    }
    lastError = out ? '输出拼图体积仍超过模型上限' : '视频解码未产出有效画面';
  }
  return { ok: false, error: lastError };
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
  const perSheetTimeoutMs = clampInt(opts.timeoutMs, 3000, 120000, VIDEO_DEFAULTS.timeoutMs);
  const overallBudgetMs = Math.min(150000, perSheetTimeoutMs * Math.max(1, plan.sheets.length));
  const deadline = Date.now() + overallBudgetMs;

  const dir = makeTempWorkspace(opts.tmpDir);
  try {
    const renderedSheets = [];
    let lastError = '视频抽帧失败';

    for (let i = 0; i < plan.sheets.length; i += 1) {
      const remainingMs = deadline - Date.now();
      if (i > 0 && remainingMs < 2000) {
        lastError = '视频多张拼图总超时';
        break;
      }
      const sheetTimeoutMs = Math.max(3000, Math.min(perSheetTimeoutMs, remainingMs));
      const rendered = await renderSheet({
        filePath, ffmpeg, globalArgs, inputFlags, maxModelBytes,
        timeoutMs: sheetTimeoutMs, dir, sheetPlan: plan.sheets[i], tileBox: plan.tileBox,
      });
      if (!rendered.ok) {
        lastError = rendered.error || lastError;
        if (renderedSheets.length > 0) break;
        return { ok: false, error: lastError };
      }
      renderedSheets.push(rendered);
    }

    if (!renderedSheets.length) {
      return { ok: false, error: lastError };
    }

    const dimText = Number(opts.width) > 0 && Number(opts.height) > 0
      ? `，${Number(opts.width)}×${Number(opts.height)}`
      : '';
    const durText = plan.durationSec > 0 ? ` ${Math.round(plan.durationSec)}s` : '';
    const sizeText = `${(stat.size / 1024 / 1024).toFixed(2)}MB`;
    const header = `视频${durText}${dimText}，${sizeText}`;
    const windowText = (opts.startSec != null || opts.endSec != null)
      ? `片段 ${formatVideoTimestamp(plan.windowStart)}–${formatVideoTimestamp(plan.windowEnd || plan.durationSec)}，`
      : '';
    const sheetCount = renderedSheets.length;
    const sheets = renderedSheets.map((s, idx) => {
      const tsText = Array.isArray(s.timestamps) && s.timestamps.length
        ? `，时间点 ${s.timestamps.map(formatVideoTimestamp).join('/')}`
        : '';
      let note;
      if (sheetCount === 1) {
        const gridText = s.frameCount > 1
          ? `${windowText}已抽 ${s.frameCount} 帧拼成 ${s.cols}×${s.rows} 网格，行优先 左上→右下`
          : `${windowText}已提取 1 帧画面`;
        note = `${header}；${gridText}${tsText}；仅含画面不含音频`;
      } else {
        const rangeText = s.windowEnd > s.windowStart
          ? `${formatVideoTimestamp(s.windowStart)}–${formatVideoTimestamp(s.windowEnd)}，`
          : '';
        const gridText = s.frameCount > 1
          ? `${s.frameCount} 帧 ${s.cols}×${s.rows} 网格，行优先 左上→右下`
          : '1 帧画面';
        note = `第 ${idx + 1}/${sheetCount} 张（${rangeText}${gridText}${tsText}）`;
      }
      return { ...s, index: idx + 1, note };
    });
    const totalFrames = sheets.reduce((sum, s) => sum + s.frameCount, 0);
    const allTimestamps = sheets.every(s => Array.isArray(s.timestamps))
      ? sheets.flatMap(s => s.timestamps)
      : null;
    const first = sheets[0];
    const note = sheetCount === 1
      ? first.note
      : `${header}；${windowText}共抽 ${totalFrames} 帧分 ${sheetCount} 张网格图按时间顺序排列，每张行优先 左上→右下；仅含画面不含音频`;

    return {
      ok: true,
      buffer: first.buffer,
      mimeType: first.mimeType,
      width: first.width,
      height: first.height,
      durationSec: plan.durationSec,
      sizeBytes: stat.size,
      frameCount: totalFrames,
      cols: first.cols,
      rows: first.rows,
      sheetCount,
      sheets,
      timestamps: allTimestamps,
      windowStart: plan.windowStart,
      windowEnd: sheets[sheets.length - 1].windowEnd,
      note,
    };
  } finally {
    cleanupWorkspace(dir);
  }
}
