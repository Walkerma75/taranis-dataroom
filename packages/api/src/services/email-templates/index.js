/**
 * The template package's public surface.
 *
 * Callers import from here, never from `templates.js` or `layout.js` directly,
 * so the split between the frozen wording and the frame it renders into stays
 * an implementation detail.
 */
export {
  TEMPLATES,
  TEMPLATE_IDS,
  UnknownTemplateError,
  renderTemplate,
} from './templates.js';

export {
  COMMON_FOOTER,
  SENDER_NAME,
  SENDER_ADDRESS,
  BRAND_GREEN,
  BRAND_GOLD,
  escapeHtml,
} from './layout.js';
