import fs from 'node:fs';

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
