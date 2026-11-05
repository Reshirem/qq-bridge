import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// No caller-supplied path/URL is ever used as an asset filename.
export function createLearningAssets(directory) {
  const hashOf = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
  function resolve(hash) {
    if (!/^[a-f0-9]{64}$/.test(String(hash))) throw new Error('无效的本地表情标识');
    const root = fs.realpathSync(directory);
    const file = fs.realpathSync(path.join(root, `${hash}.bin`));
    if (path.dirname(file) !== root) throw new Error('本地表情路径越界');
    return file;
  }
  return {
    put(buffer) {
      if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > 8 * 1024 * 1024) throw new Error('表情文件大小不符合限制');
      fs.mkdirSync(directory, { recursive: true });
      const hash = hashOf(buffer), file = path.join(directory, `${hash}.bin`);
      try { fs.writeFileSync(file, buffer, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      // Existing content must also be checked (including symlink containment).
      this.read(hash);
      return { id: `learned:${hash}`, hash };
    },
    read(hash) {
      const file = resolve(hash);
      if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('本地表情文件超限');
      const buffer = fs.readFileSync(file);
      if (hashOf(buffer) !== hash) throw new Error('本地表情内容校验失败');
      return buffer;
    },
    collectUnused(hashes) {
      if (!fs.existsSync(directory)) return;
      const root = fs.realpathSync(directory), keep = new Set(hashes);
      for (const name of fs.readdirSync(root)) {
        if (!/^[a-f0-9]{64}\.bin$/.test(name) || keep.has(name.slice(0, -4))) continue;
        // Unlink only this named file, never recursively follow anything.
        fs.unlinkSync(path.join(root, name));
      }
    },
  };
}
