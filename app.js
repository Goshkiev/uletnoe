// Меню рендерится из menu.json. Чтобы поменять блюда или цены, правьте только menu.json.
// Корзина и заказы включаются, когда в config.js заполнены настройки Supabase.
(function () {
  const menuEl = document.getElementById('menu');
  const tabsEl = document.getElementById('tabs');
  const footerEl = document.getElementById('footer');
  const sheetEl = document.getElementById('sheet');
  const sheetBody = document.getElementById('sheet-body');
  const barEl = document.getElementById('cart-bar');

  // Категории без фото и описаний показываются компактным списком.
  const COMPACT = new Set(['extras', 'sauces', 'drinks']);
  const CART_KEY = 'uletnoe.cart.v1';
  const ORDER_KEY = 'uletnoe.order.v1';

  const cfg = window.ULETNOE_CONFIG || {};
  const db = cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: false } })
    : null;
  const ordering = !!db;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  let cur = '₽';
  const money = (n) => `${n.toLocaleString('ru-RU')} ${cur}`;
  const items = new Map();
  let cafe = {};

  const store = {
    get(key, fallback) {
      try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
    },
    set(key, value) {
      try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* приватный режим */ }
    },
  };

  function priceLabel(item) {
    if (item.variants) {
      const prices = item.variants.map((v) => v.price);
      const min = Math.min(...prices);
      return prices.some((p) => p !== min) ? `от ${money(min)}` : money(min);
    }
    return money(item.price);
  }

  function card(item) {
    const sub = (item.desc && cap(item.desc)) || (item.variants ? item.variants.map((v) => v.label).join(' / ') : item.weight) || '';
    return `
      <button type="button" class="card${item.img ? '' : ' no-photo'}" data-item="${esc(item.id)}" id="item-${esc(item.id)}">
        ${item.img ? `<span class="photo"><img src="${esc(item.img)}" alt="" loading="lazy"></span>` : ''}
        <span class="info">
          <span class="name">${esc(item.name)}</span>
          ${sub ? `<span class="desc">${esc(sub)}</span>` : ''}
          <span class="price-btn">${priceLabel(item)}</span>
        </span>
      </button>`;
  }

  function row(item) {
    const sub = [item.weight, item.desc].filter(Boolean).map(esc).join(' · ');
    const amount = item.variants
      ? item.variants.map((v) => `${esc(v.label)} — ${money(v.price)}`).join('<br>')
      : money(item.price);
    return `
      <button type="button" class="row" data-item="${esc(item.id)}" id="item-${esc(item.id)}">
        <span class="row-text"><span class="name">${esc(item.name)}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</span>
        <span class="amount">${amount}</span>
      </button>`;
  }

  // ---------- Всплывающее окно (карточка блюда, корзина, статус заказа) ----------

  let lastFocus = null;
  let onSheetClose = null;
  function showSheet(render, onClose) {
    if (sheetEl.hidden) lastFocus = document.activeElement;
    if (onSheetClose) onSheetClose();
    onSheetClose = onClose || null;
    render();
    sheetEl.hidden = false;
    document.body.classList.add('locked');
    requestAnimationFrame(() => sheetEl.classList.add('open'));
    sheetEl.querySelector('.sheet-panel').scrollTop = 0;
    sheetEl.querySelector('.sheet-close').focus({ preventScroll: true });
  }
  function closeSheet() {
    if (sheetEl.hidden) return;
    if (onSheetClose) { onSheetClose(); onSheetClose = null; }
    sheetEl.classList.remove('open');
    document.body.classList.remove('locked');
    setTimeout(() => { if (!sheetEl.classList.contains('open')) sheetEl.hidden = true; }, 200);
    if (lastFocus) lastFocus.focus({ preventScroll: true });
  }
  sheetEl.addEventListener('click', (e) => { if (e.target === sheetEl || e.target.closest('.sheet-close')) closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  function openItem(id) {
    const item = items.get(id);
    if (!item) return;
    let sel = 0;
    const draw = () => {
      const v = item.variants ? item.variants[sel] : item;
      const weight = item.variants ? v.label : item.weight;
      const n = v.nutrition || item.nutrition;
      sheetBody.innerHTML = `
        ${item.img ? `<div class="sheet-photo"><img src="${esc(item.img)}" alt="${esc(item.name)}"></div>` : ''}
        <h3 id="sheet-title" class="sheet-name">${esc(item.name)}</h3>
        ${weight ? `<p class="sheet-weight">${esc(weight)}</p>` : ''}
        ${item.desc ? `<p class="sheet-desc">${esc(cap(item.desc))}</p>` : ''}
        ${item.variants && item.variants.length > 1 ? `
          <div class="segmented" role="radiogroup" aria-label="Размер порции">
            ${item.variants.map((x, i) => `<button type="button" role="radio" aria-checked="${i === sel}" data-v="${i}">${esc(x.label)}</button>`).join('')}
          </div>` : ''}
        ${n ? `
          <dl class="kbju">
            <div><dt>Белки</dt><dd>${n[0]} г</dd></div>
            <div><dt>Жиры</dt><dd>${n[1]} г</dd></div>
            <div><dt>Углеводы</dt><dd>${n[2]} г</dd></div>
            <div><dt>Ккал</dt><dd>${n[3]}</dd></div>
          </dl>` : ''}
        ${ordering
          ? `<button type="button" class="sheet-price action" data-add>В корзину за ${money(v.price)}</button>`
          : `<div class="sheet-price">${money(v.price)}</div>`}`;
      sheetBody.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => {
        sel = +b.dataset.v; draw(); sheetBody.querySelector(`[data-v="${sel}"]`).focus();
      }));
      const add = sheetBody.querySelector('[data-add]');
      if (add) add.addEventListener('click', () => {
        addToCart(item.id, item.variants ? v.label : null);
        add.textContent = 'Добавлено ✓';
        add.disabled = true;
        setTimeout(closeSheet, 450);
      });
    };
    showSheet(draw);
  }

  menuEl.addEventListener('click', (e) => { const c = e.target.closest('[data-item]'); if (c) openItem(c.dataset.item); });

  // ---------- Корзина ----------

  let cart = store.get(CART_KEY, []);
  const lineKey = (id, variant) => `${id}|${variant || ''}`;

  function resolve(line) {
    const item = items.get(line.id);
    if (!item) return null;
    if (item.variants) {
      const v = item.variants.find((x) => x.label === line.variant);
      return v ? { item, price: v.price } : null;
    }
    return line.variant ? null : { item, price: item.price };
  }
  function cartLines() {
    return cart.map((l) => ({ ...l, ...resolve(l) })).filter((l) => l.item);
  }
  function cartTotals() {
    const lines = cartLines();
    return { lines, count: lines.reduce((s, l) => s + l.qty, 0), sum: lines.reduce((s, l) => s + l.qty * l.price, 0) };
  }
  function saveCart() { store.set(CART_KEY, cart); renderBar(); }
  function addToCart(id, variant) {
    const key = lineKey(id, variant);
    const line = cart.find((l) => lineKey(l.id, l.variant) === key);
    if (line) line.qty = Math.min(20, line.qty + 1); else cart.push({ id, variant, qty: 1 });
    saveCart();
    barEl.classList.remove('bump'); void barEl.offsetWidth; barEl.classList.add('bump');
  }
  function changeQty(key, delta) {
    const line = cart.find((l) => lineKey(l.id, l.variant) === key);
    if (!line) return;
    line.qty = Math.min(20, line.qty + delta);
    if (line.qty <= 0) cart = cart.filter((l) => l !== line);
    saveCart();
  }

  // ---------- Нижняя панель: корзина или статус заказа ----------

  const STATUS = {
    new: { text: 'Принят, скоро начнём готовить', short: 'Принят' },
    cooking: { text: 'Готовится', short: 'Готовится' },
    ready: { text: 'Готов! Можно забирать', short: 'Готов' },
    done: { text: 'Выдан. Приятного аппетита!', short: 'Выдан' },
    cancelled: { text: 'Отменён. Если это ошибка, позвоните нам', short: 'Отменён' },
  };
  const ACTIVE = new Set(['new', 'cooking', 'ready']);
  let lastOrder = store.get(ORDER_KEY, null);
  if (lastOrder && Date.now() - lastOrder.at > 12 * 3600e3) { lastOrder = null; store.set(ORDER_KEY, null); }

  function renderBar() {
    if (!ordering) { barEl.hidden = true; return; }
    const { count, sum } = cartTotals();
    if (count) {
      barEl.innerHTML = `<span>Корзина</span><span class="bar-sum">${count} шт · ${money(sum)}</span>`;
      barEl.dataset.mode = 'cart';
      barEl.hidden = false;
    } else if (lastOrder && ACTIVE.has(lastOrder.status || 'new')) {
      barEl.innerHTML = `<span>Заказ №${lastOrder.number}</span><span class="bar-sum">${STATUS[lastOrder.status || 'new'].short}</span>`;
      barEl.dataset.mode = 'order';
      barEl.hidden = false;
    } else {
      barEl.hidden = true;
    }
    document.body.classList.toggle('has-bar', !barEl.hidden);
  }
  barEl.addEventListener('click', () => (barEl.dataset.mode === 'order' ? openOrderStatus() : openCart()));

  // ---------- Оформление ----------

  const form = { name: '', phone: '', when: 'asap', time: '', comment: '' };

  function normalizePhone(raw) {
    let d = String(raw).replace(/\D/g, '');
    if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
    if (d.length === 10 && d[0] === '9') d = '7' + d;
    return d.length >= 10 && d.length <= 15 ? '+' + d : null;
  }
  function pickupDate(time) {
    const [h, m] = time.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }

  function openCart() {
    let error = '';
    let sending = false;
    const draw = () => {
      const { lines, count, sum } = cartTotals();
      if (!count) {
        sheetBody.innerHTML = `
          <h3 id="sheet-title" class="sheet-name">Корзина пуста</h3>
          <p class="sheet-desc">Выберите что-нибудь вкусное в меню.</p>
          <button type="button" class="sheet-price action" data-close>Вернуться в меню</button>`;
        sheetBody.querySelector('[data-close]').addEventListener('click', closeSheet);
        return;
      }
      sheetBody.innerHTML = `
        <h3 id="sheet-title" class="sheet-name">Ваш заказ</h3>
        <ul class="cart-lines">
          ${lines.map((l) => {
            const key = lineKey(l.id, l.variant);
            return `
            <li class="cart-line">
              ${l.item.img ? `<img src="${esc(l.item.img)}" alt="">` : '<span class="cart-dot"></span>'}
              <span class="cart-line-text">
                <span class="cart-line-name">${esc(l.item.name)}</span>
                ${l.variant ? `<span class="cart-line-sub">${esc(l.variant)}</span>` : ''}
                <span class="cart-line-sum">${money(l.price * l.qty)}</span>
              </span>
              <span class="stepper">
                <button type="button" data-qty="-1" data-key="${esc(key)}" aria-label="Убрать одну">−</button>
                <span aria-live="polite">${l.qty}</span>
                <button type="button" data-qty="1" data-key="${esc(key)}" aria-label="Добавить ещё">+</button>
              </span>
            </li>`;
          }).join('')}
        </ul>
        <div class="cart-total"><span>Итого</span><span>${money(sum)}</span></div>

        <form class="checkout" novalidate>
          <label class="field">
            <span>Телефон</span>
            <input id="co-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 900 000-00-00" value="${esc(form.phone)}" required>
          </label>
          <label class="field">
            <span>Имя <small>(необязательно)</small></span>
            <input id="co-name" name="name" type="text" autocomplete="given-name" maxlength="60" value="${esc(form.name)}">
          </label>
          <fieldset class="field">
            <legend>Когда заберёте</legend>
            <div class="segmented" role="radiogroup">
              <button type="button" role="radio" aria-checked="${form.when === 'asap'}" data-when="asap">Как можно скорее</button>
              <button type="button" role="radio" aria-checked="${form.when === 'time'}" data-when="time">Ко времени</button>
            </div>
            ${form.when === 'time' ? `<input id="co-time" name="time" type="time" value="${esc(form.time)}" aria-label="Время самовывоза">` : ''}
          </fieldset>
          <label class="field">
            <span>Комментарий <small>(необязательно)</small></span>
            <textarea id="co-comment" name="comment" rows="2" maxlength="500" placeholder="Например, без лука">${esc(form.comment)}</textarea>
          </label>
          <p class="pay-note">Самовывоз${cafe.address ? `: ${esc(cafe.address)}` : ''}. Оплата на кассе при получении.</p>
          ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
          <button type="submit" class="sheet-price action" ${sending ? 'disabled' : ''}>${sending ? 'Отправляем…' : `Заказать за ${money(sum)}`}</button>
        </form>`;

      sheetBody.querySelectorAll('[data-qty]').forEach((b) => b.addEventListener('click', () => {
        changeQty(b.dataset.key, +b.dataset.qty); draw();
      }));
      const f = sheetBody.querySelector('form');
      f.addEventListener('input', (e) => {
        if (e.target.name in form) form[e.target.name] = e.target.value;
        if (error) { error = ''; const el = f.querySelector('.form-error'); if (el) el.remove(); }
      });
      sheetBody.querySelectorAll('[data-when]').forEach((b) => b.addEventListener('click', () => {
        form.when = b.dataset.when; draw();
        const t = sheetBody.querySelector('#co-time'); if (t) t.focus();
      }));
      f.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    };

    async function submit() {
      if (sending) return;
      const phone = normalizePhone(form.phone);
      if (!phone) { error = 'Укажите номер телефона, чтобы мы могли связаться с вами.'; draw(); sheetBody.querySelector('#co-phone').focus(); return; }
      let pickupAt = null;
      if (form.when === 'time') {
        if (!form.time) { error = 'Выберите время самовывоза.'; draw(); return; }
        const d = pickupDate(form.time);
        if (d < new Date(Date.now() + 10 * 60e3)) { error = 'Выберите время хотя бы на 10 минут позже текущего.'; draw(); return; }
        pickupAt = d.toISOString();
      }
      const { lines } = cartTotals();
      error = ''; sending = true; draw();
      const { data, error: err } = await db.rpc('place_order', {
        p_phone: phone,
        p_items: lines.map((l) => ({ id: l.id, name: l.item.name, variant: l.variant || null, price: l.price, qty: l.qty })),
        p_name: form.name.trim() || null,
        p_pickup_at: pickupAt,
        p_comment: form.comment.trim() || null,
      });
      sending = false;
      if (err || !data) {
        error = err && err.code === '22023' ? err.message : 'Не получилось отправить заказ. Проверьте интернет и попробуйте ещё раз.';
        draw();
        return;
      }
      cart = []; saveCart();
      form.comment = '';
      lastOrder = { id: data.id, number: data.number, total: data.total, status: 'new', pickupAt, at: Date.now() };
      store.set(ORDER_KEY, lastOrder);
      renderBar();
      openOrderStatus();
    }

    showSheet(draw);
  }

  // ---------- Статус заказа ----------

  let pollTimer = null;
  async function refreshOrder() {
    if (!lastOrder || !db) return;
    const { data } = await db.rpc('order_status', { p_id: lastOrder.id });
    if (data && data.status && data.status !== lastOrder.status) {
      lastOrder.status = data.status;
      store.set(ORDER_KEY, lastOrder);
      renderBar();
      if (!sheetEl.hidden && sheetBody.querySelector('[data-order-status]')) drawOrder();
    }
  }
  function drawOrder() {
    const st = STATUS[lastOrder.status] || STATUS.new;
    const when = lastOrder.pickupAt
      ? `к ${new Date(lastOrder.pickupAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
      : 'как можно скорее';
    const steps = ['new', 'cooking', 'ready'];
    const idx = steps.indexOf(lastOrder.status);
    sheetBody.innerHTML = `
      <p class="order-eyebrow">Заказ принят</p>
      <h3 id="sheet-title" class="order-number">№${lastOrder.number}</h3>
      <p class="order-status ${esc(lastOrder.status)}" data-order-status aria-live="polite">${esc(st.text)}</p>
      ${idx >= 0 ? `<ol class="order-steps">${['Принят', 'Готовится', 'Готов'].map((s, i) => `<li class="${i <= idx ? 'on' : ''}">${s}</li>`).join('')}</ol>` : ''}
      <p class="sheet-desc">Назовите номер на кассе. Забрать ${when}${cafe.address ? `, ${esc(cafe.address)}` : ''}.
      Оплата на кассе при получении${lastOrder.total != null ? `: ${money(lastOrder.total)}` : ''}.</p>
      <button type="button" class="sheet-price action" data-close>Понятно</button>`;
    sheetBody.querySelector('[data-close]').addEventListener('click', closeSheet);
  }
  function openOrderStatus() {
    showSheet(drawOrder, () => { clearInterval(pollTimer); pollTimer = null; });
    refreshOrder();
    clearInterval(pollTimer);
    pollTimer = setInterval(refreshOrder, 10000);
  }
  // Пока есть активный заказ, статус обновляется и в фоне, раз в 30 секунд.
  setInterval(() => { if (!pollTimer && lastOrder && ACTIVE.has(lastOrder.status)) refreshOrder(); }, 30000);

  // ---------- Отрисовка меню ----------

  function render(data) {
    cafe = data.cafe || {};
    cur = cafe.currency || cur;
    const cats = data.categories
      .map((c) => ({ ...c, items: c.items.filter((i) => !i.hidden) }))
      .filter((c) => c.items.length);
    cats.forEach((c) => c.items.forEach((i) => items.set(i.id, i)));

    tabsEl.innerHTML = cats.map((c) => `<a href="#${esc(c.id)}" data-id="${esc(c.id)}">${esc(c.title)}</a>`).join('');
    menuEl.innerHTML = cats.map((c) => `
      <section id="${esc(c.id)}">
        <h2>${esc(c.title)}</h2>
        ${c.note ? `<p class="cat-note">${esc(c.note)}</p>` : ''}
        ${COMPACT.has(c.id)
          ? `<div class="list">${c.items.map(row).join('')}</div>`
          : `<div class="grid">${c.items.map(card).join('')}</div>`}
      </section>`).join('');

    const tel = cafe.phone ? `<a href="tel:${esc(cafe.phone.replace(/[^\d+]/g, ''))}">${esc(cafe.phone)}</a>` : '';
    footerEl.innerHTML = [
      cafe.name && `<p><b>${esc(cafe.name)}</b></p>`,
      cafe.address && `<p>${esc(cafe.address)}</p>`,
      cafe.hours && `<p>${esc(cafe.hours)}</p>`,
      tel && `<p>${tel}</p>`,
      cafe.note && `<p>${esc(cafe.note)}</p>`,
    ].filter(Boolean).join('');

    // Убираем из корзины то, чего больше нет в меню.
    cart = cart.filter((l) => resolve(l));
    saveCart();
    if (lastOrder && ACTIVE.has(lastOrder.status)) refreshOrder();
    highlightTabs();
  }

  function highlightTabs() {
    const links = [...tabsEl.querySelectorAll('a')];
    const setActive = (id) => {
      links.forEach((a) => {
        const on = a.dataset.id === id;
        a.classList.toggle('active', on);
        if (on) tabsEl.scrollTo({ left: a.offsetLeft - (tabsEl.clientWidth - a.offsetWidth) / 2, behavior: 'smooth' });
      });
    };
    const obs = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: '-70px 0px -60% 0px' });
    menuEl.querySelectorAll('section').forEach((s) => obs.observe(s));
    if (links[0]) links[0].classList.add('active');
  }

  fetch('menu.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(render)
    .catch(() => { menuEl.innerHTML = '<p class="error">Не удалось загрузить меню. Обновите страницу.</p>'; });
})();
