// Frontend logic for the DEI Europe job board.
//   - Server-side search/filter/sort via /api/jobs
//   - Client-side tabs (Open vs Archive) driven by a "reviewed" set in
//     localStorage, so checking a role off survives reloads.
//   - A slide-in detail drawer with full role info + apply + archive.

const state = {
  q: '',
  sort: 'newest',
  country: '',
  seniority: '',
  remote: '',
  source: '',
  tab: 'open'
};

const REVIEW_KEY = 'dei.reviewed.v1';
const reviewed = new Set(JSON.parse(localStorage.getItem(REVIEW_KEY) || '[]'));
const saveReviewed = () => localStorage.setItem(REVIEW_KEY, JSON.stringify([...reviewed]));

const FAV_KEY = 'dei.favorites.v1';
const favorites = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]'));
const saveFavorites = () => localStorage.setItem(FAV_KEY, JSON.stringify([...favorites]));

// Cache of the jobs currently rendered, by id, so the drawer has full data.
let jobIndex = new Map();

const $ = (id) => document.getElementById(id);
const els = {
  search: $('search'),
  sort: $('sort'),
  list: $('job-list'),
  count: $('results-count'),
  empty: $('empty'),
  pills: $('active-pills'),
  status: $('data-status'),
  refresh: $('refresh-btn'),
  toast: $('toast'),
  countOpen: $('count-open'),
  countFavorites: $('count-favorites'),
  countArchive: $('count-archive'),
  overlay: $('overlay'),
  drawer: $('drawer'),
  themeToggle: $('theme-toggle')
};

const FACETS = [
  { key: 'remote', el: $('facet-remote'), metaKey: 'remoteTypes' },
  { key: 'seniority', el: $('facet-seniority'), metaKey: 'seniorities' },
  { key: 'country', el: $('facet-country'), metaKey: 'countries' },
  { key: 'source', el: $('facet-source'), metaKey: 'sourceFacets' }
];

const esc = (s) =>
  (s ?? '').toString().replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 4000);
}

function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function queryString() {
  const p = new URLSearchParams();
  for (const k of ['q', 'sort', 'country', 'seniority', 'remote', 'source']) if (state[k]) p.set(k, state[k]);
  return p.toString();
}

// ---- Facets + pills ----
async function loadMeta() {
  const meta = await fetch('/api/meta').then((r) => r.json());
  els.status.textContent = meta.generatedAt
    ? `${meta.total} roles · updated ${timeAgo(meta.generatedAt)}`
    : `${meta.total} curated roles`;
  for (const f of FACETS) renderFacet(f, meta[f.metaKey] || []);
}

function renderFacet(facet, values) {
  facet.el.innerHTML = values
    .map(
      (v) =>
        `<button class="chip ${state[facet.key] === v.value ? 'active' : ''}" data-key="${facet.key}" data-value="${esc(
          v.value
        )}">${esc(v.value)}<span class="count">${v.count}</span></button>`
    )
    .join('');
}

function renderPills() {
  const active = [];
  if (state.q) active.push(['q', `“${state.q}”`]);
  for (const k of ['remote', 'seniority', 'country', 'source']) if (state[k]) active.push([k, state[k]]);
  els.pills.innerHTML = active.map(([k, v]) => `<span class="pill" data-clear="${k}">${esc(v)}</span>`).join('');
}

// ---- Cards ----
function jobCard(j) {
  const isRev = reviewed.has(j.id);
  const isFav = favorites.has(j.id);
  const tags = (j.tags || []).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const toggleLabel = state.tab === 'archive' ? '↺ Restore' : isRev ? '✓ Reviewed' : '○ Mark reviewed';
  return `
    <article class="job-card ${isRev ? 'reviewed' : ''} ${isFav ? 'favorite' : ''}" data-id="${esc(j.id)}">
      <div class="job-top">
        <div>
          <h3 class="job-title">${esc(j.title)}</h3>
          <span class="job-company">${esc(j.company)}</span>
        </div>
        <div class="card-actions">
          <button class="icon-toggle ${isFav ? 'on' : ''}" data-fav="${esc(j.id)}" title="${
            isFav ? 'Remove from favorites' : 'Save to favorites'
          }" aria-label="Favorite">${isFav ? '★' : '☆'}</button>
          <button class="review-toggle ${isRev ? 'on' : ''}" data-review="${esc(j.id)}">${toggleLabel}</button>
        </div>
      </div>
      <div class="job-meta">
        <span class="tag remote">📍 ${esc(j.location)}</span>
        <span class="tag remote">${esc(j.remote)}</span>
        <span class="tag seniority">${esc(j.seniority)}</span>
        ${j.salary ? `<span class="tag">💶 ${esc(j.salary)}</span>` : ''}
        ${tags}
      </div>
      ${j.description ? `<p class="job-desc">${esc(j.description)}</p>` : ''}
      <div class="job-bottom">
        <span class="job-source">${esc(j.source)}${j.posted ? ` · ${timeAgo(j.posted)}` : ''}</span>
        <div class="row">
          <span class="ghost-link">Details →</span>
          <a class="btn apply" href="${esc(j.url)}" target="_blank" rel="noopener noreferrer" data-stop>Apply ↗</a>
        </div>
      </div>
    </article>`;
}

async function loadJobs() {
  const data = await fetch(`/api/jobs?${queryString()}`).then((r) => r.json());
  jobIndex = new Map(data.jobs.map((j) => [j.id, j]));

  const open = data.jobs.filter((j) => !reviewed.has(j.id));
  const archived = data.jobs.filter((j) => reviewed.has(j.id));
  const favs = data.jobs.filter((j) => favorites.has(j.id));
  els.countOpen.textContent = open.length;
  els.countArchive.textContent = archived.length;
  els.countFavorites.textContent = favs.length;

  const byTab = { open, archive: archived, favorites: favs };
  const noun = { open: 'open', archive: 'archived', favorites: 'favorited' }[state.tab];
  const shown = byTab[state.tab] || open;
  els.count.innerHTML = `<strong>${shown.length}</strong> ${noun} · ${data.total} total`;
  els.list.innerHTML = shown.map(jobCard).join('');

  if (shown.length === 0) {
    const emptyMsg = {
      archive: `<div class="big">🗂️</div><p>No archived roles yet. Mark roles as reviewed and they’ll land here.</p>`,
      favorites: `<div class="big">★</div><p>No favorites yet. Tap the star on a role to save it here.</p>`,
      open: `<div class="big">🔍</div><p>No open roles match these filters.</p><button class="btn" id="empty-clear">Clear filters</button>`
    };
    els.empty.classList.remove('hidden');
    els.empty.innerHTML = emptyMsg[state.tab] || emptyMsg.open;
    const ec = $('empty-clear');
    if (ec) ec.addEventListener('click', clearAll);
  } else {
    els.empty.classList.add('hidden');
  }
  renderPills();
}

// ---- Detail drawer ----
function openDrawer(id) {
  const j = jobIndex.get(id);
  if (!j) return;
  $('drawer-title').textContent = j.title;
  $('drawer-company').textContent = j.company;
  $('drawer-apply').href = j.url;

  const specs = [
    ['Location', j.location],
    ['Work style', j.remote],
    ['Seniority', j.seniority],
    ['Source', j.source],
    j.salary ? ['Salary', j.salary] : null,
    j.posted ? ['Posted', timeAgo(j.posted)] : null,
    j.category ? ['Category', j.category] : null,
    ['Country', j.country]
  ].filter(Boolean);
  $('drawer-specs').innerHTML = specs
    .map(([k, v]) => `<div class="spec"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`)
    .join('');

  const tags = j.tags || [];
  $('drawer-highlights-wrap').style.display = tags.length ? '' : 'none';
  $('drawer-highlights').innerHTML = tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('');

  $('drawer-desc').textContent =
    j.description || 'Full description is on the listing — open “View & apply” to read the requirements and apply.';

  updateArchiveBtn(id);
  updateFavBtn(id);
  els.overlay.classList.remove('hidden');
  els.drawer.classList.add('show');
  els.drawer.dataset.id = id;
  requestAnimationFrame(() => els.overlay.classList.add('show'));
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  els.drawer.classList.remove('show');
  els.overlay.classList.remove('show');
  setTimeout(() => els.overlay.classList.add('hidden'), 250);
  document.body.style.overflow = '';
}

function updateArchiveBtn(id) {
  const btn = $('drawer-archive');
  btn.textContent = reviewed.has(id) ? '↺ Restore to open' : '✓ Mark reviewed & archive';
}

function updateFavBtn(id) {
  const btn = $('drawer-fav');
  const on = favorites.has(id);
  btn.textContent = on ? '★' : '☆';
  btn.classList.toggle('on', on);
  btn.title = on ? 'Remove from favorites' : 'Save to favorites';
}

function toggleFavorite(id) {
  if (favorites.has(id)) {
    favorites.delete(id);
    toast('Removed from favorites.');
  } else {
    favorites.add(id);
    toast('★ Saved to favorites.');
  }
  saveFavorites();
  if (els.drawer.dataset.id === id) updateFavBtn(id);
  loadJobs();
}

// ---- Reviewed / archive ----
function toggleReviewed(id) {
  if (reviewed.has(id)) {
    reviewed.delete(id);
    toast('Moved back to open roles.');
  } else {
    reviewed.add(id);
    toast('Archived — nice, one less to check.');
  }
  saveReviewed();
  updateArchiveBtn(id);
  loadJobs();
}

// ---- State changes ----
function clearAll() {
  Object.assign(state, { q: '', country: '', seniority: '', remote: '', source: '' });
  els.search.value = '';
  loadMeta();
  loadJobs();
}

function setFilter(key, value) {
  state[key] = state[key] === value ? '' : value;
  loadMeta();
  loadJobs();
}

// ---- Events ----
let debounce;
els.search.addEventListener('input', (e) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    state.q = e.target.value;
    loadJobs();
  }, 220);
});

els.sort.addEventListener('change', (e) => {
  state.sort = e.target.value;
  loadJobs();
});

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    state.tab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    loadJobs();
  })
);

// Delegated clicks on the results area.
els.list.addEventListener('click', (e) => {
  const favBtn = e.target.closest('[data-fav]');
  if (favBtn) {
    e.stopPropagation();
    return toggleFavorite(favBtn.dataset.fav);
  }
  const reviewBtn = e.target.closest('[data-review]');
  if (reviewBtn) {
    e.stopPropagation();
    return toggleReviewed(reviewBtn.dataset.review);
  }
  if (e.target.closest('[data-stop]')) return; // let the apply link work
  const card = e.target.closest('.job-card');
  if (card) openDrawer(card.dataset.id);
});

// Filter chips + pills (anywhere in the sidebar/results head).
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip:not(.tag)');
  if (chip && chip.dataset.key) return setFilter(chip.dataset.key, chip.dataset.value);
  const pill = e.target.closest('.pill');
  if (pill) {
    state[pill.dataset.clear] = '';
    if (pill.dataset.clear === 'q') els.search.value = '';
    loadMeta();
    return loadJobs();
  }
});

$('clear-filters').addEventListener('click', clearAll);
$('drawer-close').addEventListener('click', closeDrawer);
els.overlay.addEventListener('click', closeDrawer);
$('drawer-archive').addEventListener('click', () => toggleReviewed(els.drawer.dataset.id));
$('drawer-fav').addEventListener('click', () => toggleFavorite(els.drawer.dataset.id));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

// Theme toggle
function syncThemeIcon() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  els.themeToggle.textContent = light ? '☀️' : '🌙';
  els.themeToggle.title = light ? 'Switch to dark' : 'Switch to light';
}
els.themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('dei.theme', next);
  syncThemeIcon();
});
syncThemeIcon();

els.refresh.addEventListener('click', async () => {
  els.refresh.disabled = true;
  els.refresh.textContent = '⟳ Refreshing…';
  toast('Pulling fresh listings from live job APIs…');
  try {
    const res = await fetch('/api/refresh', { method: 'POST' }).then((r) => r.json());
    toast(res.ok ? 'Live data refreshed.' : 'Refresh ran but live sources were unreachable — showing existing data.');
  } catch {
    toast('Could not reach the server to refresh.');
  } finally {
    els.refresh.disabled = false;
    els.refresh.textContent = '⟳ Refresh live data';
    await loadMeta();
    await loadJobs();
  }
});

// ---- Init ----
loadMeta();
loadJobs();
