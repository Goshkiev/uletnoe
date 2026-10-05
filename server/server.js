// Сервер заказов кафе «Улётное». Без внешних зависимостей: Node.js 22+ и встроенный SQLite.
// Сайт и картинки отдаёт nginx, сюда приходят только запросы /api/*.
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const webpush = require('./webpush');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SITE_DIR = process.env.SITE_DIR || path.join(__dirname, '..');
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
const PUSH_SUBJECT = process.env.PUSH_SUBJECT || 'mailto:admin@localhost';
const TZ = 'Europe/Moscow';
const CONSENT_VERSION = process.env.CONSENT_VERSION || '2026-10-05';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- База ----------

const db = new DatabaseSync(path.join(DATA_DIR, 'uletnoe.sqlite'));
db.exec(`
  pragma journal_mode = wal;
  create table if not exists orders (
    id text primary key,
    day text not null,
    number integer not null,
    created_at text not null,
    updated_at text not null,
    status text not null default 'new',
    customer_name text,
    phone text,
    pickup_at text,
    comment text,
    items text not null,
    total integer not null,
    consent_at text,
    consent_version text,
    ip text
  );
  create index if not exists orders_created on orders (created_at);
  create table if not exists staff (
    id integer primary key,
    login text not null unique,
    pass_hash text not null,
    created_at text not null
  );
  create table if not exists sessions (
    token_hash text primary key,
    staff_id integer not null references staff(id) on delete cascade,
    expires_at integer not null
  );
  create table if not exists installs (
    id text primary key,
    created_at text not null,
    last_seen text not null,
    platform text,
    launches integer not null default 1
  );
  create table if not exists push_subs (
    endpoint text primary key,
    staff_id integer not null references staff(id) on delete cascade,
    created_at text not null
  );
`);

// Миграции для баз, созданных до появления колонок.
const orderCols = db.prepare('pragma table_info(orders)').all().map((c) => c.name);
if (!orderCols.includes('source')) db.exec("alter table orders add column source text not null default 'web'");
if (!orderCols.includes('install_id')) db.exec('alter table orders add column install_id text');
db.exec('create index if not exists orders_install on orders (install_id)');

const STATUSES = ['new', 'cooking', 'ready', 'done', 'cancelled'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLATFORMS = ['android', 'ios', 'desktop', 'other'];
const nowIso = () => new Date().toISOString();
const moscowDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

function rowToOrder(r) {
  return r && {
    id: r.id, number: r.number, created_at: r.created_at, updated_at: r.updated_at, status: r.status,
    customer_name: r.customer_name, phone: r.phone, pickup_at: r.pickup_at, comment: r.comment,
    items: JSON.parse(r.items), total: r.total,
  };
}

// ---------- Пароли и сессии ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function checkPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64'), 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, 'base64'));
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SESSION_DAYS = 30;

function staffFromRequest(req) {
  const m = /(?:^|;\s*)ul_staff=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const row = db.prepare(`select s.id, s.login from sessions x join staff s on s.id = x.staff_id
                          where x.token_hash = ? and x.expires_at > ?`).get(sha256(m[1]), Date.now());
  return row || null;
}

// ---------- Меню: цены берём с сервера, а не из браузера ----------

let menuCache = { mtime: 0, items: new Map() };
function menuItems() {
  const file = path.join(SITE_DIR, 'menu.json');
  const mtime = fs.statSync(file).mtimeMs;
  if (mtime !== menuCache.mtime) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = new Map();
    data.categories.forEach((c) => c.items.forEach((i) => { if (!i.hidden) items.set(i.id, i); }));
    menuCache = { mtime, items };
  }
  return menuCache.items;
}

// ---------- Ограничение частоты ----------

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.every((t) => now - t > 3600e3)) hits.delete(k); }, 600e3).unref();

// ---------- Онлайн-обновления (SSE) и push ----------

const streams = new Set();
function broadcast(order) {
  const msg = `event: order\ndata: ${JSON.stringify(order)}\n\n`;
  for (const res of streams) res.write(msg);
}
setInterval(() => { for (const res of streams) res.write(': ping\n\n'); }, 25000).unref();

const vapid = webpush.loadKeys(DATA_DIR);
async function pushAll() {
  const subs = db.prepare('select endpoint from push_subs').all();
  await Promise.all(subs.map(async ({ endpoint }) => {
    try {
      const status = await webpush.sendEmpty(endpoint, vapid, PUSH_SUBJECT);
      if (status === 404 || status === 410) db.prepare('delete from push_subs where endpoint = ?').run(endpoint);
    } catch (e) { console.error('push failed', e.message); }
  }));
}

// ---------- Обезличивание старых заказов (152-ФЗ: храним ПДн не дольше нужного) ----------

function purgeOld() {
  const before = new Date(Date.now() - RETENTION_DAYS * 86400e3).toISOString();
  db.prepare(`update orders set phone = null, customer_name = null, comment = null, ip = null
              where created_at < ? and (phone is not null or ip is not null)`).run(before);
  db.prepare('delete from sessions where expires_at < ?').run(Date.now());
}
purgeOld();
setInterval(purgeOld, 3600e3).unref();

// ---------- HTTP ----------

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'Нужен JSON'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new HttpError(400, 'Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

const clientIp = (req) => (req.headers['x-real-ip'] || req.socket.remoteAddress || '').toString();
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10 && d[0] === '9') d = '7' + d;
  return d.length >= 10 && d.length <= 15 ? '+' + d : null;
}

function createOrder(body, ip) {
  if (body.consent !== true) throw new HttpError(400, 'Нужно согласие на обработку персональных данных');
  const phone = normalizePhone(body.phone);
  if (!phone) throw new HttpError(400, 'Проверьте номер телефона');
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) throw new HttpError(400, 'Корзина пуста или слишком большая');

  let pickupAt = null;
  if (body.pickup_at) {
    const t = new Date(body.pickup_at);
    if (isNaN(t) || t < Date.now() - 5 * 60e3 || t > Date.now() + 24 * 3600e3) throw new HttpError(400, 'Время самовывоза должно быть в ближайшие сутки');
    pickupAt = t.toISOString();
  }

  const menu = menuItems();
  let total = 0;
  const items = body.items.map((line) => {
    const item = menu.get(String(line.id));
    const qty = Number(line.qty);
    if (!item || !Number.isInteger(qty) || qty < 1 || qty > 20) throw new HttpError(400, 'Некоторых блюд уже нет в меню. Обновите страницу.');
    let price = item.price;
    let variant = null;
    if (item.variants) {
      const v = item.variants.find((x) => x.label === line.variant);
      if (!v) throw new HttpError(400, 'Некоторых блюд уже нет в меню. Обновите страницу.');
      price = v.price; variant = v.label;
    }
    total += price * qty;
    return { id: item.id, name: item.name, variant, price, qty };
  });

  const id = crypto.randomUUID();
  const now = nowIso();
  const day = moscowDay();
  // Короткий номер заказа, с 1 каждый день. Node однопоточный, поэтому гонок нет.
  const number = (db.prepare('select max(number) n from orders where day = ?').get(day).n || 0) + 1;
  const source = body.source === 'app' ? 'app' : 'web';
  const installId = UUID.test(String(body.install_id || '')) ? body.install_id : null;
  db.prepare(`insert into orders (id, day, number, created_at, updated_at, status, customer_name, phone, pickup_at, comment, items, total, consent_at, consent_version, ip, source, install_id)
              values (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, day, number, now, now,
      String(body.name || '').trim().slice(0, 60) || null, phone, pickupAt,
      String(body.comment || '').trim().slice(0, 500) || null,
      JSON.stringify(items), total, now, CONSENT_VERSION, ip, source, installId);
  return rowToOrder(db.prepare('select * from orders where id = ?').get(id));
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/health$/, () => ({ ok: true }));

route('POST', /^\/api\/orders$/, async (req) => {
  const ip = clientIp(req);
  if (limited(`order:${ip}`, 5, 10 * 60e3)) throw new HttpError(429, 'Слишком много заказов подряд. Попробуйте через несколько минут или позвоните нам.');
  const order = createOrder(await readJson(req), ip);
  broadcast(order);
  pushAll();
  return { id: order.id, number: order.number, total: order.total };
});

route('GET', /^\/api\/orders\/([0-9a-f-]{36})$/, (req, m) => {
  const r = db.prepare('select number, status, pickup_at, total from orders where id = ?').get(m[1]);
  if (!r) throw new HttpError(404, 'Заказ не найден');
  return r;
});

route('POST', /^\/api\/staff\/login$/, async (req, m, res) => {
  const ip = clientIp(req);
  if (limited(`login:${ip}`, 10, 10 * 60e3)) throw new HttpError(429, 'Слишком много попыток входа. Подождите 10 минут.');
  const body = await readJson(req);
  const staff = db.prepare('select * from staff where login = ?').get(String(body.login || '').trim().toLowerCase());
  if (!staff || !checkPassword(String(body.password || ''), staff.pass_hash)) throw new HttpError(401, 'Неверный логин или пароль');
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('insert into sessions (token_hash, staff_id, expires_at) values (?, ?, ?)').run(sha256(token), staff.id, Date.now() + SESSION_DAYS * 86400e3);
  res.setHeader('Set-Cookie', `ul_staff=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`);
  return { login: staff.login };
});

function requireStaff(req) {
  const staff = staffFromRequest(req);
  if (!staff) throw new HttpError(401, 'Нужно войти');
  return staff;
}

route('POST', /^\/api\/staff\/logout$/, (req, m, res) => {
  const mm = /(?:^|;\s*)ul_staff=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
  if (mm) db.prepare('delete from sessions where token_hash = ?').run(sha256(mm[1]));
  res.setHeader('Set-Cookie', 'ul_staff=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0');
  return { ok: true };
});

route('GET', /^\/api\/staff\/me$/, (req) => ({ login: requireStaff(req).login }));

route('GET', /^\/api\/staff\/orders$/, (req) => {
  requireStaff(req);
  const url = new URL(req.url, 'http://x');
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const status = url.searchParams.get('status');
  const rows = status && STATUSES.includes(status)
    ? db.prepare('select * from orders where created_at >= ? and status = ? order by created_at').all(since, status)
    : db.prepare('select * from orders where created_at >= ? order by created_at').all(since);
  return rows.map(rowToOrder);
});

route('PATCH', /^\/api\/staff\/orders\/([0-9a-f-]{36})$/, async (req, m) => {
  requireStaff(req);
  const { status } = await readJson(req);
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Неизвестный статус');
  const r = db.prepare('update orders set status = ?, updated_at = ? where id = ?').run(status, nowIso(), m[1]);
  if (!r.changes) throw new HttpError(404, 'Заказ не найден');
  const order = rowToOrder(db.prepare('select * from orders where id = ?').get(m[1]));
  broadcast(order);
  return order;
});

route('GET', /^\/api\/staff\/stream$/, (req, m, res) => {
  requireStaff(req);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  streams.add(res);
  req.on('close', () => streams.delete(res));
  return undefined;
});

// Установки приложения: случайный id устройства, без персональных данных.
route('POST', /^\/api\/installs$/, async (req) => {
  if (limited(`install:${clientIp(req)}`, 20, 10 * 60e3)) throw new HttpError(429, 'Слишком много запросов');
  const { id, platform } = await readJson(req);
  if (!UUID.test(String(id || ''))) throw new HttpError(400, 'Некорректный id');
  const p = PLATFORMS.includes(platform) ? platform : 'other';
  const now = nowIso();
  db.prepare(`insert into installs (id, created_at, last_seen, platform) values (?, ?, ?, ?)
              on conflict(id) do update set last_seen = excluded.last_seen, launches = launches + 1`).run(id, now, now, p);
  return { ok: true };
});

route('GET', /^\/api\/staff\/stats$/, (req) => {
  requireStaff(req);
  const ago = (days) => new Date(Date.now() - days * 86400e3).toISOString();
  const count = (sql, ...a) => db.prepare(sql).get(...a).n;
  const bySource = Object.fromEntries(db.prepare(`select source, count(*) n, coalesce(sum(total), 0) sum from orders
                                                  where created_at >= ? and status != 'cancelled' group by source`).all(ago(30))
    .map((r) => [r.source, { count: r.n, sum: r.sum }]));
  const list = db.prepare(`
    select i.id, i.created_at, i.last_seen, i.platform, i.launches,
           (select count(*) from orders o where o.install_id = i.id) orders,
           (select max(created_at) from orders o where o.install_id = i.id) last_order_at,
           (select phone from orders o where o.install_id = i.id and phone is not null order by created_at desc limit 1) phone,
           (select customer_name from orders o where o.install_id = i.id and customer_name is not null order by created_at desc limit 1) name
    from installs i order by i.created_at desc limit 300`).all();
  return {
    installs: {
      total: count('select count(*) n from installs'),
      d7: count('select count(*) n from installs where created_at >= ?', ago(7)),
      d30: count('select count(*) n from installs where created_at >= ?', ago(30)),
      active30: count('select count(*) n from installs where last_seen >= ?', ago(30)),
    },
    orders30: { app: bySource.app || { count: 0, sum: 0 }, web: bySource.web || { count: 0, sum: 0 } },
    list: list.map((r) => ({ ...r })),
  };
});

route('GET', /^\/api\/staff\/push\/key$/, (req) => { requireStaff(req); return { publicKey: vapid.publicKey }; });

route('POST', /^\/api\/staff\/push\/subscribe$/, async (req) => {
  const staff = requireStaff(req);
  const { endpoint } = await readJson(req);
  let u;
  try { u = new URL(endpoint); } catch (e) { throw new HttpError(400, 'Некорректная подписка'); }
  if (u.protocol !== 'https:') throw new HttpError(400, 'Некорректная подписка');
  db.prepare('insert or replace into push_subs (endpoint, staff_id, created_at) values (?, ?, ?)').run(endpoint, staff.id, nowIso());
  return { ok: true };
});

const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  const candidates = routes.filter((r) => r.pattern.test(pathname));
  const r = candidates.find((x) => x.method === req.method);
  try {
    if (!r) throw new HttpError(candidates.length ? 405 : 404, 'Не найдено');
    const result = await r.handler(req, r.pattern.exec(pathname), res);
    if (result !== undefined && !res.headersSent) send(res, 200, result);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Ошибка сервера' });
    else res.end();
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`uletnoe api on http://${HOST}:${PORT}`));
}

module.exports = { server, db, hashPassword, checkPassword, normalizePhone, purgeOld };
