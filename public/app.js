// Car Radar frontend. No build step, no framework.

const $ = (id) => document.getElementById(id);
const el = {
  topbar: $('topbar'), logo: $('logo'), pageTitle: $('pageTitle'),
  searchForm: $('searchForm'), searchInput: $('searchInput'), searchBtn: $('searchBtn'),
  sourcesBtn: $('sourcesBtn'), themeBtn: $('themeBtn'),
  brandChips: $('brandChips'), labelFilter: $('labelFilter'), rangeSelect: $('rangeSelect'),
  feedView: $('feedView'), feed: $('feed'), feedStatus: $('feedStatus'), sentinel: $('sentinel'),
  sourcesView: $('sourcesView'), sourcesBody: $('sourcesBody'),
  rangeLabel: $('rangeLabel'),
  newBanner: $('newBanner'), newBannerText: $('newBannerText'), ptr: $('ptr'), toast: $('toast'),
};

// ─── Storage (always wrapped: private mode can throw) ───────────────────────
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('cr.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('cr.' + key, JSON.stringify(value));
    } catch {}
  },
};

// ─── State ──────────────────────────────────────────────────────────────────
const RANGES = { today: null, '3d': 3, '7d': 7, '14d': 14 };
const RANGE_SHORT = { today: 'Today', '3d': '3d', '7d': '7d', '14d': '14d' };
const state = {
  config: null,
  brandMap: new Map(),
  brands: store.get('brands', []),
  label: store.get('label', 'ALL'),
  range: store.get('range', '7d'),
  q: '',
  items: [],
  ids: new Set(),
  cursor: null,
  done: false,
  loading: false,
  req: 0,
  route: 'feed',
};
if (!(state.range in RANGES)) state.range = '7d';

// Seen articles, for the NEW dot. id → time first seen.
const seen = store.get('seen', {});
let firstVisit = store.get('firstVisit', null);
(function pruneSeen() {
  const cutoff = Date.now() - 16 * 864e5;
  for (const [id, t] of Object.entries(seen)) if (t < cutoff) delete seen[id];
})();
let saveSeenTimer = null;
function markSeen(id) {
  if (seen[id]) return;
  seen[id] = Date.now();
  clearTimeout(saveSeenTimer);
  saveSeenTimer = setTimeout(() => store.set('seen', seen), 500);
}
const isNew = (item) => firstVisit != null && item.insertedAt > firstVisit && !seen[item.id];

// ─── Helpers ────────────────────────────────────────────────────────────────
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeHref = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');
const slug = (s) => String(s).replace(/[^a-z0-9-]/gi, '');

function timeAgo(ts) {
  const sec = Math.max(0, (Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
function timeUntil(ts) {
  const min = Math.round((ts - Date.now()) / 60000);
  return min <= 0 ? 'any moment' : `in ${min} min`;
}

function fromTimestamp() {
  if (state.range === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return Date.now() - RANGES[state.range] * 864e5;
}

function filterParams(extra = {}) {
  const p = new URLSearchParams();
  if (state.brands.length) p.set('brands', state.brands.join(','));
  if (state.label !== 'ALL') p.set('label', state.label);
  p.set('from', String(fromTimestamp()));
  if (state.q) p.set('q', state.q);
  for (const [k, v] of Object.entries(extra)) if (v != null) p.set(k, String(v));
  return p.toString();
}

async function api(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 3200);
}

const ICON = {
  OFFICIAL: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.4 1.8 3 .1.9 2.9 2.3 1.9-1 2.8 1 2.8-2.3 1.9-.9 2.9-3 .1L12 21l-2.4-1.8-3-.1-.9-2.9-2.3-1.9 1-2.8-1-2.8 2.3-1.9.9-2.9 3-.1z"/><path d="m8.5 12 2.4 2.4 4.6-4.8"/></svg>',
  CONFIRMED: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.7 2.7L16 9.6"/></svg>',
  RUMOR: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.7"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
};
const LABEL_NAME = { OFFICIAL: 'Official', CONFIRMED: 'Confirmed', RUMOR: 'Rumor' };

// ─── Theme ──────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#F2F3F5' : '#0A0B0E';
  el.themeBtn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
}
applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
el.themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  store.set('theme', next);
});

// Keep --header-h in sync so the banner and pull indicator sit just under the header.
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--header-h', `${el.topbar.getBoundingClientRect().height}px`);
}).observe(el.topbar);

// ─── Filters ────────────────────────────────────────────────────────────────
function renderBrandStyles() {
  const css = state.config.brands
    .filter((b) => /^#[0-9a-f]{3,8}$/i.test(b.color))
    .map((b) => `.b-${slug(b.id)}{--brand:${b.color}}`)
    .join('');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
}

function renderChips() {
  const all = state.brands.length === 0;
  el.brandChips.innerHTML =
    `<button type="button" class="chip all" data-brand="" aria-pressed="${all}">All brands</button>` +
    state.config.brands
      .map(
        (b) =>
          `<button type="button" class="chip b-${slug(b.id)}" data-brand="${esc(b.id)}" aria-pressed="${state.brands.includes(b.id)}"><i class="dot"></i>${esc(b.name)}</button>`,
      )
      .join('');
}

function renderLabelFilter() {
  for (const btn of el.labelFilter.querySelectorAll('button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.label === state.label));
  }
}

function filtersChanged() {
  store.set('brands', state.brands);
  store.set('label', state.label);
  store.set('range', state.range);
  window.scrollTo({ top: 0 });
  loadFeed({ reset: true });
}

el.brandChips.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const id = chip.dataset.brand;
  if (!id) state.brands = [];
  else if (state.brands.includes(id)) state.brands = state.brands.filter((b) => b !== id);
  else state.brands = [...state.brands, id];
  if (state.brands.length === state.config.brands.length) state.brands = [];
  renderChips();
  filtersChanged();
});

el.labelFilter.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.dataset.label === state.label) return;
  state.label = btn.dataset.label;
  renderLabelFilter();
  filtersChanged();
});

function renderRange() {
  el.rangeSelect.value = state.range;
  el.rangeLabel.textContent = RANGE_SHORT[state.range];
}
renderRange();
el.rangeSelect.addEventListener('change', () => {
  state.range = el.rangeSelect.value;
  renderRange();
  filtersChanged();
});

// Search
function openSearch(open) {
  el.searchForm.hidden = !open;
  el.topbar.classList.toggle('searching', open);
  el.searchBtn.setAttribute('aria-expanded', String(open));
  el.searchBtn.setAttribute('aria-label', open ? 'Close search' : 'Search');
  if (open) el.searchInput.focus();
  else if (state.q) {
    el.searchInput.value = '';
    state.q = '';
    loadFeed({ reset: true });
  }
}
el.searchBtn.addEventListener('click', () => openSearch(el.searchForm.hidden));
let searchTimer = null;
el.searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = el.searchInput.value.trim();
    if (q === state.q) return;
    state.q = q;
    window.scrollTo({ top: 0 });
    loadFeed({ reset: true });
  }, 300);
});
el.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') openSearch(false);
});
el.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  el.searchInput.blur();
});

// ─── Cards ──────────────────────────────────────────────────────────────────
function brandTag(id) {
  const b = state.brandMap.get(id);
  return b ? `<span class="brand-tag b-${slug(id)}">${esc(b.name)}</span>` : '';
}

function thumb(item) {
  const first = state.brandMap.get(item.brands[0]);
  const cls = first ? `b-${slug(first.id)}` : '';
  const img = /^https?:\/\//i.test(item.image || '')
    ? `<img src="${esc(item.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : '';
  return `<div class="thumb ${cls}"><span>${esc(first?.name || '')}</span>${img}</div>`;
}

function cardHtml(item, index) {
  const label = LABEL_NAME[item.label] ? item.label : 'CONFIRMED';
  const lc = label.toLowerCase();
  const via = item.via ? `<span class="via">via ${esc(item.via)}</span>` : '';
  const related = item.related?.length
    ? `<div class="related">
        <button type="button" class="related-toggle" aria-expanded="false">Also reported by ${item.related.length} ${item.related.length === 1 ? 'source' : 'sources'}${ICON.chevron}</button>
        <ul class="related-list" hidden>${item.related
          .map(
            (r) => `<li><a href="${safeHref(r.url)}" target="_blank" rel="noopener noreferrer">
              <span class="r-top"><b>${esc(r.publisher)}</b><span data-ts="${r.publishedAt}">${timeAgo(r.publishedAt)}</span>
              <span class="mini-label ${esc((r.label || '').toLowerCase())}">${esc(LABEL_NAME[r.label] || '')}</span></span>
              <span class="r-title">${esc(r.title)}</span></a></li>`,
          )
          .join('')}</ul>
      </div>`
    : '';
  return `<article class="card" data-id="${esc(item.id)}" style="--i:${index}">
    <div class="card-top">
      <span class="badge ${lc}">${ICON[label]}${LABEL_NAME[label]}</span>
      ${isNew(item) ? '<span class="new-dot">NEW</span>' : ''}
    </div>
    <p class="reason">${esc(item.reason)}</p>
    <a class="card-link" href="${safeHref(item.url)}" target="_blank" rel="noopener noreferrer">
      <h2 class="headline">${esc(item.title)}</h2>
      ${thumb(item)}
    </a>
    ${item.summary ? `<p class="summary">${esc(item.summary)}</p>` : ''}
    <div class="meta">
      ${item.brands.map(brandTag).join('')}
      <span class="src"><b>${esc(item.publisher)}</b>· <span data-ts="${item.publishedAt}">${timeAgo(item.publishedAt)}</span>${via}</span>
    </div>
    ${related}
  </article>`;
}

function skeletonHtml(n = 4) {
  return Array.from(
    { length: n },
    () => `<div class="card skeleton" aria-hidden="true">
      <div class="sk sk-badge"></div>
      <div class="sk sk-line" style="width:55%"></div>
      <div class="sk-head"><div class="lines">
        <div class="sk sk-line" style="height:17px"></div><div class="sk sk-line" style="height:17px;width:85%"></div><div class="sk sk-line" style="height:17px;width:60%"></div>
      </div><div class="sk sk-thumb"></div></div>
      <div class="sk sk-line"></div><div class="sk sk-line" style="width:70%"></div>
    </div>`,
  ).join('');
}

// Images: fade in when loaded, fall back to the brand block on error.
el.feed.addEventListener('load', (e) => e.target.tagName === 'IMG' && e.target.classList.add('loaded'), true);
el.feed.addEventListener('error', (e) => e.target.tagName === 'IMG' && e.target.remove(), true);

el.feed.addEventListener('click', (e) => {
  const toggle = e.target.closest('.related-toggle');
  if (!toggle) return;
  const open = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(open));
  toggle.nextElementSibling.hidden = !open;
});

// A card counts as seen after it has been on screen for a second.
const seenTimers = new Map();
const seenObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const id = entry.target.dataset.id;
      if (entry.isIntersecting) {
        seenTimers.set(id, setTimeout(() => {
          markSeen(id);
          seenObserver.unobserve(entry.target);
        }, 1000));
      } else {
        clearTimeout(seenTimers.get(id));
      }
    }
  },
  { threshold: 0.6 },
);

function appendItems(items) {
  const start = state.items.length;
  const fresh = items.filter((it) => !state.ids.has(it.id));
  for (const it of fresh) state.ids.add(it.id);
  state.items.push(...fresh);
  const html = fresh.map((it, i) => cardHtml(it, start === 0 ? i : i % 6)).join('');
  el.feed.insertAdjacentHTML('beforeend', html);
  for (const it of fresh) {
    if (isNew(it)) seenObserver.observe(el.feed.querySelector(`[data-id="${CSS.escape(it.id)}"]`));
  }
}

// ─── Feed loading ───────────────────────────────────────────────────────────
function renderStatus() {
  if (state.loading && state.items.length) {
    el.feedStatus.innerHTML = '<div class="spinner" aria-label="Loading"></div>';
  } else if (!state.loading && state.done && state.items.length) {
    el.feedStatus.textContent = `That's everything from the last ${state.range === 'today' ? 'day' : RANGES[state.range] + ' days'}.`;
  } else {
    el.feedStatus.textContent = '';
  }
}

function renderEmpty() {
  const filtered = state.brands.length || state.label !== 'ALL' || state.q || state.range !== '14d';
  el.feed.innerHTML = filtered
    ? `<div class="empty"><h2>Nothing here yet</h2><p>No stories match these filters. Try a longer time range or more brands.</p>
        <button class="btn" type="button" id="clearFilters">Show everything</button></div>`
    : `<div class="empty"><h2>No articles yet</h2><p>The server checks all sources every few minutes. The first check can take a minute after startup.</p>
        <a class="btn" href="#/sources" style="display:inline-grid;place-items:center">See sources</a></div>`;
  $('clearFilters')?.addEventListener('click', () => {
    state.brands = [];
    state.label = 'ALL';
    state.range = '14d';
    state.q = '';
    el.searchInput.value = '';
    renderRange();
    renderChips();
    renderLabelFilter();
    filtersChanged();
  });
}

function hideBanner() {
  el.newBanner.hidden = true;
}

/**
 * reset: start over from the top.
 * quiet: keep current cards on screen until the new page arrives (banner, pull-to-refresh).
 */
async function loadFeed({ reset = false, quiet = false } = {}) {
  if (reset) {
    state.req++;
    state.cursor = null;
    state.done = false;
    state.loading = false;
    hideBanner();
    if (!quiet) {
      state.items = [];
      state.ids = new Set();
      el.feed.innerHTML = skeletonHtml();
    }
  }
  if (state.loading || state.done) return;
  const req = state.req;
  state.loading = true;
  renderStatus();
  try {
    const data = await api(`/api/articles?${filterParams({ cursor: state.cursor, limit: 20 })}`);
    if (req !== state.req) return;
    if (firstVisit == null) {
      firstVisit = data.serverTime;
      store.set('firstVisit', firstVisit);
    }
    if (reset) {
      state.items = [];
      state.ids = new Set();
      el.feed.innerHTML = '';
    }
    appendItems(data.items);
    state.cursor = data.nextCursor;
    state.done = !data.nextCursor;
    if (!state.items.length) renderEmpty();
  } catch (err) {
    if (req !== state.req) return;
    if (!state.items.length) {
      el.feed.innerHTML = `<div class="empty"><h2>Couldn't load the feed</h2><p>Check your connection and try again.</p>
        <button class="btn" type="button" id="retryBtn">Try again</button></div>`;
      $('retryBtn').addEventListener('click', () => loadFeed({ reset: true }));
    } else {
      toast("Couldn't load more articles");
    }
  } finally {
    if (req === state.req) {
      state.loading = false;
      renderStatus();
    }
  }
}

new IntersectionObserver(
  (entries) => {
    if (entries[0].isIntersecting && state.route === 'feed' && state.items.length) loadFeed();
  },
  { rootMargin: '800px 0px' },
).observe(el.sentinel);

// ─── Auto refresh + "N new articles" banner ─────────────────────────────────
async function checkForNew() {
  if (document.hidden || state.route !== 'feed' || state.loading) return;
  try {
    if (!state.items.length) {
      // Empty feed: just reload quietly in case articles have arrived.
      if (state.done) await loadFeed({ reset: true, quiet: true });
      return;
    }
    const top = Math.max(...state.items.map((i) => i.publishedAt));
    const { count } = await api(`/api/articles/newer?${filterParams({ since: top })}`);
    if (count > 0) {
      el.newBannerText.textContent = `${count} new ${count === 1 ? 'article' : 'articles'}`;
      el.newBanner.hidden = false;
    }
  } catch {
    // Offline or server restarting; try again next tick.
  }
}

el.newBanner.addEventListener('click', async () => {
  hideBanner();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  await loadFeed({ reset: true, quiet: true });
});

// ─── Pull to refresh ────────────────────────────────────────────────────────
(function pullToRefresh() {
  const THRESHOLD = 70;
  let startY = null;
  let dist = 0;
  let busy = false;

  const setPull = (d) => {
    const p = Math.min(d / THRESHOLD, 1);
    el.ptr.style.opacity = String(p);
    el.ptr.style.transform = `translateY(${Math.min(d, THRESHOLD + 20)}px) rotate(${d * 3}deg)`;
    el.ptr.classList.toggle('ready', d >= THRESHOLD);
  };
  const reset = () => {
    el.ptr.classList.add('settle');
    el.ptr.classList.remove('ready', 'refreshing');
    el.ptr.style.opacity = '0';
    el.ptr.style.transform = 'translateY(0)';
    setTimeout(() => el.ptr.classList.remove('settle'), 260);
  };

  window.addEventListener('touchstart', (e) => {
    if (busy || window.scrollY > 0 || e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    dist = 0;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) {
      if (dist) setPull(0);
      dist = 0;
      return;
    }
    dist = dy * 0.5; // resistance
    setPull(dist);
  }, { passive: true });

  window.addEventListener('touchend', async () => {
    if (startY == null) return;
    startY = null;
    if (dist < THRESHOLD) {
      reset();
      return;
    }
    busy = true;
    el.ptr.classList.add('settle', 'refreshing');
    el.ptr.style.transform = `translateY(${THRESHOLD}px)`;
    try {
      if (state.route === 'sources') await loadSources();
      else await loadFeed({ reset: true, quiet: true });
    } finally {
      busy = false;
      reset();
    }
  });
})();

// ─── Sources page ───────────────────────────────────────────────────────────
const TYPE_TITLE = { official: 'Official newsrooms', outlet: 'News outlets', aggregator: 'Google News searches' };

async function loadSources() {
  if (!el.sourcesBody.children.length) el.sourcesBody.innerHTML = '<div class="feed-status"><div class="spinner"></div></div>';
  try {
    const d = await api('/api/sources');
    const ok = d.sources.filter((s) => s.lastSuccessAt && !s.lastError).length;
    const failing = d.sources.filter((s) => s.lastError).length;
    const last = d.lastCycle;
    const aiNote = d.ai.enabled
      ? `Labels come from Claude (${esc(d.ai.model)}). If a call fails, the keyword rules take over.`
      : 'Labels come from keyword rules. Set ANTHROPIC_API_KEY on the server to have Claude label articles instead.';

    const groups = ['official', 'outlet', 'aggregator']
      .map((type) => {
        const list = d.sources.filter((s) => s.type === type);
        if (!list.length) return '';
        return `<h2 class="group-title">${TYPE_TITLE[type]}</h2><div class="source-list">${list.map(sourceHtml).join('')}</div>`;
      })
      .join('');

    el.sourcesBody.innerHTML = `
      <div class="status-card">
        <div class="stat-grid">
          <div class="stat"><small>Last check</small><b>${last ? `<span data-ts="${last.finishedAt}">${timeAgo(last.finishedAt)}</span>` : 'Not yet'}</b></div>
          <div class="stat"><small>Next check</small><b>${d.running ? 'Running now' : d.nextCycleAt ? timeUntil(d.nextCycleAt) : '–'}</b></div>
          <div class="stat"><small>Sources working</small><b>${ok} of ${d.sources.length}${failing ? ` · ${failing} failing` : ''}</b></div>
          <div class="stat"><small>Stories stored</small><b>${d.counts?.stories ?? 0}</b></div>
        </div>
        <p class="ai-note">${aiNote}</p>
      </div>
      ${groups}`;
  } catch {
    el.sourcesBody.innerHTML = `<div class="empty"><h2>Couldn't load sources</h2><p>Check your connection and try again.</p></div>`;
  }
}

function sourceHtml(s) {
  const status = s.lastError ? 'fail' : s.lastSuccessAt ? 'ok' : '';
  const updated = s.lastSuccessAt
    ? `Updated <span data-ts="${s.lastSuccessAt}">${timeAgo(s.lastSuccessAt)}</span>`
    : s.lastAttemptAt
      ? 'Never updated successfully'
      : 'Not checked yet';
  const counts = s.itemCount != null ? ` · ${s.itemCount} in feed, ${s.newCount ?? 0} new` : '';
  return `<div class="source">
    <span class="status ${status}" aria-label="${status === 'ok' ? 'Working' : status === 'fail' ? 'Failing' : 'Unknown'}"></span>
    <div class="name">${esc(s.name)}${s.brands.map(brandTag).join('')}</div>
    <div class="line">${updated}${counts}${s.via && s.type !== 'aggregator' ? ` · via ${esc(s.via)}` : ''}</div>
    ${s.lastError ? `<div class="err">Last attempt failed: ${esc(s.lastError)}</div>` : ''}
  </div>`;
}

// ─── Routing ────────────────────────────────────────────────────────────────
let sourcesTimer = null;
function route() {
  const sources = location.hash === '#/sources';
  state.route = sources ? 'sources' : 'feed';
  document.body.classList.toggle('view-sources', sources);
  el.feedView.hidden = sources;
  el.sourcesView.hidden = !sources;
  el.pageTitle.hidden = !sources;
  el.sourcesBtn.setAttribute('aria-current', sources ? 'page' : 'false');
  el.logo.setAttribute('aria-label', sources ? 'Back to feed' : 'Car Radar');
  document.title = sources ? 'Sources · Car Radar' : 'Car Radar';
  clearInterval(sourcesTimer);
  if (sources) {
    if (!el.searchForm.hidden) openSearch(false);
    hideBanner();
    window.scrollTo({ top: 0 });
    loadSources();
    sourcesTimer = setInterval(() => !document.hidden && loadSources(), 30_000);
  }
}
window.addEventListener('hashchange', route);

// ─── Boot ───────────────────────────────────────────────────────────────────
setInterval(() => {
  for (const node of document.querySelectorAll('[data-ts]')) node.textContent = timeAgo(Number(node.dataset.ts));
}, 60_000);

async function boot() {
  el.feed.innerHTML = skeletonHtml();
  try {
    state.config = await api('/api/config');
  } catch {
    el.feed.innerHTML = `<div class="empty"><h2>Can't reach Car Radar</h2><p>The server isn't responding. Check your connection and try again.</p>
      <button class="btn" type="button" id="bootRetry">Try again</button></div>`;
    $('bootRetry').addEventListener('click', boot);
    return;
  }
  state.brandMap = new Map(state.config.brands.map((b) => [b.id, b]));
  state.brands = state.brands.filter((id) => state.brandMap.has(id));
  renderBrandStyles();
  renderChips();
  renderLabelFilter();
  route();
  await loadFeed({ reset: true });

  const pollMs = Math.max(15, state.config.clientPollSeconds || 120) * 1000;
  setInterval(checkForNew, pollMs);
  document.addEventListener('visibilitychange', () => !document.hidden && checkForNew());
  window.addEventListener('online', checkForNew);
}
boot();
