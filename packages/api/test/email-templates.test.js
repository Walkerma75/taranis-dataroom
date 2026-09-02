/**
 * The ten approved templates.
 *
 * The point of this file is that the wording is frozen. HANDOVER-CW011 §4 asks
 * for the rendered `company-invite` to match the approved file character for
 * character, and the approved sentences are asserted here as literals, so an
 * edit to `templates.js` fails the suite rather than reaching a counterparty.
 *
 * The other thing it protects is the rule that no internal note may ever reach
 * a company-facing message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPLATES,
  TEMPLATE_IDS,
  renderTemplate,
  UnknownTemplateError,
  COMMON_FOOTER,
} from '../src/services/email-templates/index.js';

/** A payload carrying every key any of the ten templates reads. */
function fullPayload(overrides = {}) {
  return {
    first_name: 'Alex',
    company_name: 'Example Bio Ltd',
    invite_url: 'https://dataroom.taraniscapital.com/invite/accept?token=abc',
    invite_expiry_date: '17 August 2026',
    inviter_name: 'Mark Walker',

    nominee_name: 'Sam Patel',
    nominee_email: 'sam@examplebio.com',
    nominator_name: 'Alex Fenn',
    proposed_role: 'Contributor',
    domain_check_result: "Matched the company's registered domain (examplebio.com)",
    admin_nomination_url: 'https://dataroom.taraniscapital.com/admin/companies/c-1',

    uploader_name: 'Alex Fenn',
    file_count: 2,
    item_ref_or_additional: '3.2',
    admin_review_url: 'https://dataroom.taraniscapital.com/admin/review-queue',
    files: [
      { filename: 'accounts-2025.pdf', size: '1.2 MB', item_ref: '3.2', item_description_short: 'Audited accounts', description: 'FY2025' },
    ],

    receipt_ref: 'TCR-2026-0007',
    submitted_at_utc: '10 August 2026 at 14:03',
    company_receipts_url: 'https://dataroom.taraniscapital.com/company/receipts',
    submitter_name: 'Alex Fenn',
    item_count: 1,

    filename: 'accounts-2025.pdf',
    item_ref: '3.2',
    item_description_short: 'Audited accounts',
    submitted_at: '10 August 2026 at 14:03',
    reviewer_note: 'The 2025 accounts are unsigned. Please send the signed set.',
    item_url: 'https://dataroom.taraniscapital.com/company/items/i-1',

    progress_percent: '64%',
    outstanding_count: 12,
    workspace_url: 'https://dataroom.taraniscapital.com/company',

    author_name: 'Mark Walker',
    comment_body: 'Noted, thank you.',

    new_item_count: 1,
    items: [{ ref: '5.4', description_short: 'Board minutes', priority: 'high' }],
    note_for_company: null,

    outstanding_high_count: 4,
    outstanding_total_count: 12,

    // The draft digest (CW020 §3.5).
    digest_date: '2 September 2026',
    awaiting_taranis_count: 6,
    awaiting_company_count: 3,
    company_lines: ['Example Bio Ltd, Biotech KSA: 6 awaiting Taranis (4 to open, 2 in review).'],
    taranis_amber_days: 1,
    taranis_red_days: 3,
    company_amber_days: 3,
    company_red_days: 7,
    dashboard_url: 'https://dataroom.taraniscapital.com/dashboard',

    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// All ten exist and render
// ---------------------------------------------------------------------------

test('all ten approved templates are present, in the order of the approved file', () => {
  // The eleventh, `dd-digest`, is a DRAFT and is deliberately not part of this
  // list: this assertion is about the approved file, and the draft is not in it.
  // It is asserted separately below, and it stays out of the approved order
  // until Mark's wording comes back through Cowork.
  assert.deepEqual(TEMPLATE_IDS.slice(0, 10), [
    'company-invite',
    'nomination-pending',
    'upload-notification',
    'submission-receipt',
    'submission-notification',
    'status-attention',
    'status-completed',
    'new-comment',
    'new-items',
    'reminder-outstanding',
  ]);
});

test('the draft digest template is present, marked unwired, and last', () => {
  assert.equal(TEMPLATE_IDS.length, 11);
  assert.equal(TEMPLATE_IDS[10], 'dd-digest');
  // `wired: false` is the marker the other two unapproved-or-uncalled templates
  // carry. Losing it is how a draft quietly becomes something nobody rechecks.
  assert.equal(TEMPLATES['dd-digest'].wired, false);
});

test('every template renders a subject, an HTML part and a plain-text part', () => {
  for (const id of TEMPLATE_IDS) {
    const { subject, html, text } = renderTemplate(id, fullPayload());
    assert.ok(subject.length > 0, `${id} rendered no subject`);
    assert.ok(html.includes('<!doctype html>'), `${id} rendered no HTML document`);
    assert.ok(text.length > 0, `${id} rendered no text part`);
    // Nothing may reach a recipient with an unresolved placeholder in it.
    assert.ok(!html.includes('{{'), `${id} left a placeholder in the HTML`);
    assert.ok(!text.includes('{{'), `${id} left a placeholder in the text`);
    assert.ok(!html.includes('undefined'), `${id} rendered 'undefined' into the HTML`);
  }
});

test('the common footer is on every message, in both parts', () => {
  for (const id of TEMPLATE_IDS) {
    const { html, text } = renderTemplate(id, fullPayload());
    assert.ok(text.includes(COMMON_FOOTER), `${id} is missing the footer in the text part`);
    // The HTML part carries it escaped, so compare on a distinctive fragment
    // that contains no escapable character.
    assert.ok(
      html.includes('private, invite-only portal'),
      `${id} is missing the footer in the HTML part`
    );
  }
});

test('two templates ship deliberately unwired', () => {
  assert.equal(TEMPLATES['new-comment'].wired, false);
  assert.equal(TEMPLATES['reminder-outstanding'].wired, false);
});

test('an unknown template throws rather than rendering an empty message', () => {
  assert.throws(() => renderTemplate('no-such-template', {}), UnknownTemplateError);
});

// ---------------------------------------------------------------------------
// The approved wording, character for character (HANDOVER-CW011 §4)
// ---------------------------------------------------------------------------

test('company-invite matches the approved wording character for character', () => {
  const { subject, text } = renderTemplate('company-invite', fullPayload());

  assert.equal(subject, 'Your access to the Taranis Capital Dataroom');

  assert.ok(text.includes('Dear Alex,'));
  assert.ok(text.includes(
    'Example Bio Ltd is engaged in a due diligence process with Taranis Capital, '
    + "and you have been given access to the company's private workspace on the "
    + 'Taranis Capital Dataroom.'
  ));
  assert.ok(text.includes(
    'Your workspace is where Example Bio Ltd provides the documents and '
    + 'information requested during due diligence, tracks what is outstanding, '
    + 'and receives documents from Taranis. Access is personal to you and '
    + 'protected by two-step verification, which you will set up the first time '
    + 'you sign in.'
  ));
  assert.ok(text.includes(
    'This link is personal to you, can be used once, and expires on 17 August '
    + '2026. If it has expired, ask Mark Walker or your Taranis contact to issue '
    + 'a new one.'
  ));
  assert.ok(text.includes('Kind regards\nTaranis Capital'));
  assert.ok(text.includes(COMMON_FOOTER));
});

test('the approved subjects are exact', () => {
  const p = fullPayload();
  const subjectOf = (id) => renderTemplate(id, p).subject;

  assert.equal(subjectOf('nomination-pending'), 'Nomination awaiting approval: Sam Patel (Example Bio Ltd)');
  assert.equal(subjectOf('upload-notification'), 'Upload: Example Bio Ltd, 2 file(s) against 3.2');
  assert.equal(subjectOf('submission-receipt'), 'Submission receipt TCR-2026-0007: 2 file(s) received by Taranis Capital');
  assert.equal(subjectOf('submission-notification'), 'Submission TCR-2026-0007: Example Bio Ltd, 2 file(s)');
  assert.equal(subjectOf('status-attention'), 'Action needed on 3.2: accounts-2025.pdf');
  assert.equal(subjectOf('status-completed'), 'Accepted: 3.2, accounts-2025.pdf');
  assert.equal(subjectOf('new-comment'), 'New comment on 3.2: Audited accounts');
  assert.equal(subjectOf('new-items'), '1 new item(s) added to your information request');
  assert.equal(subjectOf('reminder-outstanding'), 'Reminder: 4 high priority item(s) outstanding');
});

test('no template uses an em dash', () => {
  // A house rule on the approved file, and the sort of thing an editor
  // introduces without noticing.
  for (const id of TEMPLATE_IDS) {
    const { subject, text } = renderTemplate(id, fullPayload());
    assert.ok(!subject.includes('—'), `${id} has an em dash in its subject`);
    // The text part's own separator rule is three hyphens, not a dash.
    const body = text.split('\n---\n')[0];
    assert.ok(!body.includes('—'), `${id} has an em dash in its body`);
  }
});

// ---------------------------------------------------------------------------
// The reviewer note goes out; an internal note never does
// ---------------------------------------------------------------------------

test('status-attention carries the reviewer note as the heart of the message', () => {
  const { text, html } = renderTemplate('status-attention', fullPayload());
  assert.ok(text.includes('Note from the review team:'));
  assert.ok(text.includes('> The 2025 accounts are unsigned. Please send the signed set.'));
  assert.ok(html.includes('The 2025 accounts are unsigned. Please send the signed set.'));
});

test('an internal note in a payload never reaches a company-facing message', () => {
  // The routes never put `internal_note` in a payload — the item lookups name
  // their columns precisely so it cannot be spread in. This asserts the second
  // line of defence: even handed one, no template reads it.
  const poisoned = fullPayload({
    internal_note: 'IEMS screen flagged the CFO; do not tell the company',
    note: 'IEMS screen flagged the CFO; do not tell the company',
  });

  for (const id of TEMPLATE_IDS) {
    const { subject, html, text } = renderTemplate(id, poisoned);
    for (const part of [subject, html, text]) {
      assert.ok(
        !part.includes('IEMS screen flagged'),
        `${id} leaked an internal note into a company-facing message`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Escaping and buttons
// ---------------------------------------------------------------------------

test('counterparty-supplied text is escaped in the HTML part', () => {
  const { html, text } = renderTemplate('status-attention', fullPayload({
    filename: '<script>alert(1)</script>.pdf',
    reviewer_note: 'Use "quotes" & ampersands <b>boldly</b>',
  }));

  assert.ok(!html.includes('<script>'), 'a filename was rendered as live markup');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&amp;'));
  assert.ok(!html.includes('<b>boldly</b>'), 'a reviewer note was rendered as live markup');
  // The plain-text part is not markup and must NOT be escaped: a company
  // reading '&amp;' in a filename would be a defect of its own.
  assert.ok(text.includes('<script>alert(1)</script>.pdf'));
  assert.ok(text.includes('Use "quotes" & ampersands'));
});

test('the plain-text part renders every button as a label and a URL', () => {
  const { text } = renderTemplate('company-invite', fullPayload());
  assert.ok(text.includes(
    'Accept your invitation: https://dataroom.taraniscapital.com/invite/accept?token=abc'
  ));
});

test('a button URL that is not http(s) renders dead rather than live', () => {
  const { html } = renderTemplate('company-invite', fullPayload({
    invite_url: 'javascript:alert(1)',
  }));
  assert.ok(!html.includes('javascript:'), 'a javascript: URL reached an href');
  // The label survives so the message still reads and the fault is visible.
  assert.ok(html.includes('Accept your invitation'));
});

test('the header band carries the wordmark when no logo URL is configured', () => {
  const { html } = renderTemplate('company-invite', fullPayload(), { env: {} });
  assert.ok(html.includes('TARANIS CAPITAL'));
  assert.ok(!html.includes('<img'), 'a remote image was rendered with no logo configured');

  const withLogo = renderTemplate('company-invite', fullPayload(), {
    env: { EMAIL_LOGO_URL: 'https://example.com/logo.png' },
  });
  assert.ok(withLogo.html.includes('<img src="https://example.com/logo.png"'));
});

test('the conditional note in new-items appears only when there is one', () => {
  const without = renderTemplate('new-items', fullPayload()).text;
  assert.ok(!without.includes('Note from the team'));

  const withNote = renderTemplate('new-items', fullPayload({
    note_for_company: 'These follow the 6 August call.',
  })).text;
  assert.ok(withNote.includes('Note from the team: These follow the 6 August call.'));
});
