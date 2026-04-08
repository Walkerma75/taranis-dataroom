/**
 * Audit logging service — writes to the append-only audit_log table.
 */
import { pool } from '../db.js';

/**
 * @param {object} opts
 * @param {string}  opts.action     - e.g. 'login', 'document.view'
 * @param {string} [opts.userId]
 * @param {string} [opts.resource]  - e.g. 'document', 'user'
 * @param {string} [opts.resourceId]
 * @param {object} [opts.detail]    - arbitrary JSON payload
 * @param {string} [opts.ip]
 * @param {string} [opts.userAgent]
 */
export async function logAudit({ action, userId, resource, resourceId, detail, ip, userAgent }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, action, resource, resource_id, detail, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId || null, action, resource || null, resourceId || null, detail ? JSON.stringify(detail) : null, ip || null, userAgent || null]
    );
  } catch (err) {
    // Never let audit failures crash the request
    console.error('[audit] Failed to write audit log:', err.message);
  }
}
