-- ============================================================================
-- 013: Company file uploads, formal submission batches, and status history
--
-- STAGED VERSUS SUBMITTED. A company uploads into a staging area. Nothing is a
-- submission until a company_admin formally submits a batch: at that moment the
-- files move to upload_state 'submitted', take status 'received', gain a
-- batch_id and the batch gains a unique receipt reference. Only staged files
-- can be edited or deleted by the company; only a company_admin can submit.
-- One accountable individual per formal submission.
--
-- RECEIPT REFERENCES. `receipt_ref` is quoted back in correspondence and in the
-- receipt itself, so it must be unique and must not go backwards. It is
-- generated from the dedicated sequence below, not from a count of rows: a
-- count would repeat a reference the moment two submissions raced, and it would
-- reuse a reference if a batch were ever removed. Format is
-- 'TRN-DD-{YYYY}-{NNNNNN}', the year taken from the submission timestamp and
-- the number zero-padded from the sequence. This settles the open item at code
-- brief §12 "receipt reference format and sequence storage".
--
-- S3 KEYS. 'companies/{companyId}/{irlItemId|additional}/{fileId}/{filename}'.
-- Company files and fund documents never share a key prefix, so a company
-- object can never be reached through a fund document path or the reverse.
--
-- SCANNING. `scan_state` starts 'pending'. Phase 1a ships the scanner behind an
-- injectable interface with a STUB backend that marks nothing clean by
-- accident: see services/scanner.js. `scan_backend` records which backend gave
-- the verdict, so a file scanned by the stub is distinguishable in the data
-- from one scanned by a real engine, not just in the logs.
--
-- `audit_log`, its triggers and its retention are untouched by this migration.
-- Forward-only and idempotent throughout.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE file_status AS ENUM ('received', 'in_review', 'attention_needed', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE upload_state AS ENUM ('staged', 'submitted');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Monotonic and gap-tolerant. Sequences are not transactional, which is
-- exactly what is wanted: a rolled-back submission must not hand its number
-- to the next one.
CREATE SEQUENCE IF NOT EXISTS company_receipt_ref_seq START WITH 1 INCREMENT BY 1;

-- ---------------------------------------------------------------------------
-- submission_batches
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS submission_batches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id),
  submitted_by UUID NOT NULL REFERENCES users(id),   -- always a company_admin
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  receipt_ref  TEXT NOT NULL UNIQUE                  -- e.g. 'TRN-DD-2026-000123'
);

CREATE INDEX IF NOT EXISTS idx_submission_batches_company
  ON submission_batches (company_id, submitted_at DESC);

-- ---------------------------------------------------------------------------
-- company_files
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_files (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id),
  irl_item_id  UUID REFERENCES company_irl_items(id),  -- NULL = Additional Documents
  batch_id     UUID REFERENCES submission_batches(id), -- NULL while staged
  uploaded_by  UUID NOT NULL REFERENCES users(id),
  filename     TEXT NOT NULL,
  -- Mandatory, and mandatory at the column level as well as in the service, so
  -- an empty description cannot reach the receipt through any code path.
  description  TEXT NOT NULL CHECK (length(trim(description)) > 0),
  s3_key       TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  content_type TEXT NOT NULL,
  version      INT NOT NULL DEFAULT 1,
  supersedes   UUID REFERENCES company_files(id),      -- version chain
  upload_state upload_state NOT NULL DEFAULT 'staged',
  status       file_status,                            -- NULL until submitted
  scan_state   TEXT NOT NULL DEFAULT 'pending'
                 CHECK (scan_state IN ('pending', 'clean', 'infected', 'error')),
  scan_backend TEXT,                                   -- which scanner gave the verdict
  scanned_at   TIMESTAMPTZ,
  deleted_at   TIMESTAMPTZ,                            -- staged deletions, soft
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_company_files_company
  ON company_files (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_files_item ON company_files (irl_item_id);
CREATE INDEX IF NOT EXISTS idx_company_files_batch ON company_files (batch_id);
CREATE INDEX IF NOT EXISTS idx_company_files_status
  ON company_files (status) WHERE upload_state = 'submitted';

COMMENT ON COLUMN company_files.scan_backend IS
  'Scanner backend that produced scan_state. A value of ''stub'' means the file was never actually scanned: see services/scanner.js and MIGRATION-INVENTORY.md.';

-- ---------------------------------------------------------------------------
-- file_status_history
--
-- Every status change lands here as well as in audit_log. A note is REQUIRED
-- when the status is 'attention_needed' — enforced in the service layer so the
-- admin gets a readable message, and again by the CHECK below so no code path
-- can write an unexplained attention_needed row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_status_history (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id    UUID NOT NULL REFERENCES company_files(id),
  status     file_status NOT NULL,
  note       TEXT,
  set_by     UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attention_needed_requires_note
    CHECK (status <> 'attention_needed' OR (note IS NOT NULL AND length(trim(note)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_file_status_history_file
  ON file_status_history (file_id, created_at DESC);
