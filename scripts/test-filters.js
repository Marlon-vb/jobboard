#!/usr/bin/env node
// Plain-node tests for the DEI matcher. Run with: npm test
// These guard the core promise: only specific DEI job functions get through,
// and roles that merely mention diversity/equity in boilerplate do not.

import {
  isDeiRole,
  isEuropeOrRemote,
  classifyRemote,
  detectEnglishFriendly,
  looksNonEnglish,
  isAccessibleToEnglishSpeakers
} from '../lib/filters.js';

// Real DEI job functions — these MUST match.
const shouldMatch = [
  { title: 'Diversity, Equity & Inclusion Specialist' },
  { title: 'Head of Inclusion' },
  { title: 'DEI Manager' },
  { title: 'Global Head of Diversity & Inclusion' },
  { title: 'EDI Officer' },
  { title: 'Belonging Program Manager' },
  { title: 'Inclusion, Diversity, Equity & Allyship (IDEA) Partner' },
  { title: 'Equality, Diversity and Inclusion Adviser' },
  { title: 'People Partner', tags: ['d&i', 'belonging'] },
  { title: 'Anti-Racism Programme Lead' },
  // Local-language DEI titles
  { title: 'Diversity & Inklusion Manager (m/w/d)' }, // German
  { title: 'Referent:in Vielfalt und Zugehörigkeit' }, // German
  { title: 'Responsable Diversité et Inclusion' }, // French
  { title: 'Técnico de Diversidad e Inclusión' }, // Spanish
  { title: 'Diversiteit en Inclusie Adviseur' }, // Dutch
  { title: 'Specjalista ds. Różnorodności' } // Polish
];

// Not DEI roles — these MUST NOT match, even though many contain
// diversity/equity language somewhere.
const shouldNotMatch = [
  { title: 'Senior Software Engineer', description: 'We are an equal opportunity employer committed to diversity and inclusion.' },
  { title: 'People Operations Manager', description: 'Generous equity compensation and a commitment to diversity.' },
  { title: 'Equity Research Analyst' },
  { title: 'Talent Acquisition Partner', description: 'You will champion diversity in hiring.' },
  { title: 'Accessibility Engineer' },
  { title: 'Editor, Content', tags: ['media', 'publishing'] },
  { title: 'Energy Markets Analyst', tags: ['energy'] },
  { title: 'Biodiversity Field Officer' },
  { title: 'Recruiter', description: 'Diversity is a priority for us.' },
  { title: 'Backend Engineer III', tags: ['golang', 'fintech'] }
];

// Europe / remote location filter. extra = `${title} ${tags}`.
const europeOk = [
  ['Berlin, Germany', ''],
  ['Remote — Europe', ''],
  ['EMEA', ''],
  ['Worldwide', ''],
  ['Anywhere', ''],
  ['Remote', 'DEI Manager EMEA'], // Europe signalled in title
  ['London, United Kingdom', '']
];
const europeNo = [
  ['United States', 'Remote Outpatient Neurologist'], // "eu" in neurologist must NOT match
  ['United States', 'Strategic Account Manager'],
  ['Remote', 'Strategic Account Manager Sales'], // bare remote, no Europe signal
  ['New York, NY', ''],
  ['San Francisco', 'Global mindset'], // "global" only counts from location, not title
  ['Canada', '']
];

// Remote detection from ad text (location may be a city).
const remoteChecks = [
  [classifyRemote('Berlin, Germany', false, 'This role is fully remote within Europe.'), 'Remote'],
  [classifyRemote('Paris', false, 'Poste en télétravail complet.'), 'Remote'],
  [classifyRemote('Madrid', false, 'Trabajo en remoto, equipo distribuido.'), 'Remote'],
  [classifyRemote('Munich', false, 'Hybrides Arbeiten, 2 Tage im Büro.'), 'Hybrid'],
  [classifyRemote('Amsterdam', false, 'On-site role, in office 5 days a week.'), 'On-site'],
  [classifyRemote('Anywhere', true, ''), 'Remote']
];

// English-speaker friendliness.
const englishChecks = [
  [detectEnglishFriendly('Our working language is English; no German required.', 'Germany'), 'English-friendly'],
  [detectEnglishFriendly('We are looking for a diversity manager to join our team and help build an inclusive culture for everyone.', 'Netherlands'), 'English-friendly'],
  [detectEnglishFriendly('Wir suchen eine Person mit fließend Deutsch in Wort und Schrift.', 'Germany'), 'Local language'],
  [detectEnglishFriendly('Diversity & Inclusion Lead', 'United Kingdom'), 'English-friendly']
];

// Language-accessibility rule: fully non-English ads are dropped unless they
// welcome English speakers AND offer remote capability.
const GERMAN_AD =
  'Wir suchen eine engagierte Person für unser Team. Sie entwickeln die Strategie für Vielfalt und ' +
  'Inklusion und arbeiten eng mit der Geschäftsführung zusammen. Die Stelle ist in unserem Büro angesiedelt.';
const GERMAN_AD_EN_REMOTE =
  'Wir suchen eine Person für Vielfalt und Inklusion. Die Stelle ist 100% remote. Sehr gute ' +
  'Englischkenntnisse genügen — wir arbeiten international und die Teams sind verteilt über Europa.';
const ENGLISH_AD =
  'We are looking for a Diversity & Inclusion Manager to build our strategy and partner with leadership across the region.';

const langRuleChecks = [
  // [text, english, remote, expectedKept]
  [GERMAN_AD, 'Local language', 'On-site / Unspecified', false], // fully German, no signals → dropped
  [GERMAN_AD, 'Unclear', 'On-site / Unspecified', false], // fully German, unclear → dropped
  [GERMAN_AD_EN_REMOTE, 'English-friendly', 'Remote', true], // German ad but English OK + remote → kept
  [GERMAN_AD, 'English-friendly', 'On-site / Unspecified', false], // English OK but no remote → dropped
  [ENGLISH_AD, 'Unclear', 'On-site / Unspecified', true], // English ad always passes the rule
  ['Diversity Manager', 'Unclear', 'On-site / Unspecified', true] // short title-only text → never dropped
];

// looksNonEnglish sanity
const nonEnglishChecks = [
  [looksNonEnglish(GERMAN_AD), true],
  [looksNonEnglish(ENGLISH_AD), false],
  [looksNonEnglish('Referent:in Vielfalt'), false] // too short to judge
];

let failures = 0;
for (const [text, english, remote, want] of langRuleChecks) {
  const got = isAccessibleToEnglishSpeakers(text, english, remote);
  if (got !== want) {
    console.error(`✗ language rule: got ${got}, want ${want} for english=${english}, remote=${remote}`);
    failures++;
  }
}
for (const [got, want] of nonEnglishChecks) {
  if (got !== want) {
    console.error(`✗ looksNonEnglish: got ${got}, want ${want}`);
    failures++;
  }
}
for (const [got, want] of remoteChecks) {
  if (got !== want) {
    console.error(`✗ remote: got "${got}", want "${want}"`);
    failures++;
  }
}
for (const [got, want] of englishChecks) {
  if (got !== want) {
    console.error(`✗ english: got "${got}", want "${want}"`);
    failures++;
  }
}
for (const j of shouldMatch) {
  if (!isDeiRole(j)) {
    console.error(`✗ FALSE NEGATIVE (should be DEI): "${j.title}"`);
    failures++;
  }
}
for (const j of shouldNotMatch) {
  if (isDeiRole(j)) {
    console.error(`✗ FALSE POSITIVE (not DEI): "${j.title}"`);
    failures++;
  }
}
for (const [loc, extra] of europeOk) {
  if (!isEuropeOrRemote(loc, extra)) {
    console.error(`✗ Europe FALSE NEGATIVE: "${loc}" / "${extra}"`);
    failures++;
  }
}
for (const [loc, extra] of europeNo) {
  if (isEuropeOrRemote(loc, extra)) {
    console.error(`✗ Europe FALSE POSITIVE: "${loc}" / "${extra}"`);
    failures++;
  }
}

if (failures) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
const total =
  shouldMatch.length + shouldNotMatch.length + europeOk.length + europeNo.length +
  remoteChecks.length + englishChecks.length + langRuleChecks.length + nonEnglishChecks.length;
console.log(`✓ all ${total} filter tests passed (DEI + Europe + remote + English + language rule)`);
