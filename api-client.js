// Связь сайта и экрана заказов с сервером.
// На своём сервере запросы идут на /api. На GitHub Pages сервера нет, поэтому там включается демо-режим:
// заказы хранятся только в этом браузере, и их видно на /admin/, открытом в соседней вкладке.
(function () {
  const cfg = window.ULETNOE_CONFIG || {};
  let base = cfg.api || 'auto';
  if (base === 'auto') base = /\.github\.io$/.test(location.hostname) ? 'demo' : '/api';

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw Object.assign(new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.'), { status: 0 });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Ошибка сервера. Попробуйте ещё раз.'), { status: res.status });
    return data;
  }

  const server = {
    mode: 'server',
    placeOrder: (order) => call('POST', '/orders', order),
    orderStatus: (id) => call('GET', `/orders/${encodeURIComponent(id)}`),
    registerInstall: (id, platform) => call('POST', '/installs', { id, platform }),
    staff: {
      login: (login, password) => call('POST', '/staff/login', { login, password }),
      logout: () => call('POST', '/staff/logout', {}),
      me: () => call('GET', '/staff/me').catch((e) => { if (e.status === 401) return null; throw e; }),
      orders: (status) => call('GET', `/staff/orders${status ? `?status=${status}` : ''}`),
      setStatus: (id, status) => call('PATCH', `/staff/orders/${encodeURIComponent(id)}`, { status }),
      stream(onOrder, onState) {
        const es = new EventSource(`${base}/staff/stream`, { withCredentials: true });
        es.addEventListener('order', (e) => onOrder(JSON.parse(e.data)));
        es.onopen = () => onState(true);
        es.onerror = () => onState(false);
        return () => es.close();
      },
      pushKey: () => call('GET', '/staff/push/key').then((d) => d.publicKey),
      pushSubscribe: (sub) => call('POST', '/staff/push/subscribe', sub),
      stats: () => call('GET', '/staff/stats'),
    },
  };

  // ---------- Демо: всё в localStorage этого браузера ----------

  const KEY = 'uletnoe.demo.orders';
  const SESSION = 'uletnoe.demo.session';
  const INSTALLS = 'uletnoe.demo.installs';
  const readI = () => { try { return JSON.parse(localStorage.getItem(INSTALLS)) || []; } catch (e) { return []; } };
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } };
  const write = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* ignore */ } };
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('uletnoe-demo') : null;
  const listeners = new Set();
  if (bc) bc.onmessage = (e) => listeners.forEach((cb) => cb(e.data));
  const emit = (o) => { if (bc) bc.postMessage(o); listeners.forEach((cb) => cb(o)); };
  const later = (v) => new Promise((r) => setTimeout(() => r(v), 150));

  const demo = {
    mode: 'demo',
    async placeOrder(o) {
      if (!o.consent) throw new Error('Нужно согласие на обработку персональных данных');
      const list = read();
      const day = new Date().toDateString();
      const number = list.filter((x) => new Date(x.created_at).toDateString() === day).length + 1;
      const items = o.items.map((i) => ({ id: i.id, name: i.name, variant: i.variant || null, price: i.price, qty: i.qty }));
      const now = new Date().toISOString();
      const order = { id: crypto.randomUUID(), number, created_at: now, updated_at: now, status: 'new', customer_name: o.name || null,
        source: o.source === 'app' ? 'app' : 'web', install_id: o.install_id || null,
        phone: o.phone, pickup_at: o.pickup_at || null, comment: o.comment || null, items, total: items.reduce((s, i) => s + i.price * i.qty, 0) };
      list.push(order); write(list); emit(order);
      return later({ id: order.id, number, total: order.total });
    },
    async orderStatus(id) {
      const o = read().find((x) => x.id === id);
      if (!o) throw Object.assign(new Error('Заказ не найден'), { status: 404 });
      return later({ number: o.number, status: o.status, pickup_at: o.pickup_at, total: o.total });
    },
    async registerInstall(id, platform) {
      const list = readI();
      const now = new Date().toISOString();
      const i = list.find((x) => x.id === id);
      if (i) { i.last_seen = now; i.launches++; } else list.push({ id, platform, created_at: now, last_seen: now, launches: 1 });
      try { localStorage.setItem(INSTALLS, JSON.stringify(list)); } catch (e) { /* ignore */ }
      return {};
    },
    staff: {
      async stats() {
        const ago = (d) => Date.now() - d * 86400e3;
        const orders = read();
        const recent = orders.filter((o) => new Date(o.created_at) >= ago(30) && o.status !== 'cancelled');
        const sum = (src) => { const l = recent.filter((o) => (o.source || 'web') === src); return { count: l.length, sum: l.reduce((s, o) => s + o.total, 0) }; };
        const installs = readI();
        return later({
          installs: {
            total: installs.length,
            d7: installs.filter((i) => new Date(i.created_at) >= ago(7)).length,
            d30: installs.filter((i) => new Date(i.created_at) >= ago(30)).length,
            active30: installs.filter((i) => new Date(i.last_seen) >= ago(30)).length,
          },
          orders30: { app: sum('app'), web: sum('web') },
          list: installs.slice().reverse().map((i) => {
            const mine = orders.filter((o) => o.install_id === i.id).sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
            return { ...i, orders: mine.length, last_order_at: mine[0] ? mine[0].created_at : null, phone: mine[0] ? mine[0].phone : null, name: (mine.find((o) => o.customer_name) || {}).customer_name || null };
          }),
        });
      },
      async login(login, password) {
        if (login !== 'demo' || password !== 'demo') throw Object.assign(new Error('В демо-режиме логин demo, пароль demo'), { status: 401 });
        try { localStorage.setItem(SESSION, 'demo'); } catch (e) { /* ignore */ }
        return later({ login });
      },
      async logout() { try { localStorage.removeItem(SESSION); } catch (e) { /* ignore */ } return {}; },
      async me() { try { return localStorage.getItem(SESSION) ? { login: 'demo' } : null; } catch (e) { return null; } },
      async orders(status) {
        const since = Date.now() - 24 * 3600e3;
        return later(read().filter((o) => new Date(o.created_at) >= since && (!status || o.status === status)));
      },
      async setStatus(id, status) {
        const list = read();
        const o = list.find((x) => x.id === id);
        if (!o) throw new Error('Заказ не найден');
        Object.assign(o, { status, updated_at: new Date().toISOString() });
        write(list); emit(o);
        return later(o);
      },
      stream(onOrder, onState) {
        listeners.add(onOrder);
        setTimeout(() => onState(true), 0);
        return () => listeners.delete(onOrder);
      },
      pushKey: async () => null,
      pushSubscribe: async () => ({}),
    },
  };

  window.UletnoeAPI = base === 'demo' ? demo : base === 'off' ? null : server;
})();
