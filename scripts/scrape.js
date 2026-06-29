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
import { loadEnv } from '../lib/env.js';

// Load .env before anything reads process.env (the SOURCES registry below uses
// it to decide which keyed sources are enabled).
loadEnv();

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

async function postJson(url, body, { timeout = 240000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${txt ? ` — ${txt.slice(0, 160)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Treat the .env.example placeholders ("your_..._here") as unset, so a freshly
// copied .env doesn't enable a source and then fail with a confusing 401.
function realEnv(name) {
  const v = process.env[name];
  if (!v || /^your_.*_here$/i.test(v) || /_here$/i.test(v)) return '';
  return v;
}

// Return the first present, non-empty value among several candidate keys —
// lets one mapping work across Apify actors that name fields differently.
function pickField(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function stableId(source, raw) {
  const base = `${source}:${raw}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (Math.imul(31, h) + base.charCodeAt(i)) | 0;
  return `${source}-${(h >>> 0).toString(36)}`;
}

// Approximate FX rates to EUR (updated periodically; good enough for comparison).
const FX_TO_EUR = {
  EUR: 1, GBP: 1.17, CHF: 1.05, PLN: 0.23, SEK: 0.088, NOK: 0.086,
  DKK: 0.134, USD: 0.92, CAD: 0.68, AUD: 0.61
};

// Format a salary range as an approximate EUR figure, e.g. "€45k–€60k".
// Returns '' for unknown currencies or implausible (hourly/tiny) numbers, so we
// never show a misleading €. Non-EUR amounts are prefixed with "≈".
function formatEurSalary(min, max, currency) {
  const lo0 = Number(min) || 0;
  const hi0 = Number(max) || 0;
  if (!lo0 && !hi0) return '';
  const cur = String(currency || 'EUR').toUpperCase();
  const rate = FX_TO_EUR[cur];
  if (!rate) return '';
  const lo = (lo0 || hi0) * rate;
  const hi = (hi0 || lo0) * rate;
  if (hi < 5000) return ''; // looks hourly/monthly or junk — skip rather than mislead
  const k = (n) => `€${Math.round(n / 1000)}k`;
  const approx = cur === 'EUR' ? '' : '≈';
  return Math.round(lo / 1000) !== Math.round(hi / 1000) ? `${approx}${k(lo)}–${k(hi)}` : `${approx}${k(lo)}`;
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
    salaryMin: j.annualSalaryMin,
    salaryMax: j.annualSalaryMax,
    salaryCurrency: j.salaryCurrency || 'USD',
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
    salaryMin: j.salary_min,
    salaryMax: j.salary_max,
    salaryCurrency: 'USD',
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
  // locationRestrictions is an array of OBJECTS {name, alpha2, slug} — if there
  // are none, the role is open worldwide (which includes Europe).
  const data = await getJson('https://himalayas.app/jobs/api?limit=100');
  return (data.jobs || []).map((j) => {
    const locs = (j.locationRestrictions || [])
      .map((l) => (typeof l === 'string' ? l : l && l.name))
      .filter(Boolean);
    return {
      source: 'himalayas',
      rawId: j.guid || `${j.companyName}-${j.title}`,
      title: j.title,
      company: j.companyName || 'Unknown',
      location: locs.join(', ') || 'Worldwide',
      category: (j.categories || []).join(', '),
      tags: [].concat(j.seniority || [], j.categories || []),
      url: j.applicationLink || j.guid,
      posted: typeof j.pubDate === 'number' ? new Date(j.pubDate * 1000).toISOString() : j.pubDate || '',
      salaryMin: j.minSalary,
      salaryMax: j.maxSalary,
      salaryCurrency: j.currency || 'USD',
      remoteFlag: true,
      description: clean(j.excerpt || j.description || '')
    };
  });
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

// Adzuna country -> Adzuna site domain, used to build search URLs for the
// Apify actor's default input. (Adzuna has no Ireland/Nordics sites.)
const ADZUNA_DOMAINS = {
  gb: 'adzuna.co.uk',
  de: 'adzuna.de',
  fr: 'adzuna.fr',
  nl: 'adzuna.nl',
  es: 'adzuna.es',
  it: 'adzuna.it',
  at: 'adzuna.at',
  be: 'adzuna.be',
  ch: 'adzuna.ch',
  pl: 'adzuna.pl'
};

// Adzuna returns salaries in each country's local currency.
const ADZUNA_CURRENCY = {
  gb: 'GBP', ch: 'CHF', pl: 'PLN',
  de: 'EUR', fr: 'EUR', nl: 'EUR', es: 'EUR', it: 'EUR', at: 'EUR', be: 'EUR'
};

// Adzuna. Prefer Adzuna's own API (reliable, structured) when keys are present;
// otherwise fall back to running an Adzuna scraper actor on Apify.
async function fromAdzuna() {
  const id = realEnv('ADZUNA_APP_ID');
  const key = realEnv('ADZUNA_APP_KEY');
  if (id && key) return adzunaViaApi(id, key);

  const token = realEnv('APIFY_TOKEN');
  if (token) return adzunaViaApify(token);

  throw new Error(
    'set ADZUNA_APP_ID + ADZUNA_APP_KEY (recommended) — or APIFY_TOKEN — in .env to enable Adzuna'
  );
}

// Direct Adzuna API. We search the TITLE for each DEI term (title_only), per
// European country — so Adzuna returns title-matched DEI roles rather than every
// job that mentions diversity in its boilerplate. Results are deduped by id and
// still validated by the strict DEI filter.
async function adzunaViaApi(id, key) {
  const countries = (process.env.ADZUNA_COUNTRIES || Object.keys(ADZUNA_DOMAINS).join(','))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((c) => ADZUNA_DOMAINS[c]);
  const terms = (process.env.ADZUNA_TITLE_TERMS || 'diversity,inclusion,belonging,DEI')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const perPage = Number(process.env.ADZUNA_RESULTS || 50);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const seen = new Set();
  const out = [];
  for (const c of countries) {
    for (const term of terms) {
      const url =
        `https://api.adzuna.com/v1/api/jobs/${c}/search/1?app_id=${id}&app_key=${key}` +
        `&results_per_page=${perPage}&title_only=${encodeURIComponent(term)}` +
        `&max_days_old=60&sort_by=date&content-type=application/json`;
      let data;
      try {
        data = await getJson(url);
      } catch (e) {
        console.warn(`    · adzuna ${c.toUpperCase()}/${term}: ${e.message} (skipped)`);
        await sleep(200);
        continue;
      }
      for (const j of data.results || []) {
        if (seen.has(j.id)) continue;
        seen.add(j.id);
        out.push({
          source: 'adzuna',
          rawId: j.id,
          title: clean(j.title || ''),
          company: j.company?.display_name || 'Unknown',
          location: j.location?.display_name || c.toUpperCase(),
          category: j.category?.label || '',
          tags: [c.toUpperCase()],
          url: j.redirect_url,
          posted: j.created,
          salaryMin: j.salary_min,
          salaryMax: j.salary_max,
          salaryCurrency: ADZUNA_CURRENCY[c] || 'EUR',
          remoteFlag: /remote/i.test(`${j.title} ${j.description || ''}`),
          description: clean(j.description || '')
        });
      }
      await sleep(200); // be gentle on Adzuna's rate limit
    }
  }
  return out;
}

// Fallback: run an Adzuna scraper actor on Apify. Actor + input are overridable
// (APIFY_ADZUNA_ACTOR, APIFY_ADZUNA_INPUT) because each actor's schema differs;
// output is mapped defensively.
async function adzunaViaApify(token) {
  const actor = process.env.APIFY_ADZUNA_ACTOR || 'powerbox~adzuna-jobs-search-scraper';
  const query = process.env.ADZUNA_QUERY || 'diversity inclusion';
  const countries = (process.env.ADZUNA_COUNTRIES || Object.keys(ADZUNA_DOMAINS).join(','))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((c) => ADZUNA_DOMAINS[c]);
  const maxItems = Number(process.env.APIFY_MAX_ITEMS || 200);

  let input;
  if (process.env.APIFY_ADZUNA_INPUT) {
    input = JSON.parse(process.env.APIFY_ADZUNA_INPUT);
  } else {
    const urls = countries.map((c) => `https://www.${ADZUNA_DOMAINS[c]}/search?q=${encodeURIComponent(query)}`);
    input = { startUrls: urls.map((url) => ({ url })), searchUrls: urls, maxItems, maxJobs: maxItems, fetchDescription: true };
  }

  const url =
    `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&clean=true&format=json`;
  const items = await postJson(url, input);
  const rows = Array.isArray(items) ? items : items?.items || [];

  return rows.map((j) => {
    let loc = pickField(j, ['location', 'locationName', 'jobLocation', 'area', 'city', 'region']);
    if (loc && typeof loc === 'object') loc = loc.display_name || loc.name || (Array.isArray(loc) ? loc.join(', ') : '');
    const salary = pickField(j, ['salary', 'salaryText', 'salaryRange', 'salary_min']);
    return {
      source: 'adzuna',
      rawId: pickField(j, ['id', 'jobId', 'adRef', 'slug', 'url', 'jobUrl']),
      title: clean(pickField(j, ['title', 'jobTitle', 'position', 'name']) || ''),
      company: pickField(j, ['company', 'companyName', 'company_name', 'employer', 'companyDisplayName']) || 'Unknown',
      location: typeof loc === 'string' ? loc : '',
      category: pickField(j, ['category', 'categoryLabel', 'sector']) || '',
      tags: [],
      url: pickField(j, ['url', 'jobUrl', 'link', 'redirectUrl', 'redirect_url', 'applyUrl', 'externalUrl', 'adRef']),
      posted: pickField(j, ['created', 'datePosted', 'postedDate', 'date', 'publishedAt']) || '',
      salary: salary != null ? String(salary) : '',
      remoteFlag: /remote/i.test(
        `${pickField(j, ['title']) || ''} ${pickField(j, ['description', 'descriptionText', 'snippet']) || ''}`
      ),
      description: clean(pickField(j, ['description', 'descriptionText', 'snippet', 'jobDescription']) || '')
    };
  });
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
  adzuna: {
    fn: fromAdzuna,
    default: !!(realEnv('ADZUNA_APP_ID') && realEnv('ADZUNA_APP_KEY')) || !!realEnv('APIFY_TOKEN')
  }
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
    salary: formatEurSalary(raw.salaryMin, raw.salaryMax, raw.salaryCurrency) || raw.salary || '',
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
  if (deduped.length === 0) {
    console.log(
      '  (No DEI roles matched this run. Often this is a blocked network — some job APIs reject\n' +
        '   datacenter/proxy IPs. Try again from your own machine/home network, or scrape specific\n' +
        '   sources, e.g.  node scripts/scrape.js --source remotive,themuse)'
    );
  }
}

main().catch((err) => {
  console.error('Scrape failed:', err);
  process.exit(1);
});
