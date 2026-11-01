import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, extOf, md5Buffer, md5File, monthKey, sanitizeFileName } from '../util.mjs';

export class MediaStore {
  constructor ({ dir, logger }) {
    this.dir = ensureDir(dir);
    this.logger = logger;
  }

  _target (md5, ext) {
    const month = monthKey();
    const dir = ensureDir(path.join(this.dir, month));
    const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin';
    return {
      rel: `${month}/${md5}${safeExt}`,
      abs: path.join(dir, `${md5}${safeExt}`)
    };
  }

  saveBuffer (buffer, ext = '.bin') {
    const md5 = md5Buffer(buffer);
    const target = this._target(md5, ext);
    if (fs.existsSync(target.abs)) fs.utimesSync(target.abs, new Date(), new Date());
    else fs.writeFileSync(target.abs, buffer);
    return {
      rel: target.rel,
      path: target.abs,
      size: buffer.length,
      md5,
      url: `/v1/media/${target.rel}`
    };
  }

  async saveFile (sourcePath, name = '') {
    const md5 = await md5File(sourcePath);
    const target = this._target(md5, extOf(name || sourcePath));
    if (fs.existsSync(target.abs)) fs.utimesSync(target.abs, new Date(), new Date());
    else fs.copyFileSync(sourcePath, target.abs);
    const stat = fs.statSync(target.abs);
    return {
      rel: target.rel,
      path: target.abs,
      size: stat.size,
      md5,
      url: `/v1/media/${target.rel}`,
      name: sanitizeFileName(name || path.basename(sourcePath))
    };
  }

  resolve (rel) {
    const normalized = path.normalize(String(rel || '')).replace(/^([/\\])+/, '');
    const abs = path.resolve(this.dir, normalized);
    if (!abs.startsWith(path.resolve(this.dir) + path.sep)) {
      throw new Error('非法的媒体路径');
    }
    return abs;
  }

  cleanup ({ retentionDays = 10 } = {}) {
    const days = Number(retentionDays);
    if (!(days > 0)) return { removed: 0, cutoff: 0 };
    const cutoff = Date.now() - days * 86400000;
    let removed = 0;
    const walk = dir => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
          try {
            if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
          } catch {
            // ignore
          }
          continue;
        }
        try {
          if (fs.statSync(abs).mtimeMs < cutoff) {
            fs.unlinkSync(abs);
            removed++;
          }
        } catch {
          // ignore
        }
      }
    };
    walk(this.dir);
    if (removed > 0) this.logger?.info?.(`[media] 已清理 ${removed} 个超过 ${days} 天的文件`);
    return { removed, cutoff };
  }
}
