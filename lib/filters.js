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

// Remote / hybrid / on-site signals, scanned in the ad text (multilingual).
const RX_REMOTE =
  /\b(remote|fully[-\s]?remote|100\s*%\s*remote|work[-\s]?from[-\s]?home|wfh|home[-\s]?office|remote[-\s]?first|work\s+from\s+anywhere|telecommut\w*|telework|t[ée]l[ée]travail|travail\s+à\s+distance|teletrabajo|trabajo\s+(en\s+)?remoto|en\s+remoto|lavoro\s+da\s+remoto|smart\s*working|telelavoro|thuiswerken|werken\s+op\s+afstand|praca\s+zdalna|zdaln\w*|ortsunabh[äa]ngig|mobiles\s+arbeiten|telearbeit)\b/i;
const RX_FULLY_REMOTE =
  /\b(fully[-\s]?remote|100\s*%\s*remote|work\s+from\s+anywhere|remote[-\s]?first|t[ée]l[ée]travail\s+complet|trabajo\s+(en\s+)?remoto)\b/i;
const RX_HYBRID =
  /\b(hybrid\w*|hybride|h[íi]brido|ibrido|hybrydow\w*|teilweise\s+remote|partially\s+remote)\b/i;
const RX_ONSITE =
  /\b(on[-\s]?site|onsite|in[-\s]?office|vor\s+ort|in\s+pr[äa]senz|presencial|sur\s+site|no\s+remote|kein\s+homeoffice|geen\s+thuiswerk)\b/i;

// Classify a role's work style, looking at the location AND the ad body so that
// "remote possible" buried in a description is caught even if the location is a
// city. Trusts remoteFlag from remote-only sources. Precedence: an explicit
// fully-remote phrase, then "hybrid", then explicit on-site, then any remote
// mention — so "in office 5 days a week" reads as on-site, not hybrid.
export function classifyRemote(location = '', remoteFlag, text = '') {
  if (remoteFlag === true) return 'Remote';
  const hay = lc(`${location} ${text}`);
  if (RX_FULLY_REMOTE.test(hay)) return 'Remote';
  if (RX_HYBRID.test(hay)) return 'Hybrid';
  if (RX_ONSITE.test(hay)) return 'On-site';
  if (RX_REMOTE.test(hay)) return 'Remote';
  return 'On-site / Unspecified';
}

// Does the ad indicate English speakers are welcome? Phrases that mean English
// is the working language / sufficient, the role being in an English-speaking
// country, or the ad itself being written in English. A required-fluent local
// language overrides (then it's not English-only friendly).
const RX_ENGLISH_OK =
  /\b(english[-\s]?speaking|fluent\s+(in\s+)?english|english\s+is\s+(our|the)\s+(working|company|official|main)\s+language|working\s+language\s+is\s+english|we\s+(work|communicate|operate)\s+in\s+english|english\s+(language\s+)?(is\s+)?required|good\s+(command|knowledge|level)\s+of\s+english|(no|without)\s+(german|french|dutch|spanish|italian|polish)\s+(language\s+)?(skills?\s+)?(is\s+)?(required|needed|necessary))\b/i;
const RX_LOCAL_REQUIRED =
  /\b(flie[sß]end\w*\s+deutsch|verhandlungssicher\w*\s+deutsch|sehr\s+gute\s+deutschkenntnisse|muttersprach\w*\s+deutsch|fluent\s+(german|french|dutch|spanish|italian|polish)|native\s+(german|french|dutch|spanish|italian|polish)|fran[çc]ais\s+courant|courant\s+en\s+fran[çc]ais|n[ée]erlandais\s+courant|nederlands\s+(vereist|verplicht)|espa[ñn]ol\s+nativo|madrelingua)\b/i;

const EN_WORDS = /\b(the|and|you|we|with|for|are|will|our|your|that|this|have|to|of)\b/g;
const NON_EN_WORDS = {
  de: /\b(und|sie|wir|für|mit|der|die|das|nicht|eine?|von|im|zu)\b/g,
  fr: /\b(et|vous|nous|pour|avec|le|la|les|une?|des|dans|du)\b/g,
  es: /\b(y|usted|nosotros|para|con|el|la|los|una?|del|que|en)\b/g,
  it: /\b(e|voi|noi|per|con|il|la|gli|una?|del|che|nel)\b/g,
  nl: /\b(en|je|wij|voor|met|de|het|niet|een|van|om)\b/g,
  pl: /\b(i|ty|my|dla|na|nie|jest|oraz|do|się|że)\b/g
};

function looksEnglish(text) {
  const t = lc(text);
  if (t.length < 40) return false;
  const en = (t.match(EN_WORDS) || []).length;
  let other = 0;
  for (const re of Object.values(NON_EN_WORDS)) other = Math.max(other, (t.match(re) || []).length);
  return en >= 4 && en > other;
}

export function detectEnglishFriendly(text = '', country = '') {
  if (/united kingdom|ireland|\buk\b|britain|england|scotland|wales/i.test(country)) return 'English-friendly';
  if (RX_LOCAL_REQUIRED.test(text)) return 'Local language';
  if (RX_ENGLISH_OK.test(text)) return 'English-friendly';
  if (looksEnglish(text)) return 'English-friendly';
  return 'Unclear';
}
