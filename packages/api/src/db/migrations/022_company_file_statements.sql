-- ============================================================================
-- 022: "Cannot provide" responses on checklist items (HANDOVER-CW026)
--
-- WHY. The only thing a company could put on the record against a checklist
-- item was a file, and the file was mandatory. So companies improvised: a blank
-- PDF with "not available" in the description, images named NA.png and
-- "No attachment.png" (Revelations Biotech, 10 September 2026). Each went
-- through scanning, staging, review and receipts as if it were evidence, and
-- when accepted it marked the item Completed as though a document had arrived.
--
-- A response is now a formal thing of its own: a reason and an explanation,
-- staged, submitted by the Company Administrator under a receipt, reviewed and
-- replaceable exactly like a file. Mark's decisions D1 and D2, CW026 §5.
--
-- WHY A KIND ON company_files AND NOT A TABLE OF ITS OWN. A response needs
-- everything a file already has: staging, the batch and its receipt, status and
-- file_status_history, attention notes, status emails, the supersede chain, the
-- review queue and the dd-summary buckets. A parallel table would duplicate all
-- of it and drift. So a row is either kind 'file' or kind 'statement'.
--
-- WHY THE LABEL IS IN `filename`. For a response, `filename` holds its display
-- label, "No document (not applicable)" and so on (CW026 §3.4), rather than
-- NULL. Every list, receipt, audit entry, dashboard line and email payload reads
-- that column; left NULL, any reader missed would print "null" in front of a
-- counterparty, whereas a stored label reads correctly everywhere by default.
-- Its inputs only change while the row is staged, through the endpoint that
-- rewrites it, and item refs are never renumbered, so it cannot drift. Agreed by
-- Mark in HANDOVER-C026 §3.1. `kind` is what code branches on; the label is for
-- people. The explanation lives in `description` for the same reason, and keeps
-- that column's non-empty CHECK from 013.
--
-- TEXT WITH CHECKS, NOT ENUMS, for `kind` and `statement_reason`: a new value is
-- then an ALTER of a constraint, not an `ADD VALUE` that cannot be used in the
-- migration that adds it (the 010 and 015 caution).
--
-- THE SHAPE IS TIED TO THE KIND AT THE COLUMN LEVEL, so neither can exist half
-- formed through any code path:
--   * a file keeps every guarantee it had: bytes, size, type and a scan state;
--   * a response has no bytes, no size, no type and NO scan state at all, so
--     nothing can ever claim it was scanned; it is always against a checklist
--     item; it has an expected date if and only if the reason is
--     'not_yet_available', and a related item if and only if it is
--     'provided_elsewhere', which may not be the item itself.
--
-- ONE CURRENT RESPONSE PER ITEM is enforced in the service under a lock on the
-- item row. The partial unique index below backs the staged half of it: at most
-- one response waiting to be submitted per item. The submitted half is not an
-- index, because a replacement is staged alongside the response it replaces
-- (the CW010 pattern) and a unique index cannot be deferred to let submission
-- retire one and promote the other in the same statement order.
--
-- `audit_log`, its triggers and its retention are untouched. Existing rows are
-- all files and satisfy the new constraints as they stand. Forward-only and
-- idempotent.
-- ============================================================================

ALTER TABLE company_files ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'file';
ALTER TABLE company_files ADD COLUMN IF NOT EXISTS statement_reason TEXT;
ALTER TABLE company_files ADD COLUMN IF NOT EXISTS expected_date DATE;
ALTER TABLE company_files ADD COLUMN IF NOT EXISTS related_item_id UUID REFERENCES company_irl_items(id);

-- A response has none of these. The file-shape CHECK below puts the guarantee
-- back for every file, so relaxing the columns loosens nothing for them.
ALTER TABLE company_files ALTER COLUMN s3_key DROP NOT NULL;
ALTER TABLE company_files ALTER COLUMN size_bytes DROP NOT NULL;
ALTER TABLE company_files ALTER COLUMN content_type DROP NOT NULL;
ALTER TABLE company_files ALTER COLUMN scan_state DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE company_files ADD CONSTRAINT company_files_kind_valid
    CHECK (kind IN ('file', 'statement'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE company_files ADD CONSTRAINT company_files_statement_reason_valid
    CHECK (statement_reason IS NULL OR statement_reason IN (
      'not_applicable', 'does_not_exist', 'not_yet_available', 'provided_elsewhere', 'other'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE company_files ADD CONSTRAINT company_files_file_shape
    CHECK (kind <> 'file' OR (
      s3_key IS NOT NULL
      AND size_bytes IS NOT NULL
      AND content_type IS NOT NULL
      AND scan_state IS NOT NULL
      AND statement_reason IS NULL
      AND expected_date IS NULL
      AND related_item_id IS NULL
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE company_files ADD CONSTRAINT company_files_statement_shape
    CHECK (kind <> 'statement' OR (
      s3_key IS NULL
      AND size_bytes IS NULL
      AND content_type IS NULL
      AND scan_state IS NULL
      AND scan_backend IS NULL
      AND scanned_at IS NULL
      AND irl_item_id IS NOT NULL
      AND statement_reason IS NOT NULL
      AND (statement_reason = 'not_yet_available') = (expected_date IS NOT NULL)
      AND (statement_reason = 'provided_elsewhere') = (related_item_id IS NOT NULL)
      AND related_item_id IS DISTINCT FROM irl_item_id
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- At most one response waiting to be submitted per item.
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_files_one_staged_statement
  ON company_files (irl_item_id)
  WHERE kind = 'statement' AND upload_state = 'staged' AND deleted_at IS NULL;

COMMENT ON COLUMN company_files.kind IS
  '''file'' or ''statement''. A statement is a formal "cannot provide" response (HANDOVER-CW026): no bytes, no scan, a reason and an explanation. Code branches on this column, never on a missing s3_key.';

COMMENT ON COLUMN company_files.filename IS
  'For a file, its name. For a statement, its display label, e.g. "No document (not applicable)", written with the row and rewritten only while it is staged (HANDOVER-C026 §3.1).';

COMMENT ON COLUMN company_files.expected_date IS
  'For a not_yet_available statement only: the date the company expects to provide the document. Informational; nothing ages it (CW026 §5).';
