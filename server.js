'use strict';

/**
 * 校园交易平台 —— 零依赖后端
 * 技术栈：Node.js 内置 http + node:sqlite + node:crypto
 * 功能：用户注册/登录/登出、商品发布（含图片上传）、浏览/搜索、我的商品管理
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DB_PATH = path.join(ROOT, 'data.db');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 会话有效期 7 天
const MAX_BODY_BYTES = 25 * 1024 * 1024;        // 请求体上限 25MB（容纳 base64 图片）
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;        // 单张图片上限 6MB

const CATEGORIES = [
  '数码电子', '书籍教材', '生活用品', '衣物鞋帽',
  '运动户外', '美妆护肤', '乐器文娱', '其他',
];
const CONDITIONS = ['全新', '几乎全新', '轻微使用痕迹', '明显使用痕迹'];

// ---------------------------------------------------------------------------
// 初始化目录与数据库
// ---------------------------------------------------------------------------
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  nickname      TEXT    NOT NULL,
  phone         TEXT    DEFAULT '',
  wechat        TEXT    DEFAULT '',
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id   INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  description TEXT    DEFAULT '',
  price       REAL    NOT NULL,
  category    TEXT    NOT NULL,
  cond        TEXT    DEFAULT '全新',
  location    TEXT    DEFAULT '',
  contact     TEXT    DEFAULT '',
  images      TEXT    DEFAULT '[]',
  status      TEXT    DEFAULT 'available',
  created_at  TEXT    NOT NULL,
  FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_items_seller  ON items(seller_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
`);

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const key = part.slice(0, i).trim();
      const val = part.slice(i + 1).trim();
      try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
    }
  }
  return out;
}

// 密码散列：scrypt + 随机盐
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return test.length === expected.length && crypto.timingSafeEqual(test, expected);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, userId, now.toISOString(), expiresAt.toISOString());
  return token;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `session=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}

// 通过会话 Cookie 解析当前登录用户；未登录返回 null
function getCurrentUser(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.nickname, u.phone, u.wechat, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    phone: row.phone,
    wechat: row.wechat,
  };
}

function requireUser(req) {
  const user = getCurrentUser(req);
  if (!user) throw new HttpError(401, '请先登录');
  return user;
}

// 保存一张 base64 图片到 uploads，返回可访问的 URL 路径
function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new HttpError(400, '图片格式无效');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) throw new HttpError(400, '图片内容为空');
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(400, '单张图片不能超过 6MB');
  const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return `/uploads/${name}`;
}

function publicUser(row) {
  return { id: row.seller_uid, nickname: row.seller_nickname, username: row.seller_username };
}

function publicItem(row) {
  let images = [];
  try { images = JSON.parse(row.images || '[]'); } catch { images = []; }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    price: row.price,
    category: row.category,
    cond: row.cond,
    location: row.location,
    contact: row.contact,
    images,
    status: row.status,
    created_at: row.created_at,
    seller: publicUser(row),
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, filePath) {
  const safe = path.normalize(filePath);
  fs.stat(safe, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(safe).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(safe).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// 路由处理函数
// ---------------------------------------------------------------------------
async function handleRegister(req, res) {
  const raw = await readBody(req, 1024 * 1024);
  let data;
  try { data = JSON.parse(raw.toString('utf8') || '{}'); } catch { throw new HttpError(400, '请求格式错误'); }

  const username = String(data.username || '').trim();
  const password = String(data.password || '');
  const nickname = String(data.nickname || '').trim() || username;

  if (!/^[\w\u4e00-\u9fa5.-]{3,20}$/.test(username)) {
    throw new HttpError(400, '用户名需 3-20 位，仅限中英文、数字、下划线、点、短横线');
  }
  if (password.length < 6) throw new HttpError(400, '密码至少 6 位');
  if (nickname.length > 20) throw new HttpError(400, '昵称最长 20 字');

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) throw new HttpError(409, '该用户名已被注册');

  const now = new Date().toISOString();
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, nickname, phone, wechat, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(username, hashPassword(password), nickname,
    String(data.phone || '').trim(), String(data.wechat || '').trim(), now);

  const token = createSession(Number(info.lastInsertRowid));
  setSessionCookie(res, token);
  json(res, 201, {
    user: {
      id: Number(info.lastInsertRowid),
      username, nickname,
      phone: String(data.phone || '').trim(),
      wechat: String(data.wechat || '').trim(),
    },
  });
}

async function handleLogin(req, res) {
  const raw = await readBody(req, 1024 * 1024);
  let data;
  try { data = JSON.parse(raw.toString('utf8') || '{}'); } catch { throw new HttpError(400, '请求格式错误'); }

  const username = String(data.username || '').trim();
  const password = String(data.password || '');
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw new HttpError(401, '用户名或密码错误');
  }

  const token = createSession(row.id);
  setSessionCookie(res, token);
  json(res, 200, {
    user: { id: row.id, username: row.username, nickname: row.nickname, phone: row.phone, wechat: row.wechat },
  });
}

async function handleLogout(req, res) {
  const token = parseCookies(req).session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  clearSessionCookie(res);
  json(res, 200, { ok: true });
}

function handleMe(req, res) {
  const user = getCurrentUser(req);
  if (!user) return json(res, 200, { user: null });
  json(res, 200, { user });
}

function handleCategories(req, res) {
  json(res, 200, { categories: CATEGORIES, conditions: CONDITIONS });
}

function listItems(req, res, url) {
  const q = url.searchParams.get('search') || '';
  const category = url.searchParams.get('category') || '';
  const mine = url.searchParams.get('mine') === '1';
  const sort = url.searchParams.get('sort') || 'new';

  let sql = `
    SELECT i.*, u.id AS seller_uid, u.nickname AS seller_nickname, u.username AS seller_username
    FROM items i JOIN users u ON u.id = i.seller_id
    WHERE i.status != 'removed'
  `;
  const params = [];

  if (mine) {
    const user = requireUser(req);
    sql += ' AND i.seller_id = ?';
    params.push(user.id);
  }
  if (category) {
    sql += ' AND i.category = ?';
    params.push(category);
  }
  if (q) {
    sql += ' AND (i.title LIKE ? OR i.description LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }

  const order = { new: 'i.created_at DESC', old: 'i.created_at ASC', price_asc: 'i.price ASC', price_desc: 'i.price DESC' }[sort] || 'i.created_at DESC';
  sql += ` ORDER BY ${order}`;

  const rows = db.prepare(sql).all(...params);
  json(res, 200, { items: rows.map(publicItem) });
}

function getItem(req, res, id) {
  const row = db.prepare(`
    SELECT i.*, u.id AS seller_uid, u.nickname AS seller_nickname, u.username AS seller_username
    FROM items i JOIN users u ON u.id = i.seller_id
    WHERE i.id = ? AND i.status != 'removed'
  `).get(id);
  if (!row) throw new HttpError(404, '商品不存在');
  json(res, 200, { item: publicItem(row) });
}

async function createItem(req, res) {
  const user = requireUser(req);
  const raw = await readBody(req);
  let data;
  try { data = JSON.parse(raw.toString('utf8') || '{}'); } catch { throw new HttpError(400, '请求格式错误'); }

  const title = String(data.title || '').trim();
  const description = String(data.description || '').trim();
  const price = Number(data.price);
  const category = String(data.category || '').trim();
  const cond = String(data.cond || '全新').trim();
  const location = String(data.location || '').trim();
  const contact = String(data.contact || '').trim();

  if (!title || title.length > 60) throw new HttpError(400, '标题不能为空且最长 60 字');
  if (!Number.isFinite(price) || price < 0 || price > 99999999) throw new HttpError(400, '价格无效');
  if (!CATEGORIES.includes(category)) throw new HttpError(400, '分类无效');
  if (!CONDITIONS.includes(cond)) throw new HttpError(400, '成色无效');
  if (description.length > 2000) throw new HttpError(400, '描述最长 2000 字');

  const images = Array.isArray(data.images) ? data.images.slice(0, MAX_IMAGES) : [];
  const savedImages = images.map(saveImage);

  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO items (seller_id, title, description, price, category, cond, location, contact, images, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?)
  `).run(user.id, title, description, price, category, cond, location, contact,
    JSON.stringify(savedImages), now);

  json(res, 201, { item: { id: Number(info.lastInsertRowid), title, images: savedImages } });
}

async function deleteItem(req, res, id) {
  const user = requireUser(req);
  const row = db.prepare('SELECT id, seller_id, images FROM items WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, '商品不存在');
  if (row.seller_id !== user.id) throw new HttpError(403, '只能删除自己发布的商品');

  // 删除关联的图片文件
  let images = [];
  try { images = JSON.parse(row.images || '[]'); } catch { images = []; }
  for (const p of images) {
    const abs = path.join(ROOT, p.replace(/^\//, ''));
    if (abs.startsWith(UPLOAD_DIR)) { try { fs.unlinkSync(abs); } catch { /* 忽略 */ } }
  }

  db.prepare("UPDATE items SET status = 'removed' WHERE id = ?").run(id);
  json(res, 200, { ok: true });
}

async function markSold(req, res, id) {
  const user = requireUser(req);
  const row = db.prepare('SELECT id, seller_id FROM items WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, '商品不存在');
  if (row.seller_id !== user.id) throw new HttpError(403, '只能操作自己发布的商品');

  let data = {};
  try { data = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); } catch { /* 忽略 */ }
  const status = data.status === 'sold' ? 'sold' : 'available';
  db.prepare('UPDATE items SET status = ? WHERE id = ?').run(status, id);
  json(res, 200, { ok: true, status });
}

// ---------------------------------------------------------------------------
// HTTP 服务器与路由分发
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';

  const log = () => {
    const user = getCurrentUser(req);
    console.log(`${new Date().toISOString()} ${method} ${pathname} ${user ? '(user:' + user.username + ')' : '(guest)'}`);
  };

  try {
    // 静态资源与上传文件
    if (method === 'GET' && pathname.startsWith('/uploads/')) {
      log();
      return serveStatic(req, res, path.join(ROOT, pathname));
    }
    if (method === 'GET' && pathname.startsWith('/assets/')) {
      log();
      return serveStatic(req, res, path.join(PUBLIC_DIR, pathname.slice('/assets/'.length)));
    }

    // API 路由
    if (pathname === '/api/categories' && method === 'GET') {
      log(); return handleCategories(req, res);
    }
    if (pathname === '/api/register' && method === 'POST') {
      log(); return await handleRegister(req, res);
    }
    if (pathname === '/api/login' && method === 'POST') {
      log(); return await handleLogin(req, res);
    }
    if (pathname === '/api/logout' && method === 'POST') {
      log(); return await handleLogout(req, res);
    }
    if (pathname === '/api/me' && method === 'GET') {
      log(); return handleMe(req, res);
    }
    if (pathname === '/api/items' && method === 'GET') {
      log(); return listItems(req, res, url);
    }
    if (pathname === '/api/items' && method === 'POST') {
      log(); return await createItem(req, res);
    }

    const itemMatch = pathname.match(/^\/api\/items\/(\d+)$/);
    if (itemMatch) {
      const id = Number(itemMatch[1]);
      if (method === 'GET') { log(); return getItem(req, res, id); }
      if (method === 'DELETE') { log(); return await deleteItem(req, res, id); }
    }
    const soldMatch = pathname.match(/^\/api\/items\/(\d+)\/status$/);
    if (soldMatch && method === 'POST') {
      log(); return await markSold(req, res, Number(soldMatch[1]));
    }

    // 前端页面
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      log();
      return serveStatic(req, res, path.join(PUBLIC_DIR, 'index.html'));
    }

    log();
    throw new HttpError(404, '接口不存在');
  } catch (err) {
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.message });
    } else {
      console.error('服务器错误:', err);
      json(res, 500, { error: '服务器内部错误' });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  🎓 校园交易平台已启动');
  console.log(`  ➜ 本机访问:  http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  if (HOST === '0.0.0.0') console.log('  ➜ 局域网访问: 使用本机 IP 地址 + 端口 ' + PORT);
  console.log(`  ➜ 数据库:    ${DB_PATH}`);
  console.log('');
});
