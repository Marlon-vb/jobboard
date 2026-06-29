# DEI Europe — Job Board

An interactive job board focused on **remote-friendly Diversity, Equity & Inclusion (DEI) roles across Europe**.

It pulls **real, live data** from several public job APIs, filters them down to DEI roles that are
in Europe (or remote-worldwide, i.e. open to European candidates), and presents them in a fast,
filterable UI. It ships with a curated, source-linked seed set so the board is never empty.

![screenshot](docs/screenshot.png)

## Features

- 🔎 **Live scraping** of many job sources — Remotive, Jobicy, Arbeitnow (Europe-focused), RemoteOK, The Muse, and Himalayas with **no API key**, plus opt-in Greenhouse / Lever company boards and Adzuna's country-by-country European search.
- 🎯 **Smart filtering**: keeps only DEI roles (diversity, equity, inclusion, belonging, EDI, DEIB, ERG…) that are in Europe or open worldwide-remote.
- 🧭 **Interactive UI**: full-text search, plus one-click facets for work style (Remote / Hybrid), seniority, country, and source. Sort by newest / company / title.
- ♻️ **Refresh button** re-runs the scraper on demand from the browser.
- 🌱 **Curated seed data**: 16 hand-picked, source-linked DEI roles/boards (GitLab, Spotify, SAP, Zalando, Roche, Wikimedia, Remote.com, and specialist boards like Diversity & Inclusion Leaders) so it works out of the box.
- 🪶 **Tiny footprint**: one dependency (Express), plain HTML/CSS/JS frontend, no build step.

## Quick start

```bash
npm install        # installs express
npm run scrape     # pull fresh live listings into data/jobs.json (see note below)
npm start          # serve the board at http://localhost:3000
```

Then open **http://localhost:3000**.

> **Note on the scraper & networks.** The job APIs above are reachable from a normal machine or
> home network. Some restricted environments (corporate proxies, CI sandboxes) block outbound calls
> to them. The scraper is resilient: if a source is unreachable it logs a warning, skips it, and the
> board falls back to the curated seed data — so you always see real DEI roles. Run `npm run scrape`
> on your own machine to fetch fresh live listings.

## How it works

```
scripts/scrape.js   →  fetches each source, normalizes to one schema,
                       filters (DEI role) AND (Europe or remote), dedupes,
                       merges with the curated seed, writes data/jobs.json
lib/filters.js      →  the matching rules (DEI keywords, European locations,
                       seniority + remote classification) — shared & testable
server.js           →  Express: serves /public, exposes /api/jobs, /api/meta,
                       and POST /api/refresh (re-runs the scraper)
public/             →  the interactive frontend (index.html, app.js, styles.css)
data/seed.json      →  curated, source-linked real listings (fallback + base)
data/jobs.json      →  generated output that the board reads
```

### Scraper usage

```bash
npm run scrape                      # scrape all default sources, merge with seed
node scripts/scrape.js --fresh      # live sources only, ignore the seed
node scripts/scrape.js --source remotive,themuse   # only specific sources
```

### Sources

| Source        | Key needed?            | Notes                                                        |
| ------------- | ---------------------- | ------------------------------------------------------------ |
| `remotive`    | no                     | Remote jobs, searched across DEI terms.                      |
| `jobicy`      | no                     | Remote jobs API.                                             |
| `arbeitnow`   | no                     | European job board (great for Germany/EU).                   |
| `remoteok`    | no                     | Remote jobs API.                                             |
| `themuse`     | no                     | Filtered to the HR & Recruiting category.                    |
| `himalayas`   | no                     | Remote-only jobs API.                                        |
| `greenhouse`  | no (opt-in env)        | Per-company boards via `GREENHOUSE_BOARDS=token1,token2`.    |
| `lever`       | no (opt-in env)        | Per-company boards via `LEVER_BOARDS=handle1,handle2`.       |
| `adzuna`      | yes (free)             | Country-by-country EU search; needs Adzuna app id + key.     |

The six no-key sources run on a plain `npm run scrape`. The opt-in sources only run
when their environment variables are present, so default runs stay quiet:

```bash
# Pull DEI roles straight from companies' own ATS boards:
GREENHOUSE_BOARDS=elastic,mongodb,gitlab npm run scrape
LEVER_BOARDS=netflix,plaid npm run scrape

# Adzuna — get a free app id/key at https://developer.adzuna.com
ADZUNA_APP_ID=xxxx ADZUNA_APP_KEY=yyyy npm run scrape
# Optionally narrow the countries (defaults to a broad EU set):
ADZUNA_APP_ID=xxxx ADZUNA_APP_KEY=yyyy ADZUNA_COUNTRIES=gb,de,nl,ie npm run scrape
```

### API

| Endpoint            | Description                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| `GET /api/jobs`     | Filtered list. Query params: `q`, `country`, `seniority`, `remote`, `source`, `sort`. |
| `GET /api/meta`     | Facet counts (countries, seniorities, work styles, sources) + last-updated time.       |
| `POST /api/refresh` | Re-runs the scraper, then the board reloads with fresh data.           |

## Adding more sources

Each source is a small adapter function in `scripts/scrape.js` that returns rows in a common
shape. To add one, write a `fromX()` adapter and register it in the `SOURCES` map as
`{ fn: fromX, default: true }` (use `default: !!process.env.MY_KEY` to make it opt-in).
Filtering, dedup, and merge happen automatically. Tune what counts as "DEI" or "Europe"
in `lib/filters.js`.

## Customising the search

The defaults target DEI + Europe + remote. To refocus (different field, different region),
edit the keyword/location lists in `lib/filters.js` — that's the single place the matching
rules live.

---

Built as a focused tool for a European DEI job search. Data belongs to the respective job boards and employers; this project just aggregates and links to it.
