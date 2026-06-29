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

function clean(html = '') {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

const SOURCES = {
  remotive: fromRemotive,
  jobicy: fromJobicy,
  arbeitnow: fromArbeitnow,
  remoteok: fromRemoteOk
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
  const chosen = Object.keys(SOURCES).filter((s) => !ONLY || ONLY.includes(s));
  console.log(`▶ Scraping DEI / Europe / remote roles from: ${chosen.join(', ')}`);

  const settled = await Promise.allSettled(chosen.map((s) => SOURCES[s]()));
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
