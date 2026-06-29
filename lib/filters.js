// Shared matching logic used by the scraper to decide whether a raw job posting
// is (a) a DEI role, (b) located in / open to Europe, and (c) remote-friendly.
//
// Keep this dependency-free so it can run in Node or be imported by tests.

// Words / phrases that mark a posting as a Diversity, Equity & Inclusion role.
// Matched against the title first (strong signal) and the description (weaker).
export const DEI_KEYWORDS = [
  'diversity',
  'equity',
  'inclusion',
  'inclusive',
  'belonging',
  'dei',
  'deib',
  'd&i',
  'd & i',
  'i&d',
  'edi', // equality, diversity & inclusion (common in UK/Ireland)
  'ed&i',
  'equality',
  'anti-racism',
  'accessibility', // often part of the DEI remit
  'employee resource group',
  'erg',
  'widening participation'
];

// Title keywords that strongly imply a DEI *role* (not just a company that
// happens to mention diversity in its values blurb).
export const DEI_TITLE_KEYWORDS = [
  'diversity',
  'inclusion',
  'inclusive',
  'belonging',
  'dei',
  'deib',
  'd&i',
  'i&d',
  'edi',
  'ed&i',
  'equity',
  'equality'
];

// European countries + common regional shorthand. Used to keep the board
// focused on Europe. "Worldwide" / "Anywhere" remote roles are kept too,
// because they are open to candidates in Europe.
export const EUROPE_TERMS = [
  'europe',
  'european',
  'emea',
  'eu',
  'eea',
  'uk',
  'united kingdom',
  'england',
  'scotland',
  'wales',
  'northern ireland',
  'ireland',
  'germany',
  'deutschland',
  'france',
  'spain',
  'españa',
  'portugal',
  'italy',
  'italia',
  'netherlands',
  'holland',
  'belgium',
  'luxembourg',
  'switzerland',
  'austria',
  'poland',
  'czech',
  'czechia',
  'slovakia',
  'hungary',
  'romania',
  'bulgaria',
  'greece',
  'denmark',
  'sweden',
  'norway',
  'finland',
  'iceland',
  'estonia',
  'latvia',
  'lithuania',
  'croatia',
  'slovenia',
  'serbia',
  'ukraine',
  'amsterdam',
  'berlin',
  'munich',
  'paris',
  'madrid',
  'barcelona',
  'lisbon',
  'dublin',
  'london',
  'stockholm',
  'copenhagen',
  'zurich',
  'vienna',
  'warsaw',
  'milan',
  'rome'
];

// Terms meaning "open to candidates anywhere", which includes Europe.
export const WORLDWIDE_TERMS = ['worldwide', 'anywhere', 'global', 'remote'];

// Map a free-text location string to a normalized country label for filtering.
const COUNTRY_PATTERNS = [
  [/united kingdom|england|scotland|wales|\buk\b|london|manchester|edinburgh/i, 'United Kingdom'],
  [/ireland|dublin/i, 'Ireland'],
  [/germany|deutschland|berlin|munich|münchen|hamburg|frankfurt/i, 'Germany'],
  [/netherlands|holland|amsterdam|rotterdam|utrecht/i, 'Netherlands'],
  [/france|paris|lyon/i, 'France'],
  [/spain|españa|madrid|barcelona|valencia/i, 'Spain'],
  [/portugal|lisbon|lisboa|porto/i, 'Portugal'],
  [/italy|italia|milan|milano|rome|roma/i, 'Italy'],
  [/belgium|brussels|antwerp/i, 'Belgium'],
  [/switzerland|zurich|zürich|geneva|basel/i, 'Switzerland'],
  [/austria|vienna|wien/i, 'Austria'],
  [/poland|warsaw|krakow|kraków/i, 'Poland'],
  [/sweden|stockholm|gothenburg/i, 'Sweden'],
  [/denmark|copenhagen/i, 'Denmark'],
  [/norway|oslo/i, 'Norway'],
  [/finland|helsinki/i, 'Finland'],
  [/czech|czechia|prague/i, 'Czechia'],
  [/romania|bucharest/i, 'Romania'],
  [/greece|athens/i, 'Greece'],
  [/luxembourg/i, 'Luxembourg'],
  [/\beea\b|\bemea\b|europe|european/i, 'Europe (regional)'],
  [/worldwide|anywhere|global/i, 'Remote — Worldwide']
];

const lc = (s) => (s || '').toString().toLowerCase();

function containsAny(haystack, needles) {
  const h = lc(haystack);
  return needles.some((n) => h.includes(n));
}

// Word-boundary aware match for short, ambiguous tokens like "eu" or "dei".
function containsWord(haystack, word) {
  const re = new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
  return re.test(haystack || '');
}

export function isDeiRole({ title = '', description = '', tags = [] }) {
  const titleLc = lc(title);
  const tagText = Array.isArray(tags) ? tags.join(' ') : lc(tags);

  // Strong signal: a DEI keyword in the title or tags.
  if (DEI_TITLE_KEYWORDS.some((k) => (k.length <= 3 ? containsWord(titleLc, k) : titleLc.includes(k)))) {
    return true;
  }
  if (containsAny(tagText, DEI_KEYWORDS)) return true;

  // Weaker signal: an HR-adjacent title plus DEI language in the description.
  const hrAdjacent = /(hr|people|talent|culture|recruit|human resources|chief.*officer)/i.test(titleLc);
  if (hrAdjacent && containsAny(description, ['diversity', 'inclusion', 'belonging', 'deib', 'equity'])) {
    return true;
  }
  return false;
}

export function isEuropeOrRemote(location = '', extra = '') {
  const text = `${location} ${extra}`;
  if (containsAny(text, EUROPE_TERMS)) return true;
  if (containsAny(text, WORLDWIDE_TERMS)) return true;
  return false;
}

export function normalizeCountry(location = '', fallback = 'Europe / Remote') {
  for (const [re, label] of COUNTRY_PATTERNS) {
    if (re.test(location)) return label;
  }
  return fallback;
}

export function guessSeniority(title = '') {
  const t = lc(title);
  if (/(chief|cdo|vp|vice president|head of|director|global head)/.test(t)) return 'Leadership';
  if (/(lead|principal|senior|sr\.|manager|partner)/.test(t)) return 'Senior';
  if (/(junior|jr\.|intern|graduate|assistant|coordinator|associate)/.test(t)) return 'Entry / Mid';
  return 'Mid';
}

// Heuristic remote classification for display.
export function classifyRemote(location = '', remoteFlag) {
  if (remoteFlag === true) return 'Remote';
  const t = lc(location);
  if (/remote|anywhere|worldwide|work from home|wfh/.test(t)) return 'Remote';
  if (/hybrid/.test(t)) return 'Hybrid';
  return 'On-site / Unspecified';
}
