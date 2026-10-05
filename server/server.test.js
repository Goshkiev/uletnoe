'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'uletnoe-'));
process.env.SITE_DIR = path.join(__dirname, '..');
const { server, db, hashPassword } = require('./server');

let base;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.closeAllConnections(); server.close(); });

let ipSeq = 0;
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-real-ip': `10.1.0.${++ipSeq}`, ...headers }, body: JSON.stringify(body) });
const order = (extra = {}) => ({ phone: '8 (999) 123-45-67', consent: true, items: [{ id: 'teisti', qty: 2 }, { id: 'sh-chicken', variant: '650 г', qty: 1 }], ...extra });

test('guest places an order; prices come from menu.json, not the browser', async () => {
  const res = await post('/api/orders', order({ items: [{ id: 'teisti', qty: 2, price: 1 }, { id: 'sh-chicken', variant: '650 г', qty: 1 }] }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.number, 1);
  assert.equal(data.total, 530 * 2 + 570);
  const st = await (await fetch(`${base}/api/orders/${data.id}`)).json();
  assert.deepEqual(st, { number: 1, status: 'new', pickup_at: null, total: 1630 });
  const row = db.prepare('select phone, consent_at from orders where id = ?').get(data.id);
  assert.equal(row.phone, '+79991234567');
  assert.ok(row.consent_at);
});

test('rejects orders without consent, bad phone, unknown items, bad time', async () => {
  for (const [body, msg] of [
    [order({ consent: false }), /согласие/],
    [order({ phone: '123' }), /телефон/],
    [order({ items: [{ id: 'nope', qty: 1 }] }), /нет в меню/],
    [order({ items: [{ id: 'sh-chicken', variant: '999 г', qty: 1 }] }), /нет в меню/],
    [order({ items: [{ id: 'teisti', qty: 50 }] }), /нет в меню/],
    [order({ items: [] }), /Корзина/],
    [order({ pickup_at: new Date(Date.now() + 3 * 86400e3).toISOString() }), /сутки/],
  ]) {
    const res = await post('/api/orders', body);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, msg);
  }
  const plain = await fetch(base + '/api/orders', { method: 'POST', body: 'x' });
  assert.equal(plain.status, 415);
});

test('guests cannot read orders; staff can after login', async () => {
  assert.equal((await fetch(base + '/api/staff/orders')).status, 401);
  db.prepare('insert into staff (login, pass_hash, created_at) values (?, ?, ?)').run('kafe', hashPassword('secret'), new Date().toISOString());
  assert.equal((await post('/api/staff/login', { login: 'kafe', password: 'wrong' })).status, 401);
  const login = await post('/api/staff/login', { login: 'Kafe', password: 'secret' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const list = await (await fetch(base + '/api/staff/orders', { headers: { cookie } })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].phone, '+79991234567');

  // Live stream gets the next order and the status change.
  const ctrl = new AbortController();
  const stream = await fetch(base + '/api/staff/stream', { headers: { cookie }, signal: ctrl.signal });
  const reader = stream.body.getReader();
  let text = '';
  const got = (re) => (async () => { while (!re.test(text)) { const { value } = await reader.read(); text += Buffer.from(value).toString(); } })();
  const placed = await (await post('/api/orders', order({ name: 'Миша', comment: 'без лука' }))).json();
  await got(/"number":2/);
  assert.equal(placed.number, 2);
  const patch = await fetch(`${base}/api/staff/orders/${placed.id}`, { method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cooking' }) });
  assert.equal((await patch.json()).status, 'cooking');
  await got(/"status":"cooking"/);
  ctrl.abort();

  const bad = await fetch(`${base}/api/staff/orders/${placed.id}`, { method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'eaten' }) });
  assert.equal(bad.status, 400);
  const onlyNew = await (await fetch(base + '/api/staff/orders?status=new', { headers: { cookie } })).json();
  assert.deepEqual(onlyNew.map((o) => o.number), [1]);

  const key = await (await fetch(base + '/api/staff/push/key', { headers: { cookie } })).json();
  assert.equal(Buffer.from(key.publicKey, 'base64url').length, 65);

  await post('/api/staff/logout', {}, { cookie });
  assert.equal((await fetch(base + '/api/staff/orders', { headers: { cookie } })).status, 401);
});

test('rate limit: too many orders from one address', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await post('/api/orders', order(), { 'x-real-ip': '10.0.0.9' });
  assert.equal(last.status, 429);
});

test('old orders lose personal data', () => {
  const { purgeOld } = require('./server');
  const old = new Date(Date.now() - 40 * 86400e3).toISOString();
  db.prepare(`insert into orders (id, day, number, created_at, updated_at, items, total, phone, customer_name, ip)
              values ('00000000-0000-0000-0000-000000000000', '2000-01-01', 1, ?, ?, '[]', 0, '+70000000000', 'X', '1.1.1.1')`).run(old, old);
  purgeOld();
  const row = db.prepare("select phone, customer_name, ip, total from orders where id = '00000000-0000-0000-0000-000000000000'").get();
  assert.deepEqual({ ...row }, { phone: null, customer_name: null, ip: null, total: 0 });
  const fresh = db.prepare('select count(*) n from orders where phone is not null').get().n;
  assert.ok(fresh >= 2);
});
