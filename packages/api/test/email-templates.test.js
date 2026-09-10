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

    // The two session-digest drafts (HANDOVER-C025 §6).
    reviewed_count: 3,
    attention_count: 1,
    accepted_count: 2,
    attention_files: [{
      filename: 'accounts-2024.pdf', item_ref: '3.2', item_description_short: 'Audited accounts',
      submitted_at: '10 August 2026 at 14:03', receipt_ref: 'TCR-2026-0007',
      reviewer_note: 'This is the 2024 set. Please send 2025.',
    }],
    accepted_files: [
      { filename: 'register.pdf', item_ref: '1.4', item_description_short: 'Shareholder register', reviewer_note: null },
      { filename: 'vegan.pdf', item_ref: '10.5', item_description_short: 'Certificates', reviewer_note: 'Expires 12 September; please upload the renewal.' },
    ],
    uploader_names: 'Alex Fenn and Sam Patel',
    submitted_count: 1,
    staged_count: 1,
    removed_count: 0,

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

test('the digest template follows the ten, and is wired', () => {
  assert.equal(TEMPLATE_IDS[10], 'dd-digest');
  // Unlike `new-comment` and `reminder-outstanding` this one has a caller, so
  // it carries no `wired: false` marker.
  assert.equal(TEMPLATES['dd-digest'].wired, undefined);
});

test('the two session-digest drafts come last, and are wired', () => {
  // HANDOVER-CW025. Drafted on the code side like `dd-digest`, set out in
  // HANDOVER-C025 §6, and to be approved before merge because digests are on
  // from the moment they deploy.
  assert.equal(TEMPLATE_IDS.length, 13);
  assert.deepEqual(TEMPLATE_IDS.slice(11), ['status-digest', 'upload-digest']);
  assert.equal(TEMPLATES['status-digest'].wired, undefined);
  assert.equal(TEMPLATES['upload-digest'].wired, undefined);
});

test('the digest wording is frozen, as approved on 2 September 2026', () => {
  // The same protection `company-invite` gets below, and for the same reason:
  // this is approved copy now, so an edit has to fail the suite rather than
  // reach an inbox. It was drafted on the code side and approved in
  // HANDOVER-C020 §6, which is the exception to how the other ten arrived, not
  // a licence to reword this one in passing.
  const { subject, text } = renderTemplate('dd-digest', fullPayload());

  assert.equal(subject, 'Due diligence: 6 awaiting Taranis, 3 awaiting companies');

  assert.ok(text.includes(
    'Outstanding due diligence actions as at the morning of 2 September 2026.'
  ));
  assert.ok(text.includes('Awaiting Taranis: 6\nAwaiting companies: 3'));
  assert.ok(text.includes(
    'Example Bio Ltd, Biotech KSA: 6 awaiting Taranis (4 to open, 2 in review).'
  ));
  assert.ok(text.includes(
    'An item is flagged amber after 1 working day(s) with Taranis and red after 3. '
    + 'On the company side the flags are 3 and 7 calendar days, counted from the date '
    + 'the company was asked for something specific. Checklist items nobody has started '
    + 'are counted but not aged.'
  ));
  assert.ok(text.includes(
    'Open the dashboard: https://dataroom.taraniscapital.com/dashboard'
  ));

  // Internal, to the admin address, so it opens with no greeting and closes
  // with no sign-off, matching the other two that go there.
  assert.equal(text.startsWith('Outstanding due diligence actions'), true);
  assert.equal(text.includes('Kind regards'), false);
  // UK English, no em dashes in anything a person reads.
  assert.equal(text.includes('—'), false);
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

// ---------------------------------------------------------------------------
// The session-digest drafts (HANDOVER-C025 §6)
//
// Asserted as literals like the approved ten, so the wording Mark approves is
// the wording that ships and any later edit is a deliberate one.
// ---------------------------------------------------------------------------

test('status-digest subject says what the sitting contains', () => {
  const subjectOf = (p) => renderTemplate('status-digest', fullPayload(p)).subject;
  assert.equal(subjectOf({}), 'Review update: action needed on 1 file(s), 2 accepted');
  assert.equal(
    subjectOf({ accepted_count: 0, accepted_files: [] }),
    'Review update: action needed on 1 file(s)'
  );
  assert.equal(
    subjectOf({ attention_count: 0, attention_files: [] }),
    'Review update: 2 file(s) accepted'
  );
});

test('status-digest body matches the draft, attention first, every note quoted', () => {
  const { text } = renderTemplate('status-digest', fullPayload());

  assert.ok(text.startsWith('Dear Alex,'));
  assert.ok(text.includes(
    'The Taranis Capital diligence team has reviewed 3 file(s) submitted by Example Bio Ltd. '
    + 'The outcome for each is set out below.'
  ));
  assert.ok(text.includes(
    'These 1 file(s) need something from Example Bio Ltd before they can be accepted:'
  ));
  assert.ok(text.includes(
    'File: accounts-2024.pdf\nChecklist item: 3.2, Audited accounts\n'
    + 'Submitted: 10 August 2026 at 14:03 under receipt TCR-2026-0007'
  ));
  assert.ok(text.includes('> This is the 2024 set. Please send 2025.'));
  assert.ok(text.includes(
    'Please upload a revised or additional file against each of these items in your '
    + 'workspace. Your original files remain on record; a re-upload creates a new version '
    + 'rather than replacing history.'
  ));
  assert.ok(text.includes(
    'These 2 file(s) have been reviewed and accepted for due diligence purposes:'
  ));
  // Tight lines, broken only where an acceptance carries a note, which sits
  // directly under its file.
  assert.ok(text.includes(
    '1.4, Shareholder register: register.pdf\n10.5, Certificates: vegan.pdf\n\n'
    + '> Expires 12 September; please upload the renewal.'
  ));
  assert.ok(text.includes(
    "Example Bio Ltd's checklist now stands at 64% complete, with 12 item(s) still "
    + 'outstanding. Thank you for keeping the process moving.'
  ));
  assert.ok(text.includes('Open your workspace: https://dataroom.taraniscapital.com/company'));
  assert.ok(text.includes('Kind regards\nTaranis Capital'));

  // Attention before accepted, because that is the part that asks for action.
  assert.ok(text.indexOf('need something from') < text.indexOf('have been reviewed and accepted'));
});

test('status-digest leaves out a section the sitting has nothing for', () => {
  const acceptedOnly = renderTemplate('status-digest', fullPayload({
    attention_count: 0, attention_files: [],
  })).text;
  assert.ok(!acceptedOnly.includes('need something from'));
  assert.ok(!acceptedOnly.includes('Please upload a revised'));

  const attentionOnly = renderTemplate('status-digest', fullPayload({
    accepted_count: 0, accepted_files: [],
  })).text;
  assert.ok(!attentionOnly.includes('have been reviewed and accepted'));
  // Progress is always stated: a flag still moves the figure.
  assert.ok(attentionOnly.includes("checklist now stands at 64% complete"));
});

test('a file sent as additional material says so rather than printing an empty item', () => {
  const { text } = renderTemplate('status-digest', fullPayload({
    attention_files: [{
      filename: 'extra.pdf', item_ref: '', item_description_short: '',
      submitted_at: '10 August 2026 at 14:03', receipt_ref: 'TCR-2026-0007', reviewer_note: 'Which item is this for?',
    }],
  }));
  assert.ok(text.includes('Checklist item: additional material'));
  assert.ok(!text.includes('Checklist item: ,'));
});

test('upload-digest matches the draft and gives each file its state', () => {
  const { subject, text } = renderTemplate('upload-digest', fullPayload({
    file_count: 3,
    files: [
      { filename: 'a.pdf', size: '1.2 MB', item_ref: '3.2', item_description_short: 'Audited accounts', description: 'FY2025', state: 'submitted', receipt_ref: 'TRN-DD-2026-000031' },
      { filename: 'b.pdf', size: '20 KB', item_ref: '1.4', item_description_short: 'Register', description: 'Current', state: 'staged', receipt_ref: '' },
      { filename: 'c.png', size: '3 KB', item_ref: '', item_description_short: '', description: 'Logo', state: 'removed', receipt_ref: '' },
    ],
  }));

  assert.equal(subject, 'Uploads: Example Bio Ltd, 3 file(s)');
  assert.ok(text.startsWith('Alex Fenn and Sam Patel (Example Bio Ltd) uploaded 3 file(s):'));
  assert.ok(text.includes(
    'a.pdf (1.2 MB), 3.2 Audited accounts, description: "FY2025". Submitted under receipt TRN-DD-2026-000031.'
  ));
  assert.ok(text.includes(
    'b.pdf (20 KB), 1.4 Register, description: "Current". Staged, not yet submitted.'
  ));
  assert.ok(text.includes(
    'c.png (3 KB), additional material, description: "Logo". Removed by the company before submission.'
  ));
  assert.ok(text.includes(
    '1 file(s) have since been formally submitted and are in the review queue. '
    + '1 file(s) are still staged and not yet submitted; you will receive a submission '
    + 'notice when the company confirms a batch.'
  ));
  assert.ok(text.includes('Open the review queue: https://dataroom.taraniscapital.com/admin/review-queue'));
  // Internal, like upload-notification: no greeting, no sign-off.
  assert.equal(text.includes('Dear '), false);
  assert.equal(text.includes('Kind regards'), false);
});

test('upload-digest closing line follows what the list contains', () => {
  const closing = (p) => renderTemplate('upload-digest', fullPayload(p)).text;

  assert.ok(closing({ file_count: 2, submitted_count: 2, staged_count: 0 }).includes(
    'All of these have since been formally submitted and are in the review queue.'
  ));
  assert.ok(closing({ file_count: 2, submitted_count: 0, staged_count: 2 }).includes(
    'None of these has been formally submitted yet. You will receive a submission notice '
    + 'when the company confirms a batch.'
  ));
  // Everything removed: the lines say so, and no closing claim is made.
  const allRemoved = closing({ file_count: 1, submitted_count: 0, staged_count: 0, removed_count: 1 });
  assert.ok(!allRemoved.includes('formally submitted'));
});

test('neither digest draft uses an em dash or leaves a placeholder', () => {
  for (const id of ['status-digest', 'upload-digest']) {
    const { subject, text, html } = renderTemplate(id, fullPayload());
    const body = text.split('\n---\n')[0];
    assert.ok(!subject.includes('—') && !body.includes('—'), `${id} has an em dash`);
    assert.ok(!html.includes('undefined') && !html.includes('null'), `${id} rendered a missing value`);
  }
});
