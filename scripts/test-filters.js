#!/usr/bin/env node
// Plain-node tests for the DEI matcher. Run with: npm test
// These guard the core promise: only specific DEI job functions get through,
// and roles that merely mention diversity/equity in boilerplate do not.

import { isDeiRole } from '../lib/filters.js';

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
  { title: 'Anti-Racism Programme Lead' }
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

let failures = 0;
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

if (failures) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log(`✓ all ${shouldMatch.length + shouldNotMatch.length} DEI-filter tests passed`);
