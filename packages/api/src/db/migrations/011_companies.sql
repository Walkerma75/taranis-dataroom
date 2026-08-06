-- ============================================================================
-- 011: Companies, their user memberships, and Taranis-side reviewer assignment
--
-- A company is a counterparty under due diligence. It belongs to exactly one
-- fund, it is invisible to its own users until activated, and activation is
-- gated on two timestamps that only a Taranis admin can record.
--
-- THE TWO GATES. `status` may only move to 'active' when BOTH
-- `nda_executed_at` and `iems_screened_at` are set. That rule is enforced in
-- the service layer (services/companies.js), not by a DB constraint, because
-- the ordering of the two gates is a business workflow rather than a data
-- integrity rule and the error needs to reach the admin as a readable message.
-- The first real cohort exercises this: one company holds an executed NDA but
-- has no IEMS screen on record, and must be impossible to activate.
--
-- The third confirmation, the Q1 three-point NDA check, is recorded here too
-- (`nda_check_confirmed_at`). Per HANDOVER-CW004 §5 a tick with a recorded-by
-- user and a timestamp is sufficient; no document upload. It is recorded, not
-- gating — the two timestamp gates above are the ones that block activation.
--
-- `audit_log`, its triggers and its retention are untouched by this migration.
-- New audit actions append through the existing `logAudit()` service only.
--
-- Forward-only and idempotent: every CREATE carries IF NOT EXISTS, and the
-- enum creations are wrapped so a re-run is a no-op rather than a duplicate
-- type error.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE company_status AS ENUM ('pending', 'active', 'suspended', 'offboarded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE company_role AS ENUM ('company_admin', 'company_contributor', 'company_viewer');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id          UUID NOT NULL REFERENCES funds(id),
  legal_name       TEXT NOT NULL,
  jurisdiction     TEXT,
  -- Used to flag (never to block) a nomination whose email is off-domain.
  email_domains    TEXT[] NOT NULL DEFAULT '{}',
  nda_executed_at  TIMESTAMPTZ,                   -- gate 1
  iems_screened_at TIMESTAMPTZ,                   -- gate 2
  iems_reference   TEXT,
  -- Q1 three-point NDA check: service-provider clause, no localisation
  -- restriction, purpose covers evaluation. Recorded, not gating.
  nda_check_confirmed_at TIMESTAMPTZ,
  nda_check_confirmed_by UUID REFERENCES users(id),
  status           company_status NOT NULL DEFAULT 'pending',
  activated_at     TIMESTAMPTZ,
  suspended_at     TIMESTAMPTZ,
  offboarded_at    TIMESTAMPTZ,
  created_by       UUID NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_companies_fund ON companies (fund_id);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies (status);

COMMENT ON COLUMN companies.nda_executed_at IS
  'Activation gate 1. Set by a Taranis admin when the counterparty NDA is fully executed.';
COMMENT ON COLUMN companies.iems_screened_at IS
  'Activation gate 2. Set by a Taranis admin when IEMS counterparty screening is complete. A company with an NDA but no IEMS screen cannot be activated.';

-- ---------------------------------------------------------------------------
-- company_users — the membership record
--
-- Company-side capability lives HERE, not on users.role. A user with global
-- role 'company' holds exactly one active membership; the company_role column
-- decides whether they can upload, submit or only look.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id),
  user_id        UUID NOT NULL REFERENCES users(id),
  company_role   company_role NOT NULL DEFAULT 'company_contributor',
  is_primary     BOOLEAN NOT NULL DEFAULT FALSE,  -- the Primary Contact
  nominated_by   UUID REFERENCES users(id),       -- company_admin who nominated
  approved_by    UUID REFERENCES users(id),       -- Taranis admin who approved
  -- A nomination that has not yet been approved by Taranis. The user exists and
  -- the membership row exists, but neither is usable until approved_by is set.
  nomination_note TEXT,
  domain_matched BOOLEAN,                          -- NULL for direct invites
  deactivated_at TIMESTAMPTZ,
  deactivated_by UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_company_users_company ON company_users (company_id);
CREATE INDEX IF NOT EXISTS idx_company_users_user ON company_users (user_id);

-- One Primary Contact per company, and only among live memberships.
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_users_one_primary
  ON company_users (company_id)
  WHERE is_primary AND deactivated_at IS NULL;

-- ---------------------------------------------------------------------------
-- company_reviewers — named Taranis-side access to one company
--
-- Lets a specialist DD consultant (an advisor or viewer, never a company user)
-- see exactly one company and nothing else. 'reviewer' can set statuses and
-- write notes; 'readonly' cannot.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_reviewers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  level       TEXT NOT NULL CHECK (level IN ('reviewer', 'readonly')),
  assigned_by UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_company_reviewers_user ON company_reviewers (user_id);
