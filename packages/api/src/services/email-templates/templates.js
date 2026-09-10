/**
 * The eleven approved templates.
 *
 * ---------------------------------------------------------------------------
 * DO NOT EDIT THE WORDING IN THIS FILE
 * ---------------------------------------------------------------------------
 * Every sentence below is reproduced verbatim from
 * `Taranis Dataroom/DD-Portal-Email-Templates-DRAFT-06Aug2026.md`, approved by
 * Mark on 6 August 2026. A wording change goes back through Cowork and returns
 * as an amended approved file; it is not the code side's to make, however
 * obvious the improvement looks (HANDOVER-CW011 §1, §5.6).
 *
 * `test/email-templates.test.js` asserts the approved text of `company-invite`
 * character for character against the strings here, so an accidental edit fails
 * the suite rather than reaching a counterparty.
 *
 * Placeholders in the approved file map to payload keys of the same name:
 * `{{first_name}}` is `payload.first_name`. Where the approved file uses
 * `{{#each files}}`, the payload carries an array; where it uses `{{#if}}`, the
 * block is emitted conditionally.
 *
 * WHICH OF THESE ARE ACTUALLY WIRED. Eight are triggered by Phase 1b. Two are
 * not: `new-comment` needs comments, which are not built, and
 * `reminder-outstanding` needs scheduled reminders, which are Phase 2. Both
 * ship here rendered and tested because the wording is approved now and because
 * a template with no caller is a smaller thing to carry than a template written
 * from memory in six months (HANDOVER-CW011 §3.5).
 *
 * THE ELEVENTH CAME THE OTHER WAY ROUND. `dd-digest` was drafted on the code
 * side, set out in full in HANDOVER-C020 §6, and approved by Mark on 2 September
 * 2026 as drafted. It is frozen now on exactly the same terms as the other ten;
 * the note at its own entry records the difference so nobody reads it as a
 * precedent. Its caller is additionally gated by `DD_DIGEST_ENABLED`, which is
 * an operational switch for where the digest sends, not a review gate.
 */
import { renderHtml, renderText } from './layout.js';

/** Formats an array of files for the upload and submission templates. */
function fileLines(files, { withSize }) {
  return (files || []).map((f) => {
    const size = withSize && f.size ? ` (${f.size})` : '';
    const item = [f.item_ref, f.item_description_short].filter(Boolean).join(' ');
    const description = f.description ? `, description: "${f.description}"` : '';
    return `${f.filename}${size}, ${item}${description}`;
  });
}

/**
 * Each template is `{ subject(payload), blocks(payload) }`.
 *
 * `blocks` returns the ordered block list defined in `layout.js`. Nothing here
 * builds HTML; escaping is the renderer's job, uniformly, for every value.
 */
export const TEMPLATES = {
  // 1 -------------------------------------------------------------------
  'company-invite': {
    description: 'To the invited user, when Taranis approves an invite or a nomination.',
    subject: () => 'Your access to the Taranis Capital Dataroom',
    blocks: (p) => [
      { p: `Dear ${p.first_name},` },
      { p: `${p.company_name} is engaged in a due diligence process with Taranis Capital, and you have been given access to the company's private workspace on the Taranis Capital Dataroom.` },
      { p: `Your workspace is where ${p.company_name} provides the documents and information requested during due diligence, tracks what is outstanding, and receives documents from Taranis. Access is personal to you and protected by two-step verification, which you will set up the first time you sign in.` },
      { button: { label: 'Accept your invitation', url: p.invite_url } },
      { p: `This link is personal to you, can be used once, and expires on ${p.invite_expiry_date}. If it has expired, ask ${p.inviter_name} or your Taranis contact to issue a new one.` },
      { signoff: true },
    ],
  },

  // 2 -------------------------------------------------------------------
  'nomination-pending': {
    description: 'To admin@taraniscapital.com, when a Company Administrator nominates a colleague.',
    subject: (p) => `Nomination awaiting approval: ${p.nominee_name} (${p.company_name})`,
    blocks: (p) => [
      { p: `${p.nominator_name} (${p.company_name}) has nominated a new portal user:` },
      {
        lines: [
          `Name: ${p.nominee_name}`,
          `Email: ${p.nominee_email}`,
          `Proposed role: ${p.proposed_role}`,
          `Domain check: ${p.domain_check_result}`,
        ],
      },
      { p: 'Review and approve or decline in the admin portal:' },
      { button: { label: 'Review nomination', url: p.admin_nomination_url } },
      { p: 'No invitation is sent until this nomination is approved.' },
    ],
  },

  // 3 -------------------------------------------------------------------
  'upload-notification': {
    description: 'To admin@taraniscapital.com, on any company upload. Per event, no digest (decision 8).',
    subject: (p) => `Upload: ${p.company_name}, ${p.file_count} file(s) against ${p.item_ref_or_additional}`,
    blocks: (p) => [
      { p: `${p.uploader_name} (${p.company_name}) has uploaded ${p.file_count} file(s):` },
      { lines: fileLines(p.files, { withSize: true }) },
      { p: 'State: staged, not yet formally submitted. You will receive a submission notice when the company confirms a batch.' },
      { button: { label: 'Open the review queue', url: p.admin_review_url } },
    ],
  },

  // 4 -------------------------------------------------------------------
  'submission-receipt': {
    description: 'To the submitting Company Administrator, on formal submission.',
    subject: (p) => `Submission receipt ${p.receipt_ref}: ${p.file_count} file(s) received by Taranis Capital`,
    blocks: (p) => [
      { p: `Dear ${p.first_name},` },
      { p: `This confirms that ${p.company_name} formally submitted the following to Taranis Capital on ${p.submitted_at_utc} (UTC), under receipt reference ${p.receipt_ref}:` },
      { lines: fileLines(p.files, { withSize: false }) },
      { p: 'Each file now carries the status Received and will move to In Review as the diligence team takes it up. You can follow progress at any time in your workspace.' },
      { p: 'This receipt is the formal record of the submission. Keep it with your transaction papers.' },
      { button: { label: 'View your receipts', url: p.company_receipts_url } },
      { signoff: true },
    ],
  },

  // 5 -------------------------------------------------------------------
  'submission-notification': {
    description: 'To admin@taraniscapital.com, on formal submission.',
    subject: (p) => `Submission ${p.receipt_ref}: ${p.company_name}, ${p.file_count} file(s)`,
    blocks: (p) => [
      { p: `${p.submitter_name} (${p.company_name}) has formally submitted batch ${p.receipt_ref}: ${p.file_count} file(s) across ${p.item_count} checklist item(s). All files are now Received and in the review queue.` },
      { button: { label: 'Open the review queue', url: p.admin_review_url } },
    ],
  },

  // 6 -------------------------------------------------------------------
  'status-attention': {
    description: 'To the uploader and the Company Administrator, when a file is set to Attention Needed.',
    subject: (p) => `Action needed on ${p.item_ref}: ${p.filename}`,
    blocks: (p) => [
      { p: `Dear ${p.first_name},` },
      { p: `The Taranis Capital diligence team has reviewed the following file and needs something from ${p.company_name} before it can be accepted:` },
      {
        lines: [
          `File: ${p.filename}`,
          `Checklist item: ${p.item_ref}, ${p.item_description_short}`,
          `Submitted: ${p.submitted_at} under receipt ${p.receipt_ref}`,
        ],
      },
      { p: 'Note from the review team:' },
      { quote: p.reviewer_note },
      { p: 'Please upload a revised or additional file against this item in your workspace. Your original file remains on record; a re-upload creates a new version rather than replacing history.' },
      { button: { label: 'Open this item', url: p.item_url } },
      { signoff: true },
    ],
  },

  // 7 -------------------------------------------------------------------
  'status-completed': {
    description: 'To the uploader and the Company Administrator, when a file is set to Completed.',
    subject: (p) => `Accepted: ${p.item_ref}, ${p.filename}`,
    blocks: (p) => [
      { p: `Dear ${p.first_name},` },
      { p: 'The following file has been reviewed and accepted for due diligence purposes:' },
      {
        lines: [
          `File: ${p.filename}`,
          `Checklist item: ${p.item_ref}, ${p.item_description_short}`,
        ],
      },
      { p: `${p.company_name}'s checklist now stands at ${p.progress_percent} complete, with ${p.outstanding_count} item(s) still outstanding. Thank you for keeping the process moving.` },
      { button: { label: 'View your progress', url: p.workspace_url } },
      { signoff: true },
    ],
  },

  // 8 -------------------------------------------------------------------
  // NOT WIRED. Comments are not built; this ships rendered and tested only.
  'new-comment': {
    description: 'To the other side of the thread, on a non-internal comment. NOT WIRED: comments are Phase 2.',
    wired: false,
    subject: (p) => `New comment on ${p.item_ref}: ${p.item_description_short}`,
    blocks: (p) => [
      { p: `${p.author_name} has commented on checklist item ${p.item_ref}:` },
      { quote: p.comment_body },
      { p: 'Reply in the workspace so the exchange stays on the record against the item.' },
      { button: { label: 'Open the thread', url: p.item_url } },
    ],
  },

  // 9 -------------------------------------------------------------------
  'new-items': {
    description: 'To company users, when new checklist items are pushed to the company.',
    subject: (p) => `${p.new_item_count} new item(s) added to your information request`,
    blocks: (p) => [
      { p: `Dear ${p.first_name},` },
      { p: `Taranis Capital has added ${p.new_item_count} item(s) to ${p.company_name}'s information request list:` },
      {
        lines: (p.items || []).map(
          (i) => `${i.ref}, ${i.description_short} (priority: ${i.priority})`
        ),
      },
      p.note_for_company ? { p: `Note from the team: ${p.note_for_company}` } : null,
      { button: { label: 'View the updated checklist', url: p.workspace_url } },
      { signoff: true },
    ],
  },

  // 10 ------------------------------------------------------------------
  // NOT WIRED. Scheduled reminders are Phase 2.
  'reminder-outstanding': {
    description: 'To company users, on a scheduled reminder. NOT WIRED: scheduling is Phase 2.',
    wired: false,
    subject: (p) => `Reminder: ${p.outstanding_high_count} high priority item(s) outstanding`,
    blocks: (p) => [
      { p: `Dear ${p.first_name},` },
      { p: `A gentle reminder that ${p.company_name}'s information request list has ${p.outstanding_high_count} high priority item(s) still outstanding, of ${p.outstanding_total_count} outstanding in total. High priority sections cover intellectual property, financial, legal and AML/KYC material, which the diligence team needs earliest.` },
      { p: `If any item does not apply to ${p.company_name}, or will take time to prepare, let us know through the comments on that item; a credible date is always better than silence.` },
      { button: { label: 'View outstanding items', url: p.workspace_url } },
      { signoff: true },
    ],
  },

  // 11 ------------------------------------------------------------------
  // APPROVED BY MARK, 2 SEPTEMBER 2026, as drafted. Now frozen on the same
  // terms as the ten above it: a change comes back through Cowork as an amended
  // approved wording and is not the code side's to make.
  //
  // Its provenance differs from theirs and the difference is worth keeping.
  // The other ten were approved wording that the code implemented; this one was
  // drafted on the code side, set out in full in HANDOVER-C020 §6 for review,
  // and approved there. That is the exception, not a new way of working.
  //
  // Internal, to admin@taraniscapital.com, so no 'Dear' and no signoff, the
  // same shape as 'nomination-pending' and 'submission-notification'.
  'dd-digest': {
    description:
      'To ADMIN_NOTIFICATION_EMAIL, once each weekday morning when either bucket is '
      + 'non-empty. Approved 2 September 2026; sends only where DD_DIGEST_ENABLED is set.',
    subject: (p) =>
      `Due diligence: ${p.awaiting_taranis_count} awaiting Taranis, `
      + `${p.awaiting_company_count} awaiting companies`,
    blocks: (p) => [
      { p: `Outstanding due diligence actions as at the morning of ${p.digest_date}.` },
      {
        lines: [
          `Awaiting Taranis: ${p.awaiting_taranis_count}`,
          `Awaiting companies: ${p.awaiting_company_count}`,
        ],
      },
      { lines: p.company_lines },
      {
        p: `An item is flagged amber after ${p.taranis_amber_days} working day(s) with `
         + `Taranis and red after ${p.taranis_red_days}. On the company side the flags are `
         + `${p.company_amber_days} and ${p.company_red_days} calendar days, counted from `
         + `the date the company was asked for something specific. Checklist items nobody `
         + `has started are counted but not aged.`,
      },
      { button: { label: 'Open the dashboard', url: p.dashboard_url } },
    ],
  },
};

/** Every template id, in the order of the approved file. */
export const TEMPLATE_IDS = Object.keys(TEMPLATES);

/** Thrown when a row names a template that does not exist. */
export class UnknownTemplateError extends Error {
  constructor(id) {
    super(`Unknown email template: ${id}`);
    this.name = 'UnknownTemplateError';
    this.code = 'UNKNOWN_TEMPLATE';
    this.template = id;
  }
}

/**
 * Render one template to `{ subject, html, text }`.
 *
 * Throws on an unknown template rather than returning an empty message. An
 * outbox row naming a template that no longer exists is a bug in a rename, and
 * the worker records it as `last_error` on the row where it can be found; a
 * blank email to a counterparty could not be found at all.
 */
export function renderTemplate(id, payload = {}, { env } = {}) {
  const template = TEMPLATES[id];
  if (!template) throw new UnknownTemplateError(id);

  const subject = template.subject(payload);
  const blocks = template.blocks(payload).filter(Boolean);

  return {
    subject,
    html: renderHtml(blocks, { subject, env }),
    text: renderText(blocks),
  };
}
