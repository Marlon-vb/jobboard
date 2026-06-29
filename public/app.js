// Frontend logic for the DEI Europe job board.
// State lives in `filters`; every change re-queries /api/jobs.

const state = {
  q: '',
  sort: 'newest',
  country: '',
  seniority: '',
  remote: '',
  source: ''
};

const els = {
  search: document.getElementById('search'),
  sort: document.getElementById('sort'),
  list: document.getElementById('job-list'),
  count: document.getElementById('results-count'),
  empty: document.getElementById('empty'),
  pills: document.getElementById('active-pills'),
  status: document.getElementById('data-status'),
  refresh: document.getElementById('refresh-btn'),
  toast: document.getElementById('toast')
};

const FACETS = [
  { key: 'remote', el: document.getElementById('facet-remote'), metaKey: 'remoteTypes' },
  { key: 'seniority', el: document.getElementById('facet-seniority'), metaKey: 'seniorities' },
  { key: 'country', el: document.getElementById('facet-country'), metaKey: 'countries' },
  { key: 'source', el: document.getElementById('facet-source'), metaKey: 'sourceFacets' }
];

const esc = (s) =>
  (s ?? '').toString().replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 4200);
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
  for (const [k, v] of Object.entries(state)) if (v) p.set(k, v);
  return p.toString();
}

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
  const active = Object.entries(state).filter(([k, v]) => v && k !== 'sort' && k !== 'q');
  if (state.q) active.unshift(['q', `“${state.q}”`]);
  els.pills.innerHTML = active
    .map(([k, v]) => `<span class="pill" data-clear="${k}">${esc(v)}</span>`)
    .join('');
}

function jobCard(j) {
  const tags = (j.tags || []).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  return `
    <article class="job-card">
      <div class="job-top">
        <div>
          <h3 class="job-title">${esc(j.title)}</h3>
          <span class="job-company">${esc(j.company)}</span>
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
        <a class="btn apply" href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">View &amp; apply →</a>
      </div>
    </article>`;
}

async function loadJobs() {
  els.list.setAttribute('aria-busy', 'true');
  const data = await fetch(`/api/jobs?${queryString()}`).then((r) => r.json());
  els.count.innerHTML = `<strong>${data.matched}</strong> of ${data.total} roles`;
  els.list.innerHTML = data.jobs.map(jobCard).join('');
  els.empty.classList.toggle('hidden', data.jobs.length > 0);
  renderPills();
  els.list.removeAttribute('aria-busy');
}

function setFilter(key, value) {
  state[key] = state[key] === value ? '' : value; // toggle
  loadMeta();
  loadJobs();
}

function clearAll() {
  Object.assign(state, { q: '', country: '', seniority: '', remote: '', source: '' });
  els.search.value = '';
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

document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) return setFilter(chip.dataset.key, chip.dataset.value);
  const pill = e.target.closest('.pill');
  if (pill) {
    state[pill.dataset.clear] = '';
    if (pill.dataset.clear === 'q') els.search.value = '';
    loadMeta();
    return loadJobs();
  }
});

document.getElementById('clear-filters').addEventListener('click', clearAll);
document.getElementById('empty-clear').addEventListener('click', clearAll);

els.refresh.addEventListener('click', async () => {
  els.refresh.disabled = true;
  els.refresh.textContent = '⟳ Refreshing…';
  toast('Pulling fresh listings from live job APIs… this can take a moment.');
  try {
    const res = await fetch('/api/refresh', { method: 'POST' }).then((r) => r.json());
    if (res.ok) {
      toast('Live data refreshed.');
    } else {
      toast('Refresh ran but live sources were unreachable — showing existing data.');
    }
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
