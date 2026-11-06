/**
 * 只读 zip（store 模式）条目提取器，仅用于测试：
 * 从 original/site/assets/game.zip 读取真实数据表，避免任何模拟数据。
 * 文件名可能是 UTF-8（带 0x800 标志，本资源包即如此）或 GBK，按标志位/严格解码区分。
 */
import fs from 'node:fs';

export function openZip(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：未找到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  // zip 文件名字节可能是 UTF-8（带 0x800 标志）或 GBK，按标志位/严格解码区分。
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const gbk = new TextDecoder('gbk');
  const decodeName = (bytes, utf8Flag) => {
    if (utf8Flag) return utf8.decode(bytes);
    try { return utf8.decode(bytes); } catch { return gbk.decode(bytes); }
  };
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`zip 中央目录第 ${i + 1} 项签名错误`);
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = decodeName(buf.subarray(off + 46, off + 46 + nameLen), !!(flags & 0x800));
    entries.set(name, { method, csize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names() { return [...entries.keys()]; },
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`资源包中缺少 ${name}`);
      if (e.method !== 0) throw new Error(`zip 条目 ${name} 不是 store 模式`);
      const lNameLen = buf.readUInt16LE(e.localOff + 26);
      const lExtraLen = buf.readUInt16LE(e.localOff + 28);
      const start = e.localOff + 30 + lNameLen + lExtraLen;
      return buf.subarray(start, start + e.csize);
    },
    readJson(name) { return JSON.parse(new TextDecoder('utf-8').decode(this.read(name))); },
  };
}
