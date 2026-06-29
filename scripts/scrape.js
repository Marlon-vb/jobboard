#!/usr/bin/env node
// Live scraper for remote-friendly DEI roles in Europe.
//
// Pulls from several FREE, public job APIs, normalizes them into one schema,
// filters for (DEI role) AND (Europe or worldwide-remote), dedupes, and writes
// the result to data/jobs.json.
//
// Usage:
//   node scripts/scrape.js                 # scrape live sources, merge with seed
//   node scripts/scrape.js --fresh         # scrape live sources only (ignore seed)
//   node scripts/scrape.js --source remotive,jobicy
//
// Note on networks: these APIs are reachable from a normal machine. Some
// sandboxes / corporate proxies block them — if a source fails, the scraper
// logs it and keeps going with whatever else succeeded (plus the seed data),
// so the board is never empty.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isDeiRole,
  isEuropeOrRemote,
  normalizeCountry,
  guessSeniority,
  classifyRemote
} from '../lib/filters.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const OUT_FILE = join(DATA_DIR, 'jobs.json');
const SEED_FILE = join(DATA_DIR, 'seed.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 DEI-Europe-JobBoard/1.0';

const argv = process.argv.slice(2);
const FRESH = argv.includes('--fresh');
const sourceArg = argv.find((a) => a.startsWith('--source'));
const ONLY = sourceArg
  ? (sourceArg.includes('=') ? sourceArg.split('=')[1] : argv[argv.indexOf(sourceArg) + 1] || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  : null;

async function getJson(url, { timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function stableId(source, raw) {
  const base = `${source}:${raw}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (Math.imul(31, h) + base.charCodeAt(i)) | 0;
  return `${source}-${(h >>> 0).toString(36)}`;
}

function decodeEntities(s = '') {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');
}

function clean(html = '') {
  // Decode entities first so escaped tags (e.g. Greenhouse's &lt;p&gt;) become
  // real tags and get stripped too.
  return decodeEntities(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const titleCase = (s = '') => s.charAt(0).toUpperCase() + s.slice(1);

// ---- Source adapters -------------------------------------------------------
// Each returns an array of jobs in the *raw-but-normalized* shape. Filtering
// happens later in one place.

async function fromRemotive() {
  // Remotive: open API, remote-only. We search across a few DEI terms.
  const queries = ['diversity', 'inclusion', 'equity', 'belonging'];
  const out = [];
  for (const q of queries) {
    const data = await getJson(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=50`);
    for (const j of data.jobs || []) {
      out.push({
        source: 'remotive',
        rawId: j.id,
        title: j.title,
        company: j.company_name,
        location: j.candidate_required_location || 'Remote',
        category: j.category,
        tags: j.tags || [],
        url: j.url,
        posted: j.publication_date,
        salary: j.salary || '',
        remoteFlag: true,
        description: clean(j.description || '')
      });
    }
  }
  return out;
}

async function fromJobicy() {
  // Jobicy: open, CORS-enabled remote jobs API.
  const data = await getJson('https://jobicy.com/api/v2/remote-jobs?count=100');
  return (data.jobs || []).map((j) => ({
    source: 'jobicy',
    rawId: j.id,
    title: j.jobTitle,
    company: j.companyName,
    location: j.jobGeo || 'Remote',
    category: Array.isArray(j.jobIndustry) ? j.jobIndustry.join(', ') : j.jobIndustry || '',
    tags: [].concat(j.jobType || [], j.jobLevel || []),
    url: j.url,
    posted: j.pubDate,
    salary: j.annualSalaryMin ? `${j.annualSalaryMin}-${j.annualSalaryMax} ${j.salaryCurrency || ''}` : '',
    remoteFlag: true,
    description: clean(j.jobExcerpt || j.jobDescription || '')
  }));
}

async function fromArbeitnow() {
  // Arbeitnow: European job board, open API, paginated.
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const data = await getJson(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
    for (const j of data.data || []) {
      out.push({
        source: 'arbeitnow',
        rawId: j.slug,
        title: j.title,
        company: j.company_name,
        location: j.location || 'Europe',
        category: (j.job_types || []).join(', '),
        tags: j.tags || [],
        url: j.url,
        posted: j.created_at ? new Date(j.created_at * 1000).toISOString() : '',
        salary: '',
        remoteFlag: !!j.remote,
        description: clean(j.description || '')
      });
    }
  }
  return out;
}

async function fromRemoteOk() {
  // RemoteOK: open API; first element is metadata.
  const data = await getJson('https://remoteok.com/api');
  const rows = Array.isArray(data) ? data.filter((r) => r && r.id) : [];
  return rows.map((j) => ({
    source: 'remoteok',
    rawId: j.id,
    title: j.position || j.title,
    company: j.company,
    location: j.location || 'Remote',
    category: (j.tags || []).join(', '),
    tags: j.tags || [],
    url: j.url,
    posted: j.date,
    salary: j.salary_min ? `${j.salary_min}-${j.salary_max} USD` : '',
    remoteFlag: true,
    description: clean(j.description || '')
  }));
}

async function fromTheMuse() {
  // The Muse: open API (no key). Focus on the HR/Recruiting category to raise
  // the DEI hit-rate; the shared filter still does the final DEI check.
  const out = [];
  for (let page = 0; page < 3; page++) {
    const url = `https://www.themuse.com/api/public/jobs?page=${page}&category=${encodeURIComponent(
      'Human Resources and Recruiting'
    )}`;
    const data = await getJson(url);
    for (const j of data.results || []) {
      const loc = (j.locations || []).map((l) => l.name).join(', ');
      out.push({
        source: 'themuse',
        rawId: j.id,
        title: j.name,
        company: j.company?.name,
        location: loc || 'Flexible',
        category: (j.categories || []).map((c) => c.name).join(', '),
        tags: (j.levels || []).map((l) => l.name),
        url: j.refs?.landing_page,
        posted: j.publication_date,
        salary: '',
        remoteFlag: /flexible|remote/i.test(loc),
        description: clean(j.contents || '')
      });
    }
  }
  return out;
}

async function fromHimalayas() {
  // Himalayas: open remote-jobs API (no key). All roles are remote.
  const data = await getJson('https://himalayas.app/jobs/api?limit=100');
  return (data.jobs || []).map((j) => ({
    source: 'himalayas',
    rawId: j.guid || `${j.companyName}-${j.title}`,
    title: j.title,
    company: j.companyName,
    location: (j.locationRestrictions || []).join(', ') || 'Remote — Worldwide',
    category: (j.categories || []).join(', '),
    tags: [].concat(j.seniority || [], j.categories || []),
    url: j.applicationLink || j.guid,
    posted: typeof j.pubDate === 'number' ? new Date(j.pubDate * 1000).toISOString() : j.pubDate || '',
    salary: j.minSalary ? `${j.minSalary}-${j.maxSalary || j.minSalary}` : '',
    remoteFlag: true,
    description: clean(j.excerpt || j.description || '')
  }));
}

async function fromGreenhouse() {
  // Per-company Greenhouse boards (no key). Opt-in via GREENHOUSE_BOARDS, e.g.
  // GREENHOUSE_BOARDS=elastic,mongodb,gitlab — comma-separated board tokens.
  const boards = (process.env.GREENHOUSE_BOARDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const token of boards) {
    const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
    for (const j of data.jobs || []) {
      out.push({
        source: 'greenhouse',
        rawId: `${token}-${j.id}`,
        title: j.title,
        company: titleCase(token),
        location: j.location?.name || 'See listing',
        category: '',
        tags: (j.metadata || []).map((m) => m.value).filter((v) => typeof v === 'string'),
        url: j.absolute_url,
        posted: j.updated_at,
        salary: '',
        remoteFlag: /remote/i.test(j.location?.name || ''),
        description: clean(j.content || '')
      });
    }
  }
  return out;
}

async function fromLever() {
  // Per-company Lever boards (no key). Opt-in via LEVER_BOARDS, e.g.
  // LEVER_BOARDS=netflix,plaid — comma-separated company handles.
  const boards = (process.env.LEVER_BOARDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const token of boards) {
    const data = await getJson(`https://api.lever.co/v0/postings/${token}?mode=json`);
    for (const j of Array.isArray(data) ? data : []) {
      out.push({
        source: 'lever',
        rawId: j.id,
        title: j.text,
        company: titleCase(token),
        location: j.categories?.location || 'See listing',
        category: j.categories?.team || '',
        tags: [j.categories?.commitment, j.categories?.department].filter(Boolean),
        url: j.hostedUrl,
        posted: j.createdAt ? new Date(j.createdAt).toISOString() : '',
        salary: '',
        remoteFlag: /remote/i.test(j.categories?.location || ''),
        description: clean(j.descriptionPlain || j.description || '')
      });
    }
  }
  return out;
}

async function fromAdzuna() {
  // Adzuna: real, country-specific European search. Free tier needs an app id
  // + key (https://developer.adzuna.com). Opt-in via env vars. Queries each
  // European country endpoint for "diversity inclusion".
  const id = process.env.ADZUNA_APP_ID;
  const key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) throw new Error('set ADZUNA_APP_ID and ADZUNA_APP_KEY to enable Adzuna');
  const countries = (process.env.ADZUNA_COUNTRIES || 'gb,de,fr,nl,es,it,ie,at,pl')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const c of countries) {
    const url =
      `https://api.adzuna.com/v1/api/jobs/${c}/search/1?app_id=${id}&app_key=${key}` +
      `&what=${encodeURIComponent('diversity inclusion')}&results_per_page=50&content-type=application/json`;
    const data = await getJson(url);
    for (const j of data.results || []) {
      out.push({
        source: 'adzuna',
        rawId: j.id,
        title: j.title,
        company: j.company?.display_name,
        location: j.location?.display_name || c.toUpperCase(),
        category: j.category?.label || '',
        tags: [c.toUpperCase()],
        url: j.redirect_url,
        posted: j.created,
        salary: j.salary_min ? `${Math.round(j.salary_min)}-${Math.round(j.salary_max || j.salary_min)}` : '',
        remoteFlag: /remote/i.test(`${j.title} ${j.description || ''}`),
        description: clean(j.description || '')
      });
    }
  }
  return out;
}

// Registry. `default` controls whether a source runs on a plain `npm run scrape`.
// Keyed sources stay off unless their env vars are present, so default runs
// don't spam 404s/auth errors. `--source a,b` overrides and runs exactly those.
const SOURCES = {
  remotive: { fn: fromRemotive, default: true },
  jobicy: { fn: fromJobicy, default: true },
  arbeitnow: { fn: fromArbeitnow, default: true },
  remoteok: { fn: fromRemoteOk, default: true },
  themuse: { fn: fromTheMuse, default: true },
  himalayas: { fn: fromHimalayas, default: true },
  greenhouse: { fn: fromGreenhouse, default: !!process.env.GREENHOUSE_BOARDS },
  lever: { fn: fromLever, default: !!process.env.LEVER_BOARDS },
  adzuna: { fn: fromAdzuna, default: !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) }
};

// ---- Orchestration ---------------------------------------------------------

function toRecord(raw) {
  return {
    id: stableId(raw.source, raw.rawId),
    title: (raw.title || '').trim(),
    company: (raw.company || 'Unknown').trim(),
    location: (raw.location || 'Remote').trim(),
    country: normalizeCountry(raw.location || ''),
    remote: classifyRemote(raw.location || '', raw.remoteFlag),
    seniority: guessSeniority(raw.title || ''),
    category: (raw.category || '').trim(),
    tags: (Array.isArray(raw.tags) ? raw.tags : []).slice(0, 10),
    salary: raw.salary || '',
    url: raw.url,
    source: raw.source,
    posted: raw.posted || '',
    description: (raw.description || '').slice(0, 600)
  };
}

async function loadSeed() {
  try {
    const txt = await readFile(SEED_FILE, 'utf8');
    return JSON.parse(txt);
  } catch {
    return [];
  }
}

async function main() {
  const chosen = Object.keys(SOURCES).filter((s) => (ONLY ? ONLY.includes(s) : SOURCES[s].default));
  console.log(`▶ Scraping DEI / Europe / remote roles from: ${chosen.join(', ')}`);

  const settled = await Promise.allSettled(chosen.map((s) => SOURCES[s].fn()));
  const rawJobs = [];
  settled.forEach((res, i) => {
    const name = chosen[i];
    if (res.status === 'fulfilled') {
      console.log(`  ✓ ${name}: ${res.value.length} raw postings`);
      rawJobs.push(...res.value);
    } else {
      console.warn(`  ✗ ${name}: ${res.reason?.message || res.reason} (skipped)`);
    }
  });

  const filtered = rawJobs
    .filter((j) => j.title && j.url)
    .filter((j) => isDeiRole(j))
    .filter((j) => isEuropeOrRemote(j.location, `${j.title} ${(j.tags || []).join(' ')}`))
    .map(toRecord);

  // Merge with seed unless --fresh, then dedupe by url (fallback id).
  const seed = FRESH ? [] : await loadSeed();
  const merged = [...seed, ...filtered];
  const seen = new Set();
  const deduped = [];
  for (const j of merged) {
    const key = (j.url || j.id || '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(j);
  }

  // Sort newest-first when we have dates, otherwise leave seed order.
  deduped.sort((a, b) => (b.posted || '').localeCompare(a.posted || ''));

  await mkdir(DATA_DIR, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    count: deduped.length,
    sources: chosen,
    jobs: deduped
  };
  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2));
  console.log(`✔ Wrote ${deduped.length} jobs to ${OUT_FILE}`);
  if (filtered.length === 0) {
    console.log(
      '  (No live results this run — likely a blocked network. The board will ' +
        'serve the curated seed data instead.)'
    );
  }
}

main().catch((err) => {
  console.error('Scrape failed:', err);
  process.exit(1);
});
