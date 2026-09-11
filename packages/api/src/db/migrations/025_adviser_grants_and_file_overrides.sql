-- ============================================================================
-- 025: Adviser grants with scope, expiry and attestation; per-file overrides
--      (HANDOVER-CW028 §3.4 to §3.7, PR B of the split in C028 §4)
--
-- `company_reviewers` (migration 011) already lets a Taranis-side advisor or
-- viewer see one company at 'reviewer' or 'readonly' level, and the API has
-- honoured it from the start. What it lacked: which SECTIONS the person may
-- see, WHEN the access ends, and the RECORD of why the person was entitled.
-- This migration adds those three things to the existing table rather than
-- building a second sharing system beside it (C028 §5, "why this shape").
--
-- SECTIONS. `sections TEXT[]`, NULL meaning every section. The values are the
-- section labels as they appear on THAT company's `company_irl_items` rows,
-- copied per company at seeding, so a later rename on a master cannot silently
-- widen or narrow a grant already given.
--
-- EXPIRY. `expires_at` is required for every grant created from now on (the
-- API refuses a grant without one) but is nullable at the column level, so any
-- row that pre-dates this migration is kept as it is and listed on the Access
-- tab as "No end date, set one" for an administrator to date. No default is
-- invented for it (C028 §2.3). A grant past its date behaves as no grant, in
-- every route, without anyone acting.
--
-- ATTESTATION. Two confirmations are required to give access, recorded with
-- who gave them, when, and which wording (`attestation_version`) they gave, so
-- a change to the sentences later is a new version rather than a rewrite of
-- history. The sentences live in services/adviser-access.js.
--
-- FILE OVERRIDES. `company_files.adviser_override`: 'follow_item' (the default:
-- the file is restricted if and only if its item is; a file under no item, an
-- Additional Document, is restricted), 'restricted' (this file specifically,
-- whatever its item says: a CV pack that turns out to hold passport scans), or
-- 'released' (this file specifically, with a reason, under a restricted item
-- or with no item). A release without a reason is refused at the column level.
--
-- WHAT NEVER CHANGES. Nothing here decides access on its own: the rule is
-- `resolveCompanyAccess()` and `fileVisibleToGrant()` in
-- services/adviser-access.js, and every route that returns items, files, bytes
-- or history goes through them. `audit_log`, its triggers and its retention
-- are untouched. Forward-only and idempotent.
-- ============================================================================

ALTER TABLE company_reviewers ADD COLUMN IF NOT EXISTS sections TEXT[];
ALTER TABLE company_reviewers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE company_reviewers ADD COLUMN IF NOT EXISTS attested_by UUID REFERENCES users(id);
ALTER TABLE company_reviewers ADD COLUMN IF NOT EXISTS attested_at TIMESTAMPTZ;
ALTER TABLE company_reviewers ADD COLUMN IF NOT EXISTS attestation_version TEXT;
ALTER TABLE company_reviewers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE company_reviewers ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);

-- An attestation names who gave it and when, or is absent (pre-existing rows).
DO $$ BEGIN
  ALTER TABLE company_reviewers ADD CONSTRAINT company_reviewers_attestation_complete
    CHECK ((attested_by IS NULL) = (attested_at IS NULL)
       AND (attested_by IS NULL) = (attestation_version IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_company_reviewers_user_live
  ON company_reviewers (user_id, expires_at);

COMMENT ON COLUMN company_reviewers.sections IS
  'Checklist sections the grant covers, as the labels on this company''s items. NULL means every section (HANDOVER-CW028 §3.1).';
COMMENT ON COLUMN company_reviewers.expires_at IS
  'Access stops at this instant without anyone acting. Required for every grant created after migration 025; NULL only on rows that pre-date it, which the Access tab lists for dating.';
COMMENT ON COLUMN company_reviewers.attestation_version IS
  'Which wording of the two confirmations was given; the sentences live in services/adviser-access.js.';

ALTER TABLE company_files ADD COLUMN IF NOT EXISTS adviser_override TEXT NOT NULL DEFAULT 'follow_item';
ALTER TABLE company_files ADD COLUMN IF NOT EXISTS adviser_override_by UUID REFERENCES users(id);
ALTER TABLE company_files ADD COLUMN IF NOT EXISTS adviser_override_at TIMESTAMPTZ;
ALTER TABLE company_files ADD COLUMN IF NOT EXISTS adviser_override_reason TEXT;

DO $$ BEGIN
  ALTER TABLE company_files ADD CONSTRAINT company_files_adviser_override_valid
    CHECK (adviser_override IN ('follow_item', 'restricted', 'released'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE company_files ADD CONSTRAINT company_files_release_has_reason
    CHECK (adviser_override <> 'released'
           OR length(trim(coalesce(adviser_override_reason, ''))) > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN company_files.adviser_override IS
  'follow_item: restricted iff the item is (a file under no item is restricted). restricted: this file, whatever the item says. released: this file, with a reason, to advisers whose grant covers it (HANDOVER-CW028 §3.3).';
