/**
 * The guard on text that reaches a company.
 *
 * WHY THIS EXISTS. On 31 August 2026 a founder asked Taranis what a "CASS
 * record" was, having read the phrase in the Information Request GAPS sheet
 * issued to him. That sheet cited Taranis' own internal assessment as a source
 * in fifteen rows, and one of those rows carried an actual sub-score. The
 * sheets were reissued clean by hand. This module is what stops the same text
 * being typed again, because the dataroom is the route by which it would happen
 * next at scale and automatically (HANDOVER-CW019).
 *
 * THE RULE, as settled by Mark on 31 August 2026:
 *
 *   CASS stays visible as a named process step. The numbers never leave
 *   Taranis.
 *
 * The acronym is not confidential. The Process Founder Deck and the DD
 * invitation email already describe the CASS pre-screen to founders, so a guard
 * that fires on the bare token would be an obstacle and would be switched off.
 * A score, a category sub-score, a rating, a band or a threshold result is
 * confidential, absolutely and in every channel.
 *
 * Hence two tiers:
 *
 *   TIER 1, SCORE            a number that is a verdict. Hard block.
 *   TIER 2, INTERNAL SOURCE  citing a Taranis-internal document as the source
 *                            of something, which reads to a founder as a paper
 *                            they are meant to hold. Blocked in company-visible
 *                            fields.
 *
 * WHICH FIELDS. `already_held` and `note_for_company` are company-visible:
 * `already_held` is the GAPS sheet's "We already hold" column, and
 * `note_for_company` reaches the GAPS sheet, the portal and outbound email.
 * Two fields are deliberately NOT guarded:
 *
 *   internal_note    Taranis-side only, stripped by `companySafeItem`. It is
 *                    where this material belongs, so blocking it would send the
 *                    text somewhere worse.
 *   source_document  Taranis-side only. It feeds the PRE-FILLED sheet's "Source
 *                    document on file" column and appears in no company-facing
 *                    response, export or email. Naming an internal source there
 *                    is the column's purpose: "CASS Assessment Report
 *                    (internal)" is a correct value, not a leak. Guarding it
 *                    would forbid the one thing it is for. Exemption confirmed
 *                    by Mark, 31 August 2026, against CW019 §3.4.
 *
 * ADDING A TERM. Add it to COMPANY_UNSAFE_PATTERNS below and nowhere else.
 * Every caller (the item routes, the seed importer, the seed builder, the GAPS
 * export and the stored-data audit) reads that one constant, so a term added
 * here is enforced everywhere at once.
 */

/** Thrown by `assertCompanySafeText`. Carries what the caller must report. */
export class CompanyVisibleTextError extends Error {
  constructor(field, hit) {
    super(messageFor(hit.term));
    this.name = 'CompanyVisibleTextError';
    this.code = 'COMPANY_VISIBLE_TEXT';
    this.field = field;
    this.term = hit.term;
    this.tier = hit.tier;
    this.match = hit.match;
  }
}

/** The wording is fixed by CW019 §3.2. It tells the author what to do instead. */
export function messageFor(term) {
  return `This text is visible to the company. Remove the internal reference `
       + `(${term}) and state the substance neutrally, e.g. 'our file notes ...'.`;
}

/**
 * The CASS scoring denominators. A fraction against one of these is a score.
 * Two is absent on purpose: "Phase 1/2 trial" is ordinary biotech prose.
 */
const DENOMINATORS = '5|6|8|10|20|30|40|100';

/** The four CASS category names, which carry sub-scores. */
const CATEGORIES =
  'Investment Fundamentals|Saudi Localisation|Market & Execution|Strategic Alignment';

/**
 * A number that could be a score, as opposed to one that is plainly a date.
 *
 * CW019 §3.1 says "within 40 characters of a digit", and any digit was too
 * blunt: it blocked "Strategic Alignment with your Q3 roadmap" and "Market &
 * Execution plans for the 2027 launch", which are ordinary things to write to a
 * company about. Narrowed on Mark's instruction, 31 August 2026, so that
 * quarters and years do not fire.
 *
 * Three exclusions, and each one is a real sentence somebody would write:
 *
 *   (?<![A-Za-z\d/])      a digit behind a letter is a label, not a score:
 *                         Q3, Q4, FY26, H1. Behind a slash it is the tail of
 *                         something already counted, as in FY2024/25.
 *   \d{1,3}(?!\d)         scores run 0 to 100, so a four-digit run is a year.
 *                         2026 cannot match at any offset.
 *   (?!.../.../...)       the leading part of a d/m/y date: 14/8/2026. A date
 *                         has two slashes, so "20/30" is untouched and still
 *                         reads as a sub-score.
 */
const SCORE_NUMBER = String.raw`(?<![A-Za-z\d/])\d{1,3}(?!\d)(?!\s*/\s*\d{1,2}\s*/\s*\d)`;

/**
 * Every pattern, in one list, tiered.
 *
 * `term` is what the author is shown. It has to name the thing they typed
 * clearly enough to find and rewrite it, so it is a phrase rather than a rule
 * number.
 *
 * Case insensitive unless a pattern says otherwise, and exactly one says
 * otherwise: see the PASS entry.
 */
export const COMPANY_UNSAFE_PATTERNS = [
  // -------------------------------------------------------------------------
  // TIER 1 — SCORE. Hard block, no exceptions.
  // -------------------------------------------------------------------------
  {
    tier: 'score',
    term: 'a score written as a fraction',
    // A d/m/y date is not a score. Without these two exclusions the guard fires
    // on "SPA dated 14/8/2026" and "board minutes of 12/10/2025", and a date is
    // the likeliest thing a "what we already hold" note contains. The lookbehind
    // rejects a fraction whose numerator is itself preceded by a digit or slash;
    // the lookahead rejects one followed by a further /digit.
    pattern: new RegExp(
      String.raw`(?<![\d/])\b\d{1,3}\s*/\s*(?:${DENOMINATORS})\b(?!\s*/\s*\d)`,
      'i'
    ),
  },
  {
    tier: 'score',
    term: 'a scoring word',
    pattern: /\b(?:scored|scores|sub-scores?|score of|rating of)\b/i,
  },
  {
    tier: 'score',
    // Bare "rated" is ordinary English: "rated for BSL-2 work", "rated to
    // 10,000 rpm", "rated by BSI". Only a rating that resolves to a verdict or
    // a number is a score, so the word is anchored to one.
    term: 'a rating given as a verdict',
    pattern: /\brated\s+(?:as\s+)?(?:strong|good|weak|adequate|\d)/i,
  },
  {
    tier: 'score',
    // The CASS band words, but only where they read as a verdict rather than as
    // the ordinary adjectives they also are.
    term: 'a CASS band',
    pattern:
      /\b(?:strong|good|weak|adequate)\s+(?:rating|band)\b|\b(?:rating|band)\s+of\s+(?:strong|good|weak|adequate)\b/i,
  },
  {
    tier: 'score',
    // CW019 §4 requires "exceeding all category thresholds" to match, so the
    // list in §3.1 ("exceeds/exceeding all thresholds") is widened to allow the
    // words that sit between "all" and "thresholds".
    term: 'a threshold result',
    pattern:
      /\b(?:exceeds?|exceeding|exceeded|passed|passes|meets|met)\s+all\s+(?:\w+\s+){0,2}thresholds?\b|\bthreshold check\b|\bgo\s*\/\s*no-?go\s+result\b/i,
  },
  {
    tier: 'score',
    // Case SENSITIVE, and the only pattern here that is. Lower-case "pass on"
    // is everyday English ("we will pass on the auditor's details"), so an
    // insensitive rule would fire constantly and get the guard turned off.
    // Upper-case PASS is the CASS verdict style: "PASS on Investment
    // Fundamentals".
    term: 'a CASS PASS verdict',
    pattern: /\bPASS\s+on\b/,
  },
  {
    tier: 'score',
    // A category name is only a leak when it carries a number, which is what
    // makes it a sub-score rather than a heading. CW019 §3.1 sets the window at
    // 40 characters, either side; SCORE_NUMBER is what counts as a number.
    term: 'a CASS category with a score',
    pattern: new RegExp(
      String.raw`${SCORE_NUMBER}[\s\S]{0,40}?(?:${CATEGORIES})`
      + String.raw`|(?:${CATEGORIES})[\s\S]{0,40}?${SCORE_NUMBER}`,
      'i'
    ),
  },

  // -------------------------------------------------------------------------
  // TIER 2 — INTERNAL SOURCE. Blocked in company-visible fields.
  //
  // Note what is NOT here: the bare token CASS, "CASS pre-screen", "Companies
  // Assessment & Scoring System" and "our CASS framework" are all permitted
  // process description, and HELIX8 is the company's own submission and is
  // never flagged. Do not add a pattern that fires on the acronym alone.
  // -------------------------------------------------------------------------
  {
    tier: 'internal-source',
    term: 'an internal Taranis document',
    pattern:
      /\b(?:IC paper|IC Override|deal sourcing note|deal note|sourcing note|meeting note|assessment report|CASS reports?|CASS records?|CASS notes?)\b/i,
  },
  {
    tier: 'internal-source',
    term: 'a citation of CASS as a source',
    pattern: /\b(?:in|per|from|under)\s+CASS\b/i,
  },
  {
    tier: 'internal-source',
    term: 'the (internal) marker',
    pattern: /\(internal\)/i,
  },
];

/**
 * Every unsafe fragment in `value`, tagged by tier. Empty array means safe.
 *
 * Returns all hits rather than the first, so an author rewriting a sentence is
 * told everything wrong with it in one pass instead of one term per attempt.
 */
export function findCompanyUnsafeText(value) {
  if (value === null || value === undefined) return [];
  const text = String(value);
  if (!text.trim()) return [];

  const hits = [];
  for (const { tier, term, pattern } of COMPANY_UNSAFE_PATTERNS) {
    const found = pattern.exec(text);
    if (found) hits.push({ tier, term, match: found[0].trim() });
  }
  return hits;
}

/** True when `value` may be shown to a company. */
export function isCompanySafeText(value) {
  return findCompanyUnsafeText(value).length === 0;
}

/**
 * Throw `CompanyVisibleTextError` if `value` may not be shown to a company.
 *
 * `field` is the request field name, not the column name: the author typed
 * `alreadyHeld`, and telling them `already_held` makes them translate.
 */
export function assertCompanySafeText(field, value) {
  const [first] = findCompanyUnsafeText(value);
  if (first) throw new CompanyVisibleTextError(field, first);
  return value;
}

/**
 * The company-visible columns, as request-field name to database column.
 *
 * One list so the routes, the importer and the audit cannot disagree about
 * which fields are company-visible. `source_document` and `internal_note` are
 * absent by the decision recorded at the top of this file.
 */
export const COMPANY_VISIBLE_FIELDS = Object.freeze({
  alreadyHeld: 'already_held',
  noteForCompany: 'note_for_company',
});

/**
 * Check a whole IRL row. Used by the seed importer, the seed builder and the
 * export guard, all of which hold database or spreadsheet rows rather than
 * request bodies, and all of which report by `ref`.
 *
 * @returns {Array<{ref, field, tier, term, match}>} one entry per hit
 */
export function findUnsafeRowText(row = {}) {
  const problems = [];
  for (const column of Object.values(COMPANY_VISIBLE_FIELDS)) {
    for (const hit of findCompanyUnsafeText(row[column])) {
      problems.push({ ref: row.ref, field: column, ...hit });
    }
  }
  return problems;
}

/** One line a human can read, for a CLI, a log or an error body. */
export function describeUnsafe({ ref, field, term, match }) {
  return `${ref ? `ref ${ref}, ` : ''}${field}: ${term} ("${match}")`;
}
