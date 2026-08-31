/**
 * The audit of company-visible IRL text already in the database.
 *
 * The write guard (routes), the seed guard (importer) and the export guard all
 * stop new text. This is the one that looks at what is already stored, which is
 * what HANDOVER-CW019 §3.5 asks for. It runs in JavaScript rather than in
 * migration 019 for the reason written at the top of that file: the patterns
 * live in exactly one place and cannot be restated in POSIX regular expressions
 * without becoming a different guard.
 *
 * TWO MODES, AND THE DEFAULT IS THE HARMLESS ONE.
 *
 *   report()      reads. Returns every offending row with its ref, field, tier,
 *                 the rule that matched and the fragment that matched it.
 *   quarantine()  moves the whole offending value into `internal_note`, blanks
 *                 the company-visible column, and records a row in
 *                 `irl_internal_reference_audit`.
 *
 * QUARANTINE DOES NOT REWRITE THE SUBSTANCE, and must not. "scored 5/5 in CASS"
 * has a legitimate neutral form and a machine cannot know what it is; guessing
 * would put invented wording in front of a founder, which is worse than the
 * leak. The text is moved somewhere the company cannot see, the ref is
 * recorded, and a human redrafts it and clears `rewritten_at`.
 *
 * Appending rather than overwriting an existing `internal_note` matters: the
 * note may already carry a reviewer's working comment, and this is a data-fix,
 * not a licence to discard it.
 */
import { pool } from '../db.js';
import { findCompanyUnsafeText, COMPANY_VISIBLE_FIELDS } from './company-visible-text.js';

/** The columns this audit examines, from the single source of truth. */
const VISIBLE_COLUMNS = Object.values(COMPANY_VISIBLE_FIELDS);

const SELECT_ROWS = `
  SELECT i.id, i.company_id, i.ref, i.already_held, i.note_for_company,
         i.internal_note, c.legal_name AS company_name
    FROM company_irl_items i
    JOIN companies c ON c.id = i.company_id
   ORDER BY c.legal_name, i.sort_order`;

/** Every offending (row, column, rule) triple, flattened. */
function findingsFor(row) {
  const findings = [];
  for (const column of VISIBLE_COLUMNS) {
    for (const hit of findCompanyUnsafeText(row[column])) {
      findings.push({
        itemId: row.id,
        companyId: row.company_id,
        companyName: row.company_name,
        ref: row.ref,
        field: column,
        tier: hit.tier,
        term: hit.term,
        match: hit.match,
      });
    }
  }
  return findings;
}

/**
 * Read-only. This is what the [LIVE] acceptance check in CW019 §4 runs, and the
 * expected answer today is zero rows: no per-company pre-filled text has been
 * loaded, so the exposure is still ahead of us rather than behind.
 *
 * @returns {Promise<{scanned:number, findings:Array, companies:string[]}>}
 */
export async function report(client = pool) {
  const { rows } = await client.query(SELECT_ROWS);
  const findings = rows.flatMap(findingsFor);
  return {
    scanned: rows.length,
    findings,
    companies: [...new Set(findings.map((f) => f.companyName))],
  };
}

/**
 * Move every offending value out of the company-visible columns.
 *
 * One transaction: a half-quarantined checklist is a checklist nobody can
 * reason about, and the whole point is to be able to say afterwards that no
 * company-visible column carries this material.
 *
 * Idempotent in the way that matters. A second run finds nothing, because the
 * first blanked the columns it read; and the appended internal note is not
 * re-appended, because there is no longer a visible value to move.
 */
export async function quarantine({ actorId = null } = {}, pgPool = pool) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(SELECT_ROWS);
    const moved = [];

    for (const row of rows) {
      const findings = findingsFor(row);
      if (!findings.length) continue;

      // The columns to blank, each once, however many rules fired on them.
      const columns = [...new Set(findings.map((f) => f.field))];

      // Everything being withdrawn, kept verbatim under the column it came
      // from so a reader can tell what was where.
      const carried = columns
        .map((column) => `[${column}, withdrawn from company view] ${row[column]}`)
        .join('\n');
      const note = row.internal_note ? `${row.internal_note}\n${carried}` : carried;

      const sets = columns.map((column, n) => `${column} = $${n + 3}`).join(', ');
      await client.query(
        `UPDATE company_irl_items
            SET ${sets}, internal_note = $2, updated_at = NOW()
          WHERE id = $1`,
        [row.id, note, ...columns.map(() => null)]
      );

      for (const f of findings) {
        await client.query(
          `INSERT INTO irl_internal_reference_audit
             (company_id, item_id, item_ref, field, tier, term, matched_text, quarantined_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [f.companyId, f.itemId, f.ref, f.field, f.tier, f.term, f.match, actorId]
        );
        moved.push(f);
      }
    }

    await client.query('COMMIT');
    return {
      scanned: rows.length,
      moved,
      items: new Set(moved.map((m) => m.itemId)).size,
      companies: [...new Set(moved.map((m) => m.companyName))],
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** One line per finding, for a log or a CLI. */
export function describeFinding(f) {
  return `${f.companyName || 'unknown company'} ref ${f.ref}, ${f.field}: ${f.term} ("${f.match}")`;
}
