-- ============================================================================
-- 009: Archive documents uploaded before the S3 cutover
--
-- Until this release, uploads were written to `packages/api/uploads/` inside
-- the container. Fargate has no persistent volume, so those files were already
-- destroyed on every deploy. The rows survived — they live in RDS — and each
-- one carries a `file_path` pointing at a local filename that no longer exists.
--
-- Left alone, the live document list would keep advertising every historical
-- document as available, each one would fail on click, and a re-upload of the
-- same document would appear twice.
--
-- Decision (Mark, 2026-08-05, HANDOVER-C003 §5.5 decision 1): archive them.
-- Rows are NOT deleted — deleting them would break the link between existing
-- `audit_log` entries and the documents they name, and the audit log is an
-- eight-year append-only DFSA commitment.
--
-- This migration runs once, inside a transaction, before the API serves
-- traffic (see `autoMigrate()` in packages/api/src/index.js). Every row it can
-- see is therefore a pre-cutover row by definition.
--
-- REVERSAL — a single UPDATE, using the record table below to touch only the
-- rows this migration changed, and not any document an admin archived
-- deliberately before the cutover:
--
--   UPDATE documents d
--      SET status = 'active', updated_at = NOW()
--     FROM s3_cutover_archived_documents a
--    WHERE a.document_id = d.id;
--
-- The audit_log table, its triggers and its retention are untouched here.
-- ============================================================================

-- Which rows this migration archived, so the change is reversible and auditable.
CREATE TABLE IF NOT EXISTS s3_cutover_archived_documents (
  document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE s3_cutover_archived_documents IS
  'Documents archived by migration 009 at the S3 storage cutover. Their bytes were lost to ephemeral container storage before uploads moved to S3. Retained so the archive can be reversed with one UPDATE.';

WITH archived AS (
  UPDATE documents
     SET status = 'archived',
         updated_at = NOW()
   WHERE status = 'active'
  RETURNING id
)
INSERT INTO s3_cutover_archived_documents (document_id)
SELECT id FROM archived
ON CONFLICT (document_id) DO NOTHING;
