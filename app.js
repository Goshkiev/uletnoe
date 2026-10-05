// Меню рендерится из menu.json. Чтобы поменять блюда или цены, правьте только menu.json.
(function () {
  const menuEl = document.getElementById('menu');
  const tabsEl = document.getElementById('tabs');
  const footerEl = document.getElementById('footer');
  const sheetEl = document.getElementById('sheet');
  const sheetBody = document.getElementById('sheet-body');

  // Категории без фото и описаний показываются компактным списком.
  const COMPACT = new Set(['extras', 'sauces', 'drinks']);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let cur = '₽';
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const money = (n) => `${n} ${cur}`;
  const items = new Map();

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
      <div class="row" id="item-${esc(item.id)}">
        <div class="row-text"><span class="name">${esc(item.name)}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</div>
        <span class="amount">${amount}</span>
      </div>`;
  }

  // Карточка блюда во всплывающем окне, как в приложениях доставки.
  let lastFocus = null;
  function openSheet(id) {
    const item = items.get(id);
    if (!item) return;
    lastFocus = document.activeElement;
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
        <div class="sheet-price">${money(v.price)}</div>`;
      sheetBody.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { sel = +b.dataset.v; draw(); sheetBody.querySelector(`[data-v="${sel}"]`).focus(); }));
    };
    draw();
    sheetEl.hidden = false;
    document.body.classList.add('locked');
    requestAnimationFrame(() => sheetEl.classList.add('open'));
    sheetEl.querySelector('.sheet-close').focus();
  }
  function closeSheet() {
    sheetEl.classList.remove('open');
    document.body.classList.remove('locked');
    setTimeout(() => { sheetEl.hidden = true; }, 200);
    if (lastFocus) lastFocus.focus({ preventScroll: true });
  }
  sheetEl.addEventListener('click', (e) => { if (e.target === sheetEl || e.target.closest('.sheet-close')) closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheetEl.hidden) closeSheet(); });
  menuEl.addEventListener('click', (e) => { const c = e.target.closest('[data-item]'); if (c) openSheet(c.dataset.item); });

  function render(data) {
    cur = (data.cafe && data.cafe.currency) || cur;
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

    const cafe = data.cafe || {};
    const tel = cafe.phone ? `<a href="tel:${esc(cafe.phone.replace(/[^\d+]/g, ''))}">${esc(cafe.phone)}</a>` : '';
    footerEl.innerHTML = [
      cafe.name && `<p><b>${esc(cafe.name)}</b></p>`,
      cafe.address && `<p>${esc(cafe.address)}</p>`,
      cafe.hours && `<p>${esc(cafe.hours)}</p>`,
      tel && `<p>${tel}</p>`,
      cafe.note && `<p>${esc(cafe.note)}</p>`,
    ].filter(Boolean).join('');

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
