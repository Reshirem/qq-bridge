import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
  VIDEO_DEFAULTS,
  extractVideoStoryboard,
  formatVideoTimestamp,
  planVideoStoryboard,
  readMp4DurationSec
} from '../src/media-video.js';
import { resolveFfmpeg } from '../src/ffmpeg-resolve.js';
import { sniffImage } from '../src/media-normalize.js';

test('formatVideoTimestamp and planVideoStoryboard compute layouts and reject invalid windows', () => {
  assert.equal(formatVideoTimestamp(0), '00:00');
  assert.equal(formatVideoTimestamp(9), '00:09');
  assert.equal(formatVideoTimestamp(75), '01:15');
  assert.equal(formatVideoTimestamp(3665), '1:01:05');

  const shortPlan = planVideoStoryboard({ durationSec: 6 });
  assert.deepEqual([shortPlan.cols, shortPlan.rows, shortPlan.frames, shortPlan.sheetCount], [3, 2, 6, 1]);
  assert.equal(shortPlan.timestamps.length, 6);
  assert.ok(shortPlan.timestamps.every((t) => t > 0 && t < 6));

  const longPlan = planVideoStoryboard({ durationSec: 20 });
  assert.deepEqual([longPlan.cols, longPlan.rows, longPlan.frames, longPlan.sheetCount], [3, 3, 9, 1]);
  assert.equal(longPlan.timestamps.length, 9);

  const midPlan = planVideoStoryboard({ durationSec: 35 });
  assert.deepEqual([midPlan.frames, midPlan.sheetCount], [18, 2]);
  assert.equal(midPlan.sheets[0].frames, 9);
  assert.equal(midPlan.sheets[1].frames, 9);
  assert.ok(midPlan.sheets[0].timestamps.at(-1) < midPlan.sheets[1].timestamps[0]);

  const threeSheetPlan = planVideoStoryboard({ durationSec: 70 });
  assert.deepEqual([threeSheetPlan.frames, threeSheetPlan.sheetCount], [27, 3]);

  const fourSheetPlan = planVideoStoryboard({ durationSec: 120 });
  assert.deepEqual([fourSheetPlan.frames, fourSheetPlan.sheetCount], [36, 4]);

  const cappedPlan = planVideoStoryboard({ durationSec: 180 }, { videoMaxSheets: 2 });
  assert.deepEqual([cappedPlan.frames, cappedPlan.sheetCount], [18, 2]);

  const explicitMultiPlan = planVideoStoryboard({ durationSec: 60 }, { frames: 18 });
  assert.deepEqual([explicitMultiPlan.frames, explicitMultiPlan.sheetCount], [18, 2]);

  const subPlan = planVideoStoryboard({ durationSec: 20 }, { startSec: 4, endSec: 12, frames: 4 });
  assert.deepEqual([subPlan.cols, subPlan.rows, subPlan.frames], [2, 2, 4]);
  assert.deepEqual(subPlan.timestamps, [5, 7, 9, 11]);

  assert.throws(() => planVideoStoryboard({ durationSec: 10 }, { startSec: -1 }), /非负/);
  assert.throws(() => planVideoStoryboard({ durationSec: 10 }, { startSec: 10 }), /超出视频时长/);
  assert.throws(() => planVideoStoryboard({ durationSec: 10 }, { startSec: 5, endSec: 5 }), /大于 startSec/);
  assert.throws(() => planVideoStoryboard({ durationSec: 10 }, { endSec: 0 }), /正数/);
});

test('extractVideoStoryboard reads MP4 duration and produces bounded storyboard JPEGs via real ffmpeg', async (t) => {
  const ffmpeg = resolveFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-vid-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sampleMp4 = path.join(dir, 'sample.mp4');
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=6',
    '-pix_fmt', 'yuv420p', sampleMp4
  ], { stdio: 'ignore', timeout: 20000 });

  const dur = readMp4DurationSec(sampleMp4);
  assert.ok(dur >= 5.5 && dur <= 6.5, `unexpected MP4 duration: ${dur}`);

  const full = await extractVideoStoryboard(sampleMp4, { ffmpegPath: ffmpeg, tmpDir: dir });
  assert.equal(full.ok, true, full.error);
  assert.equal(full.mimeType, 'image/jpeg');
  assert.ok(full.buffer.length > 1000 && full.buffer.length <= VIDEO_DEFAULTS.maxModelBytes);
  assert.equal(full.frameCount, 6);
  assert.equal(full.cols, 3);
  assert.equal(full.rows, 2);
  assert.match(full.note, /已抽 6 帧拼成 3×2 网格.*仅含画面不含音频/);
  const fullImg = sniffImage(full.buffer);
  assert.equal(fullImg?.format, 'jpeg');
  assert.ok(fullImg.width > 300 && fullImg.height > 200);

  const sub = await extractVideoStoryboard(sampleMp4, {
    ffmpegPath: ffmpeg, tmpDir: dir, startSec: 1, endSec: 4, frames: 4, width: 320, height: 240
  });
  assert.equal(sub.ok, true, sub.error);
  assert.equal(sub.frameCount, 4);
  assert.equal(sub.cols, 2);
  assert.equal(sub.rows, 2);
  assert.match(sub.note, /片段 00:01–00:04，已抽 4 帧拼成 2×2 网格/);

  const single = await extractVideoStoryboard(sampleMp4, {
    ffmpegPath: ffmpeg, tmpDir: dir, startSec: 2, endSec: 3, frames: 1
  });
  assert.equal(single.ok, true, single.error);
  assert.equal(single.frameCount, 1);

  const tooBig = path.join(dir, 'too-big.mp4');
  fs.writeFileSync(tooBig, Buffer.alloc(16));
  fs.truncateSync(tooBig, 1024 * 1024 + 64);
  const oversized = await extractVideoStoryboard(tooBig, { ffmpegPath: ffmpeg, maxVideoBytes: 1 });
  assert.equal(oversized.ok, false);
  assert.match(oversized.error, /超过读取上限/);

  const corrupt = path.join(dir, 'corrupt.mp4');
  fs.writeFileSync(corrupt, Buffer.from('not a valid video payload'));
  const failed = await extractVideoStoryboard(corrupt, { ffmpegPath: ffmpeg, tmpDir: dir });
  assert.equal(failed.ok, false);

  const missing = await extractVideoStoryboard(path.join(dir, 'missing.mp4'), { ffmpegPath: ffmpeg });
  assert.equal(missing.ok, false);
});

test('extractVideoStoryboard samples distinct timestamps across full video rather than repeating input 0', async (t) => {
  const ffmpeg = resolveFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-vid-colors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const colorVideo = path.join(dir, 'colors.mp4');
  const hexColors = ['0xFF0000', '0x00FF00', '0x0000FF', '0xFFFF00', '0x00FFFF', '0xFF00FF'];
  const inputs = hexColors.map((c, i) => `color=c=${c}:s=160x120:d=1:r=10[c${i}]`).join(';');
  const refs = hexColors.map((_, i) => `[c${i}]`).join('');
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-filter_complex', `${inputs};${refs}concat=n=6:v=1:a=0[v]`,
    '-map', '[v]', '-g', '5', '-pix_fmt', 'yuv420p', colorVideo
  ], { stdio: 'ignore', timeout: 20000 });

  const board = await extractVideoStoryboard(colorVideo, { ffmpegPath: ffmpeg, tmpDir: dir, frames: 6 });
  assert.equal(board.ok, true, board.error);
  assert.deepEqual([board.cols, board.rows, board.frameCount], [3, 2, 6]);
  const info = sniffImage(board.buffer);
  assert.equal(info?.format, 'jpeg');

  const boardJpg = path.join(dir, 'board.jpg');
  fs.writeFileSync(boardJpg, board.buffer);
  const rgb = execFileSync(ffmpeg, [
    '-v', 'error', '-i', boardJpg, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
  ], { maxBuffer: 10 * 1024 * 1024, timeout: 10000 });
  assert.equal(rgb.length, info.width * info.height * 3);

  const sampleTile = (idx) => {
    const col = idx % 3;
    const row = Math.floor(idx / 3);
    const x = Math.round(((col + 0.5) / 3) * info.width);
    const y = Math.round(((row + 0.5) / 2) * info.height);
    const off = (y * info.width + x) * 3;
    return [rgb[off], rgb[off + 1], rgb[off + 2]];
  };
  const checks = [
    ([r, g, b]) => r > 180 && g < 70 && b < 70,
    ([r, g, b]) => g > 180 && r < 70 && b < 70,
    ([r, g, b]) => b > 180 && r < 70 && g < 70,
    ([r, g, b]) => r > 180 && g > 180 && b < 70,
    ([r, g, b]) => r < 70 && g > 180 && b > 180,
    ([r, g, b]) => r > 180 && g < 70 && b > 180,
  ];
  for (let i = 0; i < 6; i += 1) {
    const px = sampleTile(i);
    assert.ok(checks[i](px), `tile ${i} expected color segment ${hexColors[i]}, got rgb(${px.join(',')})`);
  }

  const partial = await extractVideoStoryboard(colorVideo, { ffmpegPath: ffmpeg, tmpDir: dir, frames: 5 });
  assert.equal(partial.ok, true, partial.error);
  assert.deepEqual([partial.cols, partial.rows, partial.frameCount, partial.sheetCount], [3, 2, 5, 1]);

  const multiSheet = await extractVideoStoryboard(colorVideo, { ffmpegPath: ffmpeg, tmpDir: dir, frames: 18 });
  assert.equal(multiSheet.ok, true, multiSheet.error);
  assert.equal(multiSheet.frameCount, 18);
  assert.equal(multiSheet.sheetCount, 2);
  assert.equal(multiSheet.sheets.length, 2);
  assert.match(multiSheet.note, /共抽 18 帧分 2 张网格图按时间顺序排列/);
  assert.match(multiSheet.sheets[0].note, /^第 1\/2 张（00:00–00:03，9 帧 3×3 网格/);
  assert.match(multiSheet.sheets[1].note, /^第 2\/2 张（00:03–00:06，9 帧 3×3 网格/);
  for (const sheet of multiSheet.sheets) {
    assert.equal(sniffImage(sheet.buffer)?.format, 'jpeg');
    assert.ok(sheet.buffer.length > 500 && sheet.buffer.length <= VIDEO_DEFAULTS.maxModelBytes);
  }
  const s1rgb = execFileSync(ffmpeg, [
    '-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
  ], { input: multiSheet.sheets[0].buffer, maxBuffer: 10 * 1024 * 1024, timeout: 10000 });
  const s2rgb = execFileSync(ffmpeg, [
    '-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
  ], { input: multiSheet.sheets[1].buffer, maxBuffer: 10 * 1024 * 1024, timeout: 10000 });
  const s1Info = sniffImage(multiSheet.sheets[0].buffer);
  const s2Info = sniffImage(multiSheet.sheets[1].buffer);
  const firstTilePixel = (buf, w, h) => {
    const off = (Math.round(h / 6) * w + Math.round(w / 6)) * 3;
    return [buf[off], buf[off + 1], buf[off + 2]];
  };
  const lastTilePixel = (buf, w, h) => {
    const off = (Math.round((5 / 6) * h) * w + Math.round((5 / 6) * w)) * 3;
    return [buf[off], buf[off + 1], buf[off + 2]];
  };
  assert.ok(checks[0](firstTilePixel(s1rgb, s1Info.width, s1Info.height)), 'sheet 1 starts with red segment');
  assert.ok(checks[5](lastTilePixel(s2rgb, s2Info.width, s2Info.height)), 'sheet 2 ends with magenta segment');
});
