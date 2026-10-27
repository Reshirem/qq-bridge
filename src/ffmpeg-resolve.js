import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Locate ffmpeg: an explicit path takes priority, then FFMPEG_PATH, then PATH. */
export function resolveFfmpeg({ ffmpegPath = null, envVar = 'FFMPEG_PATH' } = {}) {
  const candidates = [ffmpegPath, process.env[envVar]].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  // Let spawn resolve the command from PATH and report ENOENT if it is absent.
  return 'ffmpeg';
}

/** Check that the resolved executable can actually start, without printing its output. */
export function isFfmpegAvailable({ ffmpegPath = null, timeoutMs = 3000 } = {}) {
  const result = spawnSync(resolveFfmpeg({ ffmpegPath }), ['-version'], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: timeoutMs
  });
  return !result.error && result.status === 0;
}
