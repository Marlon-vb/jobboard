// Express server for the DEI Europe job board.
//  - Serves the static frontend from /public
//  - GET /api/jobs   -> filtered/sorted job list (query params below)
//  - GET /api/meta   -> facets (countries, seniorities, sources) + generatedAt
//  - POST /api/refresh -> re-runs the live scraper, then reloads data
//
// Data is read from data/jobs.json (produced by scripts/scrape.js). If that
// file is missing, we fall back to the curated data/seed.json so the board
// always renders.

import express from 'express';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './lib/env.js';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, 'data', 'jobs.json');
const SEED_FILE = join(__dirname, 'data', 'seed.json');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(join(__dirname, 'public')));

async function loadData() {
  try {
    if (existsSync(DATA_FILE)) {
      const payload = JSON.parse(await readFile(DATA_FILE, 'utf8'));
      if (payload.jobs?.length) return payload;
    }
  } catch (e) {
    console.warn('Could not read jobs.json, falling back to seed:', e.message);
  }
  // Fallback: curated seed only.
  const seed = JSON.parse(await readFile(SEED_FILE, 'utf8'));
  return { generatedAt: null, count: seed.length, sources: ['seed'], jobs: seed };
}

function applyFilters(jobs, q) {
  let out = jobs;
  const term = (q.q || '').toLowerCase().trim();
  if (term) {
    out = out.filter((j) =>
      [j.title, j.company, j.location, j.category, (j.tags || []).join(' '), j.description]
        .join(' ')
        .toLowerCase()
        .includes(term)
    );
  }
  if (q.country) out = out.filter((j) => j.country === q.country);
  if (q.seniority) out = out.filter((j) => j.seniority === q.seniority);
  if (q.remote) out = out.filter((j) => j.remote === q.remote);
  if (q.source) out = out.filter((j) => j.source === q.source);

  const sort = q.sort || 'newest';
  if (sort === 'newest') out = [...out].sort((a, b) => (b.posted || '').localeCompare(a.posted || ''));
  else if (sort === 'company') out = [...out].sort((a, b) => (a.company || '').localeCompare(b.company || ''));
  else if (sort === 'title') out = [...out].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  return out;
}

function facet(jobs, key) {
  const counts = {};
  for (const j of jobs) {
    const v = j[key];
    if (!v) continue;
    counts[v] = (counts[v] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count }));
}

app.get('/api/jobs', async (req, res) => {
  const data = await loadData();
  const jobs = applyFilters(data.jobs, req.query);
  res.json({ generatedAt: data.generatedAt, total: data.jobs.length, matched: jobs.length, jobs });
});

app.get('/api/meta', async (_req, res) => {
  const data = await loadData();
  res.json({
    generatedAt: data.generatedAt,
    total: data.jobs.length,
    sources: data.sources,
    countries: facet(data.jobs, 'country'),
    seniorities: facet(data.jobs, 'seniority'),
    remoteTypes: facet(data.jobs, 'remote'),
    sourceFacets: facet(data.jobs, 'source')
  });
});

let refreshing = false;
app.post('/api/refresh', async (_req, res) => {
  if (refreshing) return res.status(429).json({ ok: false, message: 'A refresh is already running.' });
  refreshing = true;
  const child = spawn(process.execPath, [join(__dirname, 'scripts', 'scrape.js')], {
    cwd: __dirname
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  child.on('close', (code) => {
    refreshing = false;
    res.json({ ok: code === 0, code, log: log.slice(-4000) });
  });
  child.on('error', (err) => {
    refreshing = false;
    res.status(500).json({ ok: false, message: err.message });
  });
});

app.listen(PORT, () => {
  console.log(`\n  DEI Europe job board running at  http://localhost:${PORT}\n`);
});
