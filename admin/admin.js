// «Заказы»: экран кафе и приложение управляющего. Новые заказы приходят мгновенно и пищат, пока их не возьмут в работу.
(function () {
  const app = document.getElementById('app');
  const api = window.UletnoeAPI;
  const PREF_SOUND = 'uletnoe.admin.sound';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => `${Number(n).toLocaleString('ru-RU')} ₽`;
  const hhmm = (d) => new Date(d).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const pref = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  if (!api) {
    app.innerHTML = `<div class="center card-box"><h1>Приём заказов выключен</h1>
      <p class="muted">В config.js стоит api: 'off'.</p></div>`;
    return;
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // ---------- Вход ----------

  function showLogin(message) {
    stopLive();
    app.innerHTML = `
      <form class="center card-box login" novalidate>
        <img src="icon-192.png" alt="" width="72" height="72">
        <h1>Заказы «Улётного»</h1>
        ${api.mode === 'demo' ? '<p class="demo-note">Демо-режим: здесь видны заказы, оформленные на сайте в этом же браузере. Логин demo, пароль demo.</p>' : ''}
        <label class="field"><span>Логин</span><input id="login-email" type="text" autocapitalize="none" autocomplete="username" required></label>
        <label class="field"><span>Пароль</span><input id="login-password" type="password" autocomplete="current-password" required></label>
        ${message ? `<p class="form-error" role="alert">${esc(message)}</p>` : ''}
        <button type="submit" class="btn primary">Войти</button>
      </form>`;
    const form = app.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.disabled = true; btn.textContent = 'Входим…';
      try {
        await api.staff.login(form.querySelector('#login-email').value.trim(), form.querySelector('#login-password').value);
      } catch (err) {
        showLogin(err.message);
        return;
      }
      start();
    });
    form.querySelector('#login-email').focus();
  }

  // ---------- Звук, уведомления, экран не гаснет ----------

  let audio = null;
  let soundOn = pref.get(PREF_SOUND) !== 'off';
  let wakeLock = null;

  function unlockAudio() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch (e) { audio = null; }
    renderSoundBtn();
  }
  const audioReady = () => audio && audio.state === 'running';
  document.addEventListener('pointerdown', unlockAudio);
  document.addEventListener('keydown', unlockAudio);

  function beep() {
    if (!soundOn || !audioReady()) return;
    const t = audio.currentTime;
    [[880, 0], [1320, 0.18], [880, 0.36], [1320, 0.54]].forEach(([f, dt]) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.exponentialRampToValueAtTime(0.25, t + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.16);
      o.connect(g).connect(audio.destination);
      o.start(t + dt);
      o.stop(t + dt + 0.17);
    });
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }

  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } } catch (e) { /* не поддерживается */ }
  }

  async function notify(order) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    const body = `${order.items.map((i) => `${i.qty}× ${i.name}`).join(', ')} · ${money(order.total)}`;
    try {
      const reg = await navigator.serviceWorker.ready;
      reg.showNotification(`Новый заказ №${order.number}`, { body, tag: order.id, renotify: true, icon: 'icon-192.png', vibrate: [200, 100, 200] });
    } catch (e) {
      try { new Notification(`Новый заказ №${order.number}`, { body }); } catch (e2) { /* ignore */ }
    }
  }

  function renderSoundBtn() {
    const b = document.getElementById('sound-btn');
    if (!b) return;
    const live = soundOn && audioReady();
    b.textContent = !soundOn ? '🔕 Звук выключен' : live ? '🔔 Звук включён' : '🔔 Нажмите, чтобы включить звук';
    b.classList.toggle('warn', soundOn && !live);
    b.setAttribute('aria-pressed', String(soundOn));
  }

  // Push: уведомление придёт, даже когда приложение закрыто. Сами данные заказа через push не передаются.
  async function enablePush() {
    try {
      if (api.mode !== 'server' || !('PushManager' in window) || Notification.permission !== 'granted') return;
      const key = await api.staff.pushKey();
      const reg = await navigator.serviceWorker.ready;
      const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
      await api.staff.pushSubscribe(sub.toJSON());
    } catch (e) { /* push недоступен в этом браузере */ }
  }

  // ---------- Заказы ----------

  const orders = new Map();
  const seen = new Set();
  let firstLoad = true;
  let channel = null;
  let timers = [];

  function upsert(o, fromLive) {
    const isNew = !seen.has(o.id);
    seen.add(o.id);
    orders.set(o.id, o);
    if (isNew && !firstLoad && o.status === 'new') {
      beep();
      notify(o);
      if (fromLive) flash(o.id);
    }
  }

  let flashId = null;
  function flash(id) { flashId = id; setTimeout(() => { flashId = null; }, 4000); }

  async function load() {
    let data;
    try { data = await api.staff.orders(); } catch (e) {
      if (e.status === 401) return showLogin('Сессия истекла, войдите снова.');
      setConn(false);
      return;
    }
    data.forEach((o) => upsert(o, false));
    firstLoad = false;
    render();
  }

  function stopLive() {
    timers.forEach(clearInterval);
    timers = [];
    if (channel) { channel(); channel = null; }
  }

  function setConn(ok) {
    const el = document.getElementById('conn');
    if (el) { el.textContent = ok ? 'Онлайн' : 'Нет связи, переподключаемся…'; el.className = `conn ${ok ? 'ok' : 'bad'}`; }
  }

  function startLive() {
    stopLive();
    channel = api.staff.stream(
      (order) => { upsert(order, true); render(); },
      (ok) => { setConn(ok); if (ok) load(); },
    );
    // Подстраховка: раз в 30 секунд сверяемся с базой, вдруг что-то пропустили.
    timers.push(setInterval(load, 30000));
    // Пищим, пока есть новые заказы, которые никто не взял.
    timers.push(setInterval(() => { if (countNew()) beep(); }, 5000));
    // Обновляем «сколько минут назад».
    timers.push(setInterval(render, 30000));
  }

  const countNew = () => [...orders.values()].filter((o) => o.status === 'new').length;

  async function setStatus(id, status) {
    const o = orders.get(id);
    if (!o) return;
    const prev = o.status;
    o.status = status;
    render();
    try { await api.staff.setStatus(id, status); } catch (e) {
      o.status = prev; render();
      if (e.status === 401) showLogin('Сессия истекла, войдите снова.'); else alertBar('Не удалось сохранить. Проверьте интернет.');
    }
  }

  function alertBar(text) {
    const el = document.getElementById('alert');
    if (!el) return;
    el.textContent = text; el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 5000);
  }

  // ---------- Отрисовка ----------

  const COLUMNS = [
    { status: 'new', title: 'Новые', next: 'cooking', action: 'Взять в работу' },
    { status: 'cooking', title: 'Готовятся', next: 'ready', action: 'Готов' },
    { status: 'ready', title: 'Готовы к выдаче', next: 'done', action: 'Выдан' },
  ];

  function ago(d) {
    const m = Math.max(0, Math.round((Date.now() - new Date(d)) / 60000));
    return m < 1 ? 'только что' : m < 60 ? `${m} мин назад` : `${Math.floor(m / 60)} ч ${m % 60} мин назад`;
  }
  function prettyPhone(p) {
    const d = String(p).replace(/\D/g, '');
    return d.length === 11 && d[0] === '7' ? `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}` : p;
  }

  function orderCard(o, col) {
    const pickup = o.pickup_at ? `К ${hhmm(o.pickup_at)}` : 'Как можно скорее';
    return `
      <article class="order s-${esc(o.status)}${o.id === flashId ? ' flash' : ''}" data-id="${esc(o.id)}">
        <header class="order-head">
          <span class="num">№${esc(o.number)}</span>
          <span class="when">${hhmm(o.created_at)} · ${ago(o.created_at)}</span>
        </header>
        <p class="pickup${o.pickup_at ? ' timed' : ''}">${pickup}</p>
        <ul class="lines">
          ${o.items.map((i) => `<li><b>${esc(i.qty)}×</b> <span>${esc(i.name)}${i.variant ? ` <small>${esc(i.variant)}</small>` : ''}</span></li>`).join('')}
        </ul>
        ${o.comment ? `<p class="comment">${esc(o.comment)}</p>` : ''}
        <p class="who">${o.customer_name ? `${esc(o.customer_name)} · ` : ''}<a href="tel:${esc(o.phone)}">${esc(prettyPhone(o.phone))}</a></p>
        <footer class="order-foot">
          <span class="total">${money(o.total)}</span>
          ${col ? `<button type="button" class="btn primary" data-act="${col.next}">${col.action}</button>` : `<span class="final">${o.status === 'done' ? 'Выдан' : 'Отменён'}</span>`}
        </footer>
        ${col ? '<button type="button" class="link-btn" data-cancel>Отменить заказ</button>' : ''}
      </article>`;
  }

  function render() {
    const main = document.getElementById('board');
    if (!main) return;
    const all = [...orders.values()];
    const n = countNew();
    document.title = n ? `(${n}) Новые заказы · Улётное` : 'Улётное · Заказы';

    main.innerHTML = COLUMNS.map((col) => {
      const list = all.filter((o) => o.status === col.status)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      return `
        <section class="col col-${col.status}">
          <h2>${col.title} <span class="count${col.status === 'new' && list.length ? ' hot' : ''}">${list.length}</span></h2>
          ${list.length ? list.map((o) => orderCard(o, col)).join('') : '<p class="empty">Пусто</p>'}
        </section>`;
    }).join('');

    const finished = all.filter((o) => o.status === 'done' || o.status === 'cancelled')
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    const doneSum = finished.filter((o) => o.status === 'done').reduce((s, o) => s + o.total, 0);
    const hist = document.getElementById('history');
    const wasOpen = hist.open;
    hist.innerHTML = `
      <summary>Завершённые за сутки: ${finished.length}${doneSum ? ` · выдано на ${money(doneSum)}` : ''}</summary>
      <div class="history-list">${finished.map((o) => orderCard(o, null)).join('') || '<p class="empty">Пока нет</p>'}</div>`;
    hist.open = wasOpen;
  }

  function onBoardClick(e) {
    const card = e.target.closest('.order');
    if (!card) return;
    const act = e.target.closest('[data-act]');
    if (act) { setStatus(card.dataset.id, act.dataset.act); return; }
    const cancel = e.target.closest('[data-cancel]');
    if (cancel) {
      if (cancel.dataset.armed) { setStatus(card.dataset.id, 'cancelled'); return; }
      cancel.dataset.armed = '1';
      cancel.textContent = 'Нажмите ещё раз, чтобы отменить';
      cancel.classList.add('armed');
      setTimeout(() => { if (cancel.isConnected) { delete cancel.dataset.armed; cancel.textContent = 'Отменить заказ'; cancel.classList.remove('armed'); } }, 4000);
    }
  }

  // ---------- Статистика установок приложения ----------

  const PLATFORM = { android: 'Android', ios: 'iPhone', desktop: 'Компьютер', other: 'Другое' };
  const day = (d) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

  async function toggleStats() {
    const btn = document.getElementById('stats-btn');
    const el = document.getElementById('stats');
    const show = el.hidden;
    el.hidden = !show;
    document.getElementById('board').hidden = show;
    document.getElementById('history').hidden = show;
    btn.setAttribute('aria-pressed', String(show));
    btn.textContent = show ? '← Заказы' : 'Статистика';
    if (show) renderStats();
  }

  async function renderStats() {
    const el = document.getElementById('stats');
    el.innerHTML = '<p class="muted">Загружаем…</p>';
    let s;
    try { s = await api.staff.stats(); } catch (e) {
      if (e.status === 401) return showLogin('Сессия истекла, войдите снова.');
      el.innerHTML = '<p class="form-error">Не удалось загрузить статистику.</p>';
      return;
    }
    const tile = (num, label) => `<div class="tile"><b>${num}</b><span>${label}</span></div>`;
    el.innerHTML = `
      <h2>Приложение у гостей</h2>
      <div class="tiles">
        ${tile(s.installs.total, 'установок всего')}
        ${tile(s.installs.d7, 'за 7 дней')}
        ${tile(s.installs.d30, 'за 30 дней')}
        ${tile(s.installs.active30, 'открывали за 30 дней')}
      </div>
      <h2>Заказы за 30 дней</h2>
      <div class="tiles">
        ${tile(s.orders30.app.count, `из приложения · ${money(s.orders30.app.sum)}`)}
        ${tile(s.orders30.web.count, `с сайта · ${money(s.orders30.web.sum)}`)}
      </div>
      <h2>Установки</h2>
      ${s.list.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Установлено</th><th>Устройство</th><th>Запусков</th><th>Заказов</th><th>Последний заказ</th><th>Клиент</th></tr></thead>
        <tbody>${s.list.map((i) => `<tr>
          <td>${day(i.created_at)}</td>
          <td>${PLATFORM[i.platform] || 'Другое'}</td>
          <td class="num-cell">${i.launches}</td>
          <td class="num-cell">${i.orders}</td>
          <td>${i.last_order_at ? day(i.last_order_at) : '—'}</td>
          <td>${i.phone ? `${i.name ? `${esc(i.name)} · ` : ''}<a href="tel:${esc(i.phone)}">${esc(prettyPhone(i.phone))}</a>` : '<span class="muted">ещё не заказывал</span>'}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<p class="empty">Пока никто не установил приложение.</p>'}
      <p class="muted small">Телефон берётся из последнего заказа, сделанного из приложения. Через 30 дней после заказа телефон стирается вместе с заказом (152-ФЗ).</p>
      <button type="button" class="btn ghost" id="stats-refresh">Обновить</button>`;
    document.getElementById('stats-refresh').addEventListener('click', renderStats);
  }

  async function start() {
    app.innerHTML = `
      <header class="topbar">
        <h1>Заказы</h1>
        <span id="conn" class="conn">Подключаемся…</span>
        <span class="spacer"></span>
        <button type="button" id="stats-btn" class="btn ghost" aria-pressed="false">Статистика</button>
        <button type="button" id="sound-btn" class="btn ghost"></button>
        <button type="button" id="logout-btn" class="btn ghost">Выйти</button>
      </header>
      <p id="alert" class="alert" role="alert" hidden></p>
      <main id="board" class="board"></main>
      <details id="history" class="history"></details>
      <section id="stats" class="stats" hidden></section>`;
    document.getElementById('stats-btn').addEventListener('click', toggleStats);
    document.getElementById('board').addEventListener('click', onBoardClick);
    document.getElementById('history').addEventListener('click', onBoardClick);
    document.getElementById('sound-btn').addEventListener('click', () => {
      if (soundOn && !audioReady()) { unlockAudio(); beep(); }
      else { soundOn = !soundOn; pref.set(PREF_SOUND, soundOn ? 'on' : 'off'); if (soundOn) beep(); }
      if (soundOn && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().then(enablePush);
      keepAwake();
      renderSoundBtn();
    });
    document.getElementById('logout-btn').addEventListener('click', () => api.staff.logout().finally(() => showLogin()));
    renderSoundBtn();
    keepAwake();
    enablePush();
    firstLoad = true;
    await load();
    startLive();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && document.getElementById('board')) { keepAwake(); load(); }
  });

  api.staff.me().then((me) => (me ? start() : showLogin())).catch(() => showLogin('Нет связи с сервером.'));
})();
