-- ============================================================================
-- 014: Taranis-to-company shared documents
--
-- Phase 1a moves files in one direction only: company to Taranis. This table is
-- the other direction. A row is a document Taranis has published into exactly
-- one company's workspace, read-only to that company and to nobody else.
--
-- The immediate use is the AdrenoMed PRE-FILLED information request pack, held
-- back since 14 July 2026 so the portal could deliver it rather than email
-- (HANDOVER-C005 §3.2, §3.5).
--
-- NAMING. The code brief §4 sketched this as `company_shared_documents` in a
-- migration `012` that was never built. It is `company_shared_files` here, to
-- sit beside `company_files` and to keep `documents` meaning fund documents,
-- which is what that word means everywhere else in this schema.
--
-- WITHDRAWAL IS SOFT, ALWAYS. `withdrawn_at` hides the row from the company;
-- the row and its audit trail stay. Nothing in the application deletes from
-- this table and nothing removes the object from the bucket. A counterparty who
-- downloaded a document and then found it silently gone, with no record that it
-- had ever existed, is the sort of thing a diligence counterparty escalates,
-- and we would have nothing to answer with. Re-publishing a withdrawn document
-- means publishing it again as a new row, so the second publication has its own
-- timestamp and actor rather than quietly reviving the first.
--
-- S3 KEYS. 'taranis-shared/{companyId}/{sharedFileId}/{filename}'. A distinct
-- top-level prefix from both 'companies/' (company uploads, migration 013) and
-- 'documents/' (fund documents), so no shared document is reachable through a
-- company-upload path or a fund-document path, and the reverse.
--
-- SCANNING. Shared files carry the same scan columns as `company_files` and go
-- through the same `services/scanner.js` interface. The reasoning for scanning
-- material that originates from Taranis is written into
-- `services/company-shared.js`; the short version is that one download rule for
-- both directions is worth more than the small saving of skipping a stub.
--
-- `audit_log`, its triggers and its retention are untouched by this migration.
-- Publication, download and withdrawal all append through `logAudit()` only.
--
-- Forward-only and idempotent throughout.
-- ============================================================================

CREATE TABLE IF NOT EXISTS company_shared_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),

  -- What the company sees in the list. Mandatory at the column level as well as
  -- in the service, so no code path can publish an untitled document into a
  -- counterparty's workspace.
  title         TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description   TEXT,

  filename      TEXT NOT NULL,
  s3_key        TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  content_type  TEXT NOT NULL,

  published_by  UUID NOT NULL REFERENCES users(id),
  published_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Soft withdrawal. Both columns move together or neither does: a withdrawal
  -- with no named actor would be a hole in exactly the trail this table exists
  -- to keep.
  withdrawn_at  TIMESTAMPTZ,
  withdrawn_by  UUID REFERENCES users(id),
  withdrawn_reason TEXT,

  scan_state    TEXT NOT NULL DEFAULT 'pending'
                  CHECK (scan_state IN ('pending', 'clean', 'infected', 'error')),
  scan_backend  TEXT,
  scanned_at    TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT withdrawal_is_attributable
    CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_company_shared_files_company
  ON company_shared_files (company_id, published_at DESC);

-- The company-facing list is always "live rows for one company", so it gets its
-- own partial index rather than filtering the full history every time.
CREATE INDEX IF NOT EXISTS idx_company_shared_files_live
  ON company_shared_files (company_id, published_at DESC)
  WHERE withdrawn_at IS NULL;

COMMENT ON TABLE company_shared_files IS
  'Documents published by Taranis into one company workspace. Read-only to the company. Withdrawal is soft: rows are never deleted, so a document a company downloaded can always be accounted for.';

COMMENT ON COLUMN company_shared_files.withdrawn_at IS
  'Set to hide the row from the company. The row, the S3 object and the audit trail all survive. Never hard-delete: see the header of this migration.';

COMMENT ON COLUMN company_shared_files.scan_backend IS
  'Scanner backend that produced scan_state. A value of ''stub'' means the file was never actually inspected: see services/scanner.js and MIGRATION-INVENTORY.md.';
