// Shared matching logic used by the scraper to decide whether a raw job posting
// is (a) a DEI role, (b) located in / open to Europe, and (c) remote-friendly.
//
// Keep this dependency-free so it can run in Node or be imported by tests.

// Matching is deliberately STRICT and based only on the job *title* (and, as a
// secondary signal, structured tags). We never infer "DEI" from the
// description, because almost every job description contains diversity/equity
// boilerplate (EEO statements, "equity compensation", etc.) — matching on that
// floods the board with non-DEI roles. The goal is specific DEI job functions.

// Multi-character / punctuated phrases that are safe to match as substrings.
const DEI_PHRASES = [
  'diversity',
  'inclusion',
  'inclusive',
  'belonging',
  'deib',
  'd&i',
  'd & i',
  'i&d',
  'ed&i',
  'e,d&i',
  'anti-racism',
  'antiracism',
  'widening participation',
  'employee resource group',
  // Local-language equivalents of diversity / inclusion / inclusive / belonging.
  // (Equity & equality are intentionally NOT translated/added, in any language.)
  'vielfalt', 'diversität', 'inklusion', 'inklusiv', 'zugehörigkeit', // German
  'diversité', 'inclusif', 'inclusive', 'appartenance', // French (inclusion == EN)
  'diversidad', 'inclusión', 'inclusivo', 'inclusiva', 'pertenencia', // Spanish
  'diversità', 'inclusione', 'appartenenza', // Italian
  'diversiteit', 'inclusie', 'inclusief', 'verbondenheid', 'saamhorigheid', // Dutch
  'różnorodność', 'różnorodności', 'inkluzja', 'inkluzywny', 'przynależność' // Polish (incl. genitive)
];

// Short, ambiguous tokens that must match as whole words (word-boundary), so
// "DEI"/"EDI" match but "media", "editor", "credit", "idea" do not.
const DEI_WORD_TOKENS = ['dei', 'edi'];

// NOTE: bare "equity"/"equality"/"accessibility" are intentionally NOT matched
// on their own — they appear in "equity research", "equity compensation",
// "accessibility engineer", etc. In real DEI titles they always co-occur with
// "diversity"/"inclusion" (e.g. "Diversity, Equity & Inclusion"), which we
// already catch.

// Kept for backwards compatibility / other callers.
export const DEI_KEYWORDS = [...DEI_PHRASES, ...DEI_WORD_TOKENS];
export const DEI_TITLE_KEYWORDS = DEI_KEYWORDS;

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

// Terms meaning "open to candidates anywhere", which includes Europe. NOTE:
// bare "remote" is deliberately NOT here — a US-only remote job is still remote
// but not open to Europe, and treating "remote" as worldwide is what let
// non-European roles onto the board.
export const WORLDWIDE_TERMS = ['worldwide', 'anywhere', 'global'];

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

// True only when the text carries an unambiguous DEI signal: a DEI phrase as a
// substring, or a short token (DEI/EDI) as a whole word. Word-boundary handling
// means "diversity" matches but "biodiversity" does not.
function hasDeiSignal(text) {
  const t = lc(text);
  if (!t) return false;
  for (const phrase of DEI_PHRASES) {
    if (phrase.length >= 5 || phrase.includes('&') || phrase.includes(' ') || phrase.includes('-')) {
      // long / punctuated phrases: word-boundary where it makes sense
      if (containsWord(t, phrase) || (phrase.includes(' ') && t.includes(phrase))) return true;
    } else if (t.includes(phrase)) {
      return true;
    }
  }
  return DEI_WORD_TOKENS.some((tok) => containsWord(t, tok));
}

// A posting is a DEI role only if the DEI signal is in the TITLE or the
// structured TAGS — never the free-text description (boilerplate would match
// almost everything). This keeps the board to specific DEI job functions.
export function isDeiRole({ title = '', tags = [] }) {
  if (hasDeiSignal(title)) return true;
  const tagText = Array.isArray(tags) ? tags.join(' ') : String(tags || '');
  return hasDeiSignal(tagText);
}

// Build word-boundary regexes so short tokens like "eu"/"uk" match only as
// whole words — otherwise "eu" matches "nEUrologist", "us" matches "hoUSe",
// and US-only roles sail through.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EUROPE_RE = new RegExp(`\\b(${EUROPE_TERMS.map(escapeRe).join('|')})\\b`, 'i');
const WORLDWIDE_RE = new RegExp(`\\b(${WORLDWIDE_TERMS.map(escapeRe).join('|')}|fully[\\s-]?remote)\\b`, 'i');

export function isEuropeOrRemote(location = '', extra = '') {
  // A European country/region named anywhere (location, title or tags) qualifies.
  if (EUROPE_RE.test(location) || EUROPE_RE.test(extra)) return true;
  // "Worldwide / anywhere / global" only counts from the location/region field —
  // not the title/tags — so a "Global Account Manager" in the US isn't kept.
  if (WORLDWIDE_RE.test(location)) return true;
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
