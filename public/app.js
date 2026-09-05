'use strict';
/* Panel app: Telegram login (magic token / WebApp / Login Widget), month dashboard, CRUD. */
const $ = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem('et_token') || null,
  month: new Date().toISOString().slice(0, 7),
  baseCurrency: 'TJS',
  categories: [],
  limits: [],
  offset: 0,
  q: '',
  editingId: null,
};

function api(path, opts = {}) {
  return fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}`, ...(opts.headers || {}) },
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) { logout(); throw new Error('auth'); }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  });
}

function fmt(n, cur) {
  const cur0 = cur || state.baseCurrency;
  const s = Number.isInteger(Number(n))
    ? Number(n).toLocaleString('ru-RU')
    : Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${s} ${cur0}`;
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
}

function shiftMonth(ym, d) {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(y, m - 1 + d, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

/* ---------- login ---------- */
async function boot() {
  const q = new URLSearchParams(location.search);
  const magic = q.get('token') || q.get('tg_token');
  if (magic) {
    localStorage.setItem('et_token', magic);
    state.token = magic;
    history.replaceState(null, '', location.pathname);
  }
  // Telegram WebApp (opened from bot button / menu).
  try {
    const wa = window.Telegram && window.Telegram.WebApp;
    if (wa && wa.initData) {
      wa.ready();
      if (!state.token) {
        const r = await fetch('/api/auth/webapp', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData: wa.initData }),
        }).then((x) => x.json()).catch(() => null);
        if (r && r.token) { state.token = r.token; localStorage.setItem('et_token', r.token); }
      }
    }
  } catch (_) {}

  if (!state.token) return showLogin();
  try {
    const me = await api('/api/me');
    const cfg = await fetch('/api/config').then((r) => r.json());
    state.baseCurrency = cfg.baseCurrency;
    state.categories = cfg.categories;
    $('me-label').textContent = me.profile.first_name || `@${me.profile.username || ''}` || 'Telegram';
    showApp();
  } catch (_) {
    showLogin();
  }
}

async function showLogin() {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  if (cfg.botUsername) {
    const s = document.createElement('script');
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.async = true;
    s.setAttribute('data-telegram-login', cfg.botUsername);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-onauth', 'onTelegramAuth(user)');
    s.setAttribute('data-request-access', 'write');
    $('tg-login').appendChild(s);
  }
  $('btn-magic').onclick = () => $('magic-hint').classList.toggle('hidden');
  // Dev login probe (only works if server allows).
  try {
    const r = await fetch('/api/auth/dev', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id: 1 }),
    });
    if (r.ok || r.status === 401) { /* endpoint exists */ }
    if (r.status !== 403 && r.status !== 404) {
      $('btn-dev').classList.remove('hidden');
      $('btn-dev').onclick = async () => {
        const d = await fetch('/api/auth/dev', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tg_id: 1, first_name: 'Dev' }),
        }).then((x) => x.json());
        localStorage.setItem('et_token', d.token);
        location.reload();
      };
    }
  } catch (_) {}
}

window.onTelegramAuth = async function (user) {
  try {
    const r = await fetch('/api/auth/telegram', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(user),
    }).then((x) => x.json());
    if (!r.token) throw new Error(r.error || 'login failed');
    localStorage.setItem('et_token', r.token);
    location.reload();
  } catch (e) {
    $('login-err').textContent = 'Не получилось войти: ' + e.message;
  }
};

function logout() {
  localStorage.removeItem('et_token');
  state.token = null;
  if (!$('app').classList.contains('hidden')) location.reload();
}

function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  bind();
  refresh();
}

function bind() {
  $('btn-prev').onclick = () => { state.month = shiftMonth(state.month, -1); refresh(); };
  $('btn-next').onclick = () => { state.month = shiftMonth(state.month, 1); refresh(); };
  $('btn-logout').onclick = logout;
  $('btn-export').onclick = () => {
    const { from, to } = monthBounds(state.month);
    fetch(`/api/export.csv?from=${from}&to=${to}`, { headers: { Authorization: `Bearer ${state.token}` } })
      .then((r) => r.blob())
      .then((b) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = `expenses-${state.month}.csv`;
        a.click();
      });
  };
  $('quick-form').onsubmit = async (e) => {
    e.preventDefault();
    $('quick-err').textContent = '';
    const text = $('quick-input').value.trim();
    if (!text) return;
    try {
      await api('/expenses', { method: 'POST', body: JSON.stringify({ text }) });
      $('quick-input').value = '';
      refresh();
    } catch (err) {
      $('quick-err').textContent = err.message;
    }
  };
  let t;
  $('search').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = e.target.value.trim(); state.offset = 0; loadList(true); }, 300);
  };
  $('btn-more').onclick = () => { state.offset += 30; loadList(false); };
  $('btn-limits').onclick = () => {
    $('limits-form').classList.toggle('hidden');
    renderLimitsEditor();
  };
  $('btn-limits-save').onclick = saveLimits;
}

function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

async function refresh() {
  $('month-label').textContent = monthLabel(state.month);
  const { from, to } = monthBounds(state.month);
  const [sum, byDay, byCat, lims] = await Promise.all([
    api('/api/stats/summary?month=' + state.month),
    api('/api/stats/by-day?month=' + state.month),
    api('/api/stats/by-category?from=' + from + '&to=' + to),
    api('/api/limits'),
  ]);
  state.limits = lims.limits;
  $('t-today').textContent = fmt(sum.today.total, sum.baseCurrency);
  $('t-week').textContent = fmt(sum.week.total, sum.baseCurrency);
  $('t-month').textContent = fmt(sum.month.total, sum.baseCurrency);
  $('t-count').textContent = `${sum.month.count} трат · ${from}…${to}`;
  renderDays(byDay.days);
  renderCats(byCat.categories, sum.month.total);
  state.offset = 0;
  loadList(true);
}

function renderDays(days) {
  const cv = $('chart-days');
  const map = Object.fromEntries(days.map((d) => [d.day, d.total]));
  const { from, to } = monthBounds(state.month);
  const vals = [];
  for (let d = new Date(from); d <= new Date(to); d.setDate(d.getDate() + 1)) {
    const k = d.toISOString().slice(0, 10);
    vals.push({ day: k, total: map[k] || 0 });
  }
  const max = Math.max(1, ...vals.map((v) => v.total));
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || cv.parentElement.clientWidth - 28;
  const H = 140;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.height = H + 'px';
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  const n = vals.length;
  const bw = Math.max(2, (W - 8) / n - 3);
  vals.forEach((v, i) => {
    const h = Math.round(((H - 30) * v.total) / max);
    const x = 4 + i * ((W - 8) / n);
    const y = H - 22 - h;
    const today = new Date().toISOString().slice(0, 10) === v.day;
    g.fillStyle = v.total === 0 ? 'rgba(140,150,170,.25)' : today ? '#4da3ff' : '#37d67a';
    g.beginPath();
    g.roundRect(x, y, bw, Math.max(2, h), 3);
    g.fill();
    if (v.day.endsWith('01') || v.day.endsWith('15') || i === n - 1) {
      g.fillStyle = '#93a0b8';
      g.font = '10px system-ui';
      g.fillText(v.day.slice(8), x - 2, H - 6);
    }
  });
  $('days-empty').classList.toggle('hidden', days.length > 0);
}

function renderCats(cats, monthTotal) {
  const box = $('cats');
  box.innerHTML = '';
  if (cats.length === 0) { box.innerHTML = '<div class="muted">Пока пусто.</div>'; return; }
  const limMap = Object.fromEntries(state.limits.map((l) => [l.category, l.amount_base]));
  for (const c of cats) {
    const pct = monthTotal > 0 ? Math.round((c.total / monthTotal) * 100) : 0;
    const lim = limMap[c.category];
    const over = lim != null && c.total > lim;
    const near = lim != null && !over && c.total > lim * 0.8;
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.innerHTML =
      `<div class="cat-top"><span>${c.emoji} ${c.label}</span><span>${fmt(c.total, state.baseCurrency)}</span></div>` +
      `<div class="bar${over ? ' over' : ''}"><i style="width:${Math.min(100, pct)}%"></i></div>` +
      `<div class="lim${over ? ' over' : ''}">${pct}% месяца` +
      (lim != null ? ` · лимит ${fmt(lim, state.baseCurrency)}${over ? ' — превышен!' : near ? ' — почти исчерпан' : ''}` : '') +
      `</div>`;
    box.appendChild(row);
  }
}

async function loadList(reset) {
  const { from, to } = monthBounds(state.month);
  const p = new URLSearchParams({ from, to, limit: 30, offset: state.offset });
  if (state.q) p.set('q', state.q);
  const d = await api('/api/expenses?' + p.toString());
  if (reset) $('list').innerHTML = '';
  if (reset && d.items.length === 0) $('list').innerHTML = '<div class="muted">Нет трат за этот период.</div>';
  for (const e of d.items) {
    const div = document.createElement('div');
    div.className = 'exp';
    div.innerHTML =
      `<div><div class="d">${escapeHtml(e.description)}</div>` +
      `<div class="m">${catEmoji(e.category)} ${escapeHtml(e.categoryLabel)} · ${e.day} · #${e.id}</div>` +
      `<div class="acts"><button class="link" data-edit="${e.id}">Изменить</button>` +
      `<button class="link del" data-del="${e.id}">Удалить</button></div></div>` +
      `<div class="amt">${fmt(e.amount, e.currency)}</div>`;
    $('list').appendChild(div);
  }
  $('btn-more').classList.toggle('hidden', !(state.offset + 30 < d.total));
  $('list').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => delExpense(Number(b.dataset.del))));
  $('list').querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openModal(Number(b.dataset.edit))));
}

function catEmoji(id) {
  const c = state.categories.find((x) => x.id === id);
  return c ? c.emoji : '📦';
}

async function delExpense(id) {
  if (!confirm(`Удалить трату #${id}?`)) return;
  await api('/expenses/' + id, { method: 'DELETE' });
  refresh();
}

async function openModal(id) {
  const { from, to } = monthBounds(state.month);
  const d = await api(`/api/expenses?from=${from}&to=${to}&limit=200`);
  const e = d.items.find((x) => x.id === id) || (await api('/api/expenses?limit=200')).items.find((x) => x.id === id);
  if (!e) return alert('Не нашёл трату');
  state.editingId = id;
  $('m-text').value = `${e.description} ${e.amount}`;
  $('m-cat').innerHTML = state.categories.map((c) => `<option value="${c.id}">${c.emoji} ${c.label}</option>`).join('');
  $('m-cat').value = e.category;
  $('m-day').value = e.day;
  $('m-err').textContent = '';
  $('modal').classList.remove('hidden');
  $('m-cancel').onclick = () => $('modal').classList.add('hidden');
  $('m-save').onclick = async () => {
    try {
      await api('/expenses/' + id, {
        method: 'PATCH',
        body: JSON.stringify({ text: $('m-text').value, category: $('m-cat').value, day: $('m-day').value || undefined }),
      }).catch(async () => {
        // Fallback: structured update if parser rejects combined text.
        await api('/expenses/' + id, {
          method: 'PATCH',
          body: JSON.stringify({ description: $('m-text').value, category: $('m-cat').value, day: $('m-day').value || undefined }),
        });
      });
      $('modal').classList.add('hidden');
      refresh();
    } catch (err) {
      $('m-err').textContent = err.message;
    }
  };
}

function renderLimitsEditor() {
  const box = $('limits-rows');
  box.innerHTML = '';
  const limMap = Object.fromEntries(state.limits.map((l) => [l.category, l.amount_base]));
  for (const c of state.categories) {
    if (c.id === 'other') continue;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span style="min-width:110px">${c.emoji} ${c.label}</span>`;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.min = '0'; inp.placeholder = '—';
    inp.value = limMap[c.id] ?? '';
    inp.dataset.cat = c.id;
    row.appendChild(inp);
    box.appendChild(row);
  }
}

async function saveLimits() {
  const items = [...document.querySelectorAll('#limits-rows input')].map((i) => ({
    category: i.dataset.cat,
    amount: i.value === '' ? null : Number(i.value),
  }));
  await api('/limits', { method: 'PUT', body: JSON.stringify({ limits: items }) });
  $('limits-form').classList.add('hidden');
  refresh();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot();
