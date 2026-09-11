/**
 * The shared frame every platform email is rendered into, and the block
 * renderer the ten templates are written against.
 *
 * ---------------------------------------------------------------------------
 * THE WORDING IN `templates.js` IS APPROVED AND FROZEN
 * ---------------------------------------------------------------------------
 * Mark approved all ten templates verbatim on 6 August 2026
 * (`DD-Portal-Email-Templates-DRAFT-06Aug2026.md`). Any wording change goes
 * back through Cowork and is not the code side's to make (HANDOVER-CW011 §1).
 * That is why the templates are literal strings in this codebase rather than
 * rows in a table an administrator can edit: there is one source of truth for
 * the wording and it is reviewable in a diff.
 *
 * WHY BLOCKS RATHER THAN A TEMPLATE ENGINE. The approved file uses
 * `{{placeholder}}`, `{{#each}}` and `{{#if}}` notation, which reads like
 * Handlebars. Adding a template engine to render nine paragraphs would mean a
 * new dependency, a second escaping model to get right, and a class of failure
 * where a malformed template renders as an empty message rather than failing.
 * Instead each template is a function returning an ordered list of blocks, and
 * this module renders that list twice: once to HTML, once to plain text. The
 * approved sentences appear in the source as ordinary string literals, so
 * checking the implementation against the approved file is reading, not
 * evaluating.
 *
 * BLOCK TYPES
 *   { p: string }                  a paragraph
 *   { lines: string[] }            tight consecutive lines (Name: x, file lists)
 *   { quote: string }              a quoted block (a reviewer note, a comment)
 *   { button: { label, url } }     a call to action
 *   { signoff: true }              'Kind regards' / 'Taranis Capital'
 *
 * A falsy block is dropped, so a template can write
 * `note ? { p: ... } : null` for the one conditional the approved file has.
 *
 * ESCAPING. Every interpolated value reaches this module as a plain string and
 * is escaped here. That matters more than it looks: filenames, file
 * descriptions, nominee names and reviewer notes are all counterparty-supplied
 * or reviewer-supplied text that ends up in an HTML document sent to a third
 * party. Templates must never build HTML themselves, and none do.
 */

/** Taranis green, the header band. */
export const BRAND_GREEN = '#2C3E35';
/** Taranis gold, the buttons. */
export const BRAND_GOLD = '#C9A84C';
/** Footer grey. */
export const FOOTER_GREY = '#6B7280';

/**
 * The common footer, on every message, approved verbatim. Reproduced here as
 * one string and used by every template, so it cannot drift between them.
 */
export const COMMON_FOOTER =
  'This message relates to your account on the Taranis Capital Dataroom, a '
  + 'private, invite-only portal. It was sent to you as a named party to a due '
  + 'diligence exchange under a non-disclosure agreement. If you believe you '
  + 'have received it in error, contact admin@taraniscapital.com and delete it. '
  + 'Please do not reply to this address; it is not monitored.';

/** The sender, confirmed final in HANDOVER-C003 §5.5 decision 4. */
export const SENDER_NAME = 'Taranis Capital Dataroom';
export const SENDER_ADDRESS = 'notifications@mail.taraniscapital.com';

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape a URL for an `href`.
 *
 * Refuses anything that is not http or https. A button is the one place a
 * payload value becomes something a recipient clicks, and a `javascript:` or
 * `data:` URL arriving through a payload should produce a dead button rather
 * than a live one. Every URL we build comes from `services/links.js` and is
 * already absolute; this is the belt to that braces.
 */
export function safeUrl(url) {
  const raw = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  return escapeHtml(raw);
}

function blockToHtml(block) {
  if (block.p !== undefined) {
    return `<p style="margin:0 0 16px;">${escapeHtml(block.p)}</p>`;
  }

  if (block.lines !== undefined) {
    const lines = block.lines
      .filter((line) => line !== null && line !== undefined && line !== '')
      .map((line) => escapeHtml(line))
      .join('<br />');
    return `<p style="margin:0 0 16px;">${lines}</p>`;
  }

  if (block.quote !== undefined) {
    return (
      `<blockquote style="margin:0 0 16px;padding:12px 16px;`
      + `border-left:3px solid ${BRAND_GOLD};background:#F7F6F3;`
      + `color:#1F2937;">${escapeHtml(block.quote)}</blockquote>`
    );
  }

  if (block.button !== undefined) {
    const href = safeUrl(block.button.url);
    const label = escapeHtml(block.button.label);
    // A dead button is better than a live one pointing somewhere unexpected,
    // but it must not be invisible: render the label as plain text so the
    // message still makes sense and the fault is obvious.
    if (!href) return `<p style="margin:0 0 16px;"><strong>${label}</strong></p>`;
    return (
      `<p style="margin:24px 0;">`
      + `<a href="${href}" style="display:inline-block;padding:12px 24px;`
      + `background:${BRAND_GOLD};color:${BRAND_GREEN};text-decoration:none;`
      + `font-weight:bold;border-radius:2px;">${label}</a></p>`
    );
  }

  if (block.signoff) {
    return `<p style="margin:0 0 16px;">Kind regards<br />Taranis Capital</p>`;
  }

  return '';
}

function blockToText(block) {
  if (block.p !== undefined) return block.p;
  if (block.lines !== undefined) {
    return block.lines.filter((l) => l !== null && l !== undefined && l !== '').join('\n');
  }
  // The approved file uses '>' for quoted material and the plain-text part
  // should read the way the approved markdown reads.
  if (block.quote !== undefined) {
    return String(block.quote).split('\n').map((l) => `> ${l}`).join('\n');
  }
  // "Every template also ships as plain text with the button rendered as a URL."
  if (block.button !== undefined) return `${block.button.label}: ${block.button.url ?? ''}`;
  if (block.signoff) return 'Kind regards\nTaranis Capital';
  return '';
}

/**
 * The header band.
 *
 * `EMAIL_LOGO_URL` is unset today, and with it unset the band carries a gold
 * wordmark rather than an image. That is deliberate and not a stopgap: most
 * clients block remote images by default, so an <img> would show as a broken
 * icon or an empty box in the first message a counterparty ever receives from
 * us, which is worse than type. Set the variable on the task definition to a
 * publicly reachable PNG and the image appears, with the wordmark as its alt
 * text.
 */
function headerHtml(env) {
  const logoUrl = env.EMAIL_LOGO_URL ? safeUrl(env.EMAIL_LOGO_URL) : '';
  const inner = logoUrl
    ? `<img src="${logoUrl}" alt="Taranis Capital" height="40" style="display:block;border:0;" />`
    : `<span style="color:${BRAND_GOLD};font-size:20px;letter-spacing:2px;`
      + `font-weight:bold;">TARANIS CAPITAL</span>`;

  return (
    `<tr><td style="background:${BRAND_GREEN};padding:24px 32px;">${inner}</td></tr>`
  );
}

/**
 * Render a block list to a full HTML document.
 *
 * Table-based and inline-styled because that is what mail clients render
 * predictably; Outlook in particular ignores most of a <style> block.
 */
export function renderHtml(blocks, { subject, env = process.env } = {}) {
  const body = blocks.filter(Boolean).map(blockToHtml).join('\n');

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#F3F4F6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border-collapse:collapse;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1F2937;">
${headerHtml(env)}
<tr><td style="padding:32px;">
${body}
</td></tr>
<tr><td style="padding:20px 32px 28px;border-top:1px solid #E5E7EB;">
<p style="margin:0;font-size:12px;line-height:1.5;color:${FOOTER_GREY};">${escapeHtml(COMMON_FOOTER)}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Render a block list to the plain-text alternative. */
export function renderText(blocks) {
  const body = blocks
    .filter(Boolean)
    .map(blockToText)
    .filter((chunk) => chunk !== '')
    .join('\n\n');

  return `${body}\n\n---\n\n${COMMON_FOOTER}\n`;
}
