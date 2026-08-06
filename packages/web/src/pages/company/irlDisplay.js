/**
 * Shared display rules for the DD portal screens.
 *
 * Chip colours are fixed by the code brief §7.1 and are used on both sides, so
 * a reviewer and a company user are looking at the same colour for the same
 * state. UK English throughout, and no em dashes in anything user-facing.
 */

export const STATE_LABELS = {
  outstanding: 'Outstanding',
  partially_held: 'Partially held',
  held: 'Held',
  received: 'Received',
  in_review: 'In review',
  attention_needed: 'Attention needed',
  completed: 'Completed',
  not_applicable: 'Not applicable',
};

export const STATE_COLOURS = {
  outstanding: '#BFBFBF',
  partially_held: '#D8B44A',
  held: '#3A5247',
  received: '#8C8C8C',
  in_review: '#C9A84C',
  attention_needed: '#B54A32',
  completed: '#3A5247',
  not_applicable: '#D9D9D9',
};

export const PRIORITY_LABELS = {
  high: 'High',
  medium: 'Medium',
  standard: 'Standard',
};

export const PRIORITY_COLOURS = {
  high: '#B54A32',
  medium: '#C9A84C',
  standard: '#8C8C8C',
};

export const COMPANY_ROLE_LABELS = {
  company_admin: 'Administrator',
  company_contributor: 'Contributor',
  company_viewer: 'Viewer',
};

export const COMPANY_STATUS_LABELS = {
  pending: 'Pending',
  active: 'Active',
  suspended: 'Suspended',
  offboarded: 'Offboarded',
};

/**
 * Why the invite controls are disabled, or null when they are not.
 *
 * The server refuses an invitation to any company that is not active, so this
 * is the courtesy that stops an admin discovering the rule by hitting it. The
 * button is disabled and explained rather than hidden, so the reason is learnt
 * rather than hunted for (HANDOVER-CW005 §3).
 */
export function inviteBlockedReason(status) {
  if (status === 'active') return null;
  if (status === 'suspended' || status === 'offboarded') {
    return "This company's access is closed, so nobody can be invited.";
  }
  return 'Activate the company first. Its users see nothing until then.';
}

/**
 * Nomination display rules.
 *
 * A nomination is now shown in two places: inside the company, on
 * CompanyDetailPage's Users tab, and across all companies on the admin Users
 * page. The predicate, the label, the colour and the warning copy live here so
 * there is exactly one of each. Two copies that drifted would be worse than the
 * gap they close: an admin would see the same person flagged off-domain on one
 * screen and clean on the other, with no way to tell which was right.
 *
 * Approving still happens in one place only, inside the company. Nothing here
 * approves anything.
 */
export const OFF_DOMAIN_COLOUR = '#C9A84C';
export const OFF_DOMAIN_LABEL = 'Off-domain';
export const OFF_DOMAIN_WARNING = 'A nomination is on an unrecognised email domain';
export const OFF_DOMAIN_WARNING_DETAIL = 'Check who this person is before approving the nomination.';

/**
 * True only for a real mismatch. `domainMatched` is NULL when the company
 * records no domains at all, and that is not a mismatch.
 */
export function isOffDomain(member) {
  return member?.domainMatched === false;
}

/** A membership the company created that Taranis has not yet actioned. */
export function isPendingNomination(member) {
  return !!member && !member.approved && !member.deactivatedAt;
}

/** Accepted upload types, matching the server-side allow-list. */
export const ACCEPTED_UPLOAD_TYPES =
  '.pdf,.docx,.xlsx,.pptx,.csv,.txt,.png,.jpg,.jpeg,.zip';

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Format a timestamp in UTC, and mean it.
 *
 * Receipts and submission times are quoted back in correspondence between two
 * parties in different time zones, so they are shown in UTC and labelled. This
 * builds the string from the UTC parts rather than formatting a local date and
 * calling it UTC, which is the mistake that makes a receipt an hour wrong for
 * half the year.
 */
export function formatUtc(value, { long = false } = {}) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const month = long ? MONTHS[d.getUTCMonth()] : MONTHS[d.getUTCMonth()].slice(0, 3);
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()} `
       + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function formatBytes(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Group checklist items by their section, preserving sort order. */
export function groupBySection(items = []) {
  const sections = new Map();
  for (const item of items) {
    if (!sections.has(item.section)) sections.set(item.section, []);
    sections.get(item.section).push(item);
  }
  return [...sections.entries()].map(([section, sectionItems]) => ({ section, items: sectionItems }));
}
