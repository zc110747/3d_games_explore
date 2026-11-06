#!/usr/bin/env node
/**
 * 三国霸业 · 本地服务端
 * ------------------------------------------------------------------
 * 零第三方依赖，只用 Node 内置模块。职责两块：
 *   1) 静态托管 site/（前端 + 资源包，含 gzip / ETag / Range）
 *   2) 存档云同步 REST API（落盘 data/saves/，带历史版本）
 *
 * 用法： node server/server.mjs  [PORT=8787]
 * 环境变量：
 *   PORT           监听端口（默认 8787，被占用自动顺延到 8797）
 *   SGBY_NO_SW=1   对 /sw.js 返回 404，让前端不注册 Service Worker
 *                  （调试时替换 game.zip 想立刻生效，用这个）
 *   SGBY_OPEN=1    启动成功后自动用默认浏览器打开实际地址
 *                  （端口顺延时打开的也是顺延后的地址，不会指向别人）
 *   SGBY_APP_MODE=1  与 SGBY_OPEN 配合：优先用 Edge/Chrome 的 --app 无边框窗口打开，
 *                  找不到再退回默认浏览器。PC 发布版（windows/build.mjs 产物）用这个
 *   SGBY_WINDOW    --app 窗口尺寸，默认 1000,950
 *   SGBY_NO_CACHE=1  所有静态资源强制 no-store（排障兜底）
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SITE = path.join(ROOT, 'site');
const DATA_DIR = path.join(ROOT, 'data', 'saves');
const HIST_DIR = path.join(DATA_DIR, 'history');

const VERSION = '1.0.0';
const APP_NAME = '三国霸业 · 本地服务';
const PORT_BASE = Number(process.env.PORT || 8787);
const NO_SW = process.env.SGBY_NO_SW === '1';
const OPEN_BROWSER = process.env.SGBY_OPEN === '1';
const APP_MODE = process.env.SGBY_APP_MODE === '1';
const WINDOW_SIZE = process.env.SGBY_WINDOW || '1000,950';
const NO_CACHE = process.env.SGBY_NO_CACHE === '1';
const SLOT_MIN = 0;
const SLOT_MAX = 2;
const MAX_BODY = 8 * 1024 * 1024;   // 存档体积上限 8MB
const HIST_KEEP = 10;               // 每槽保留的历史版本数

const START_AT = Date.now();

// ---------------------------------------------------------------- MIME
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json|xml)|image\/svg)/;

const gzCache = new Map();   // absPath -> { mtimeMs, buf }

// ---------------------------------------------------------------- 工具
function log(...args) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}]`, ...args);
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(HIST_DIR, { recursive: true });
}

// ---------------------------------------------------------------- 存档存取
function slotFile(slot) {
  return path.join(DATA_DIR, `slot-${slot}.json`);
}

function validSlot(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= SLOT_MIN && n <= SLOT_MAX ? n : null;
}

/** 索引：data/saves/index.json 汇总，避免每次读全部文件 */
async function readIndex() {
  try {
    const raw = await fsp.readFile(path.join(DATA_DIR, 'index.json'), 'utf8');
    const idx = JSON.parse(raw);
    return Array.isArray(idx?.saves) ? idx : { saves: [] };
  } catch {
    return { saves: [] };
  }
}

async function writeIndex(idx) {
  idx.updatedAt = new Date().toISOString();
  await fsp.writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');
}

async function upsertIndex(entry) {
  const idx = await readIndex();
  idx.saves = idx.saves.filter((s) => s.slot !== entry.slot);
  idx.saves.push(entry);
  idx.saves.sort((a, b) => a.slot - b.slot);
  await writeIndex(idx);
}

async function pruneHistory(slot) {
  const prefix = `slot-${slot}-`;
  let files;
  try {
    files = (await fsp.readdir(HIST_DIR)).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
  } catch {
    return;
  }
  if (files.length <= HIST_KEEP) return;
  files.sort();                                     // 文件名含时间戳，字典序即时间序
  for (const f of files.slice(0, files.length - HIST_KEEP)) {
    await fsp.unlink(path.join(HIST_DIR, f)).catch(() => {});
  }
}

// ---------------------------------------------------------------- 静态服务
function safeJoin(base, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const abs = path.normalize(path.join(base, decoded));
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;   // 阻断路径穿越
  return abs;
}

async function statFile(abs) {
  try {
    const st = await fsp.stat(abs);
    if (st.isDirectory()) {
      const idx = path.join(abs, 'index.html');
      const st2 = await fsp.stat(idx);
      if (st2.isFile()) return { file: idx, st: st2 };
      return null;
    }
    return st.isFile() ? { file: abs, st } : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------- 脚本/样式版本戳
/**
 * 页面引用的脚本与样式改用「内容指纹 URL」。
 * 原因：sgby.min.js 被补丁改写过，但浏览器可能仍持着 max-age 内的旧副本，
 *       改服务端响应头救不了（浏览器压根不发请求）。把 ?v= 打进 URL 才能绕过。
 * 指纹取 size+mtime，任一文件变更则整组换戳，无需手工维护版本号。
 */
const VERSIONED = ['sgby.min.js', 'local-bridge.js', 'style.css'];

async function assetTag() {
  let acc = 7;
  for (const name of VERSIONED) {
    try {
      const st = await fsp.stat(path.join(SITE, name));
      acc = (acc * 31 + st.size + Math.floor(st.mtimeMs)) % 0x7fffffff;
    } catch { /* 缺文件不影响其它资源 */ }
  }
  return acc.toString(36);
}

/** 给 html 里的脚本/样式引用追加 ?v=指纹（已带查询串的不重复追加） */
function injectAssetVersion(html, tag) {
  return html.replace(
    /(<(?:script|link)\b[^>]*?\b(?:src|href)=")([^"?]*?(?:sgby\.min\.js|local-bridge\.js|style\.css))(")/g,
    (_m, pre, url, post) => `${pre}${url}?v=${tag}${post}`,
  );
}

async function serveStatic(req, res, pathname) {
  if (NO_SW && pathname === '/sw.js') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('sw disabled by SGBY_NO_SW=1');
  }

  const target = safeJoin(SITE, pathname === '/' ? '/index.html' : pathname);
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('bad path');
  }

  const found = await statFile(target);
  if (!found) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`404 Not Found: ${pathname}`);
  }

  const { file, st } = found;
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  // 资源包/字库是可缓存大文件；页面、脚本、样式每次协商（靠 ETag 走 304，几乎不耗流量）
  const bigAsset = /\.(zip|bin)$/i.test(file);
  const isCode = /\.(js|mjs|css)$/i.test(file) || file.endsWith('sw.js');
  const cacheControl = NO_CACHE
    ? 'no-store'
    : bigAsset
      ? 'public, max-age=86400'
      : isCode
        ? 'no-cache'
        : ext === '.html' || ext === '.json'
          ? 'no-cache'
          : 'public, max-age=600';

  // html 需要注入脚本指纹，先拿到 tag；etag 必须把 tag 算进去，
  // 否则脚本改了而 html 自身的 304 会让浏览器继续用旧版本戳
  const tag = ext === '.html' ? await assetTag() : '';
  let payload = null;
  let size = st.size;
  if (ext === '.html') {
    const raw = await fsp.readFile(file, 'utf8');
    payload = Buffer.from(injectAssetVersion(raw, tag), 'utf8');
    size = payload.length;
  }

  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}${tag ? `-${tag}` : ''}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
    return res.end();
  }

  const acceptGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const canGzip = COMPRESSIBLE.test(type) && size > 1024 && !bigAsset;

  const headers = {
    'Content-Type': type,
    'Cache-Control': cacheControl,
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  };

  // ---- Range（大文件断点/拖动有用）
  const range = req.headers.range;
  if (range && bigAsset) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start === null && end !== null) {           // 尾段
        start = Math.max(0, st.size - end);
        end = st.size - 1;
      } else if (start !== null && end === null) {
        end = st.size - 1;
      }
      if (start !== null && start <= end && start < st.size) {
        end = Math.min(end, st.size - 1);
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Content-Length': end - start + 1,
        });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
  }

  // ---- gzip
  if (canGzip && acceptGzip) {
    let hit = gzCache.get(file);
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.tag !== tag) {
      const raw = payload ?? await fsp.readFile(file);
      hit = { mtimeMs: st.mtimeMs, tag, buf: zlib.gzipSync(raw, { level: 9 }) };
      gzCache.set(file, hit);
    }
    res.writeHead(200, {
      ...headers,
      'Content-Encoding': 'gzip',
      'Content-Length': hit.buf.length,
      Vary: 'Accept-Encoding',
    });
    return res.end(req.method === 'HEAD' ? undefined : hit.buf);
  }

  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  if (payload) return res.end(payload);
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- API
async function handleApi(req, res, url) {
  const seg = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');

  // GET /api/health
  if (seg === 'health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      name: APP_NAME,
      version: VERSION,
      time: new Date().toISOString(),
      uptimeSec: Math.round((Date.now() - START_AT) / 1000),
      node: process.version,
      platform: `${os.type()} ${os.release()}`,
      root: ROOT,
      swEnabled: !NO_SW,
    });
  }

  // GET /api/pack —— 资源包元信息（前端展示用）
  if (seg === 'pack' && req.method === 'GET') {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(SITE, 'assets', 'pack.meta.json'), 'utf8'));
      const st = await fsp.stat(path.join(SITE, 'assets', 'game.zip'));
      return sendJson(res, 200, { ok: true, ...meta, actualSize: st.size, mtime: st.mtime.toISOString() });
    } catch (e) {
      return sendJson(res, 404, { ok: false, error: `资源包缺失：${e.message}` });
    }
  }

  // /api/saves
  if (seg === 'saves') {
    if (req.method === 'GET') {
      const idx = await readIndex();
      const list = [];
      for (const s of idx.saves) {
        try {
          const st = await fsp.stat(slotFile(s.slot));
          list.push({ ...s, bytes: st.size });
        } catch {
          /* 索引里有但文件没了 —— 跳过，等下次写入修正 */
        }
      }
      return sendJson(res, 200, { ok: true, saves: list });
    }
    return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  }

  // /api/saves/:slot
  const m = /^saves\/(\d+)$/.exec(seg);
  if (m) {
    const slot = validSlot(m[1]);
    if (slot === null) return sendJson(res, 400, { ok: false, error: `slot 必须是 ${SLOT_MIN}-${SLOT_MAX}` });

    if (req.method === 'GET') {
      try {
        const raw = await fsp.readFile(slotFile(slot), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(raw);
      } catch {
        return sendJson(res, 404, { ok: false, error: `服务器上没有第 ${slot + 1} 号存档` });
      }
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (e) {
        return sendJson(res, e.status || 400, { ok: false, error: `请求体解析失败：${e.message}` });
      }
      const parts = payload?.parts;
      if (!parts || typeof parts !== 'object' || Array.isArray(parts)) {
        return sendJson(res, 400, { ok: false, error: 'parts 必须是 { 键: 内容 } 对象' });
      }
      const keys = Object.keys(parts);
      if (!keys.length) return sendJson(res, 400, { ok: false, error: 'parts 不能为空' });
      for (const k of keys) {
        if (!/^sgby\.sango[\w.-]*\.sav$/.test(k)) {
          return sendJson(res, 400, { ok: false, error: `非法存档键名：${k}` });
        }
        if (typeof parts[k] !== 'string') {
          return sendJson(res, 400, { ok: false, error: `存档内容必须是字符串：${k}` });
        }
      }

      const now = new Date();
      const record = {
        slot,
        savedAt: now.toISOString(),
        note: typeof payload.note === 'string' ? payload.note.slice(0, 200) : '',
        keys,
        parts,
      };

      // 覆盖前留一份历史
      try {
        const old = await fsp.readFile(slotFile(slot), 'utf8');
        const oldName = `slot-${slot}-${now.toISOString().replace(/[:.]/g, '-')}.json`;
        await fsp.writeFile(path.join(HIST_DIR, oldName), old, 'utf8');
        await pruneHistory(slot);
      } catch { /* 首次保存没有旧档，正常 */ }

      const text = JSON.stringify(record, null, 2);
      await fsp.writeFile(slotFile(slot), text, 'utf8');
      await upsertIndex({
        slot,
        savedAt: record.savedAt,
        note: record.note,
        keys: keys.length,
        bytes: Buffer.byteLength(text),
      });
      log(`存档已保存 slot=${slot} keys=${keys.length} bytes=${Buffer.byteLength(text)}`);
      return sendJson(res, 200, { ok: true, slot, savedAt: record.savedAt, bytes: Buffer.byteLength(text) });
    }

    if (req.method === 'DELETE') {
      await fsp.unlink(slotFile(slot)).catch(() => {});
      const idx = await readIndex();
      idx.saves = idx.saves.filter((s) => s.slot !== slot);
      await writeIndex(idx);
      log(`存档已删除 slot=${slot}`);
      return sendJson(res, 200, { ok: true, slot, deleted: true });
    }

    return sendJson(res, 405, { ok: false, error: 'method not allowed' });
  }

  return sendJson(res, 404, { ok: false, error: `未知接口：${url.pathname}` });
}

// ---------------------------------------------------------------- 主服务
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const started = Date.now();

  res.on('finish', () => {
    const ms = Date.now() - started;
    if (url.pathname.startsWith('/api/')) {
      log(`${req.method} ${url.pathname} -> ${res.statusCode} (${ms}ms)`);
    }
  });

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    await serveStatic(req, res, url.pathname);
  } catch (e) {
    log('ERROR', e.stack || e.message);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
    else res.end();
  }
});

/**
 * 找一个可用的 Chromium 内核浏览器（Edge 优先，Windows 自带）。
 * 只用于 --app 无边框窗口，找不到就退回默认浏览器，不影响功能。
 */
function findChromium() {
  if (process.platform !== 'win32') return null;
  const env = process.env;
  const bases = [env['ProgramFiles'], env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  const rels = [
    'Microsoft\\Edge\\Application\\msedge.exe',
    'Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const rel of rels) {
    for (const base of bases) {
      const p = path.join(base, rel);
      try {
        if (fs.existsSync(p)) return p;
      } catch { /* 权限问题直接跳过 */ }
    }
  }
  return null;
}

/** 用 --app 打开无地址栏窗口，成功返回 true */
function openAppWindow(target) {
  const exe = findChromium();
  if (!exe) return false;
  try {
    spawn(exe, [
      `--app=${target}`,
      `--window-size=${WINDOW_SIZE}`,
      '--no-first-run',
      '--no-default-browser-check',
    ], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

function listen(port, tries = 11) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 1) {
      log(`端口 ${port} 被占用，尝试 ${port + 1}`);
      listen(port + 1, tries - 1);
    } else {
      console.error(`\n启动失败：${e.message}\n`);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', async () => {
    const p = server.address().port;
    console.log('');
    console.log('  ┌────────────────────────────────────────────┐');
    console.log(`  │  ${APP_NAME}  v${VERSION}`.padEnd(47) + '│');
    console.log('  ├────────────────────────────────────────────┤');
    console.log(`  │  页面： http://localhost:${String(p).padEnd(29)}│`);
    console.log(`  │  接口： http://localhost:${p}/api/health`.padEnd(47) + '│');
    console.log(`  │  目录： ${ROOT}`.slice(0, 46).padEnd(47) + '│');
    console.log('  └────────────────────────────────────────────┘');
    console.log('');
    console.log(`  静态根目录  ${SITE}`);
    console.log(`  存档目录    ${DATA_DIR}`);
    console.log(`  资源包      ${path.join(SITE, 'assets', 'game.zip')}`);
    console.log(`  Service Worker ${NO_SW ? '已禁用' : '启用（替换资源包后需强刷）'}`);
    console.log(`  缓存策略     ${NO_CACHE ? '全部禁用（排障模式）' : '脚本 no-cache + URL 指纹'}`);
    console.log('  按 Ctrl+C 退出');
    console.log('');
    await ensureDirs();

    // 由服务端自己开浏览器：端口顺延时打开的仍是真实地址，不会指向别人的服务
    if (OPEN_BROWSER) {
      const target = `http://127.0.0.1:${p}/`;
      if (APP_MODE && openAppWindow(target)) {
        log(`已打开应用窗口 ${target}`);
        return;
      }
      const cmd = process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', target]]
        : process.platform === 'darwin'
          ? ['open', [target]]
          : ['xdg-open', [target]];
      try {
        spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
        log(`已打开浏览器 ${target}`);
      } catch (e) {
        log(`自动打开浏览器失败（手动访问 ${target}）：${e.message}`);
      }
    }
  });
}

await ensureDirs();
listen(PORT_BASE);

process.on('SIGINT', () => {
  console.log('\n已停止。');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
});
