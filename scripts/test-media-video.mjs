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
  assert.deepEqual([shortPlan.cols, shortPlan.rows, shortPlan.frames], [3, 2, 6]);
  assert.equal(shortPlan.timestamps.length, 6);
  assert.ok(shortPlan.timestamps.every((t) => t > 0 && t < 6));

  const longPlan = planVideoStoryboard({ durationSec: 20 });
  assert.deepEqual([longPlan.cols, longPlan.rows, longPlan.frames], [3, 3, 9]);
  assert.equal(longPlan.timestamps.length, 9);

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
