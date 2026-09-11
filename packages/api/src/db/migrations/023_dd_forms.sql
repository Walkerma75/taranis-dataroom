-- ============================================================================
-- 023: Standard DD forms — published once, downloadable by every company
--      (HANDOVER-CW027 / HANDOVER-C027)
--
-- Three checklist items on the Biotech KSA list (8.8 background-check consent,
-- 14.5 sanctions/PEP declaration, 14.7 beneficial-owner declaration) are
-- answered by completing a Taranis form, and until now the portal gave the
-- company no way to get the form. They went out by email, on request, with no
-- record of which version a company was given.
--
-- WHY NOT company_shared_files. That table is addressed to ONE company: each
-- form would need a publication per company and again per revision, and
-- nothing would tie it to the item that asks for it. This table is addressed
-- to every company (or every company in one fund) and can name the items it
-- answers. "From Taranis" stays as it is, for documents addressed to one
-- company.
--
-- WHY "FORMS" AND NOT "TEMPLATES". The brief said templates. In this schema
-- "template" already means the IRL master checklist (`irl_templates`,
-- `/api/irl-templates`, `irl_template.seeded`), and one word for two unrelated
-- things in the schema, the routes, the audit log and the admin nav is a
-- permanent tax on everyone who reads them. Agreed by Mark, 11 September 2026
-- (HANDOVER-C027 §2).
--
-- VERSIONING. Replacing a form inserts version N+1 with `supersedes` pointing
-- at N, and withdraws N with the reason "Replaced by version N+1", in one
-- transaction. Companies only ever see rows with `withdrawn_at IS NULL`, so
-- "current" and "not withdrawn" are the same thing and no second flag is
-- needed. The chain and the withdrawn rows are the history.
--
-- WITHDRAWAL IS SOFT, ALWAYS, and attributable, exactly as company_shared_files
-- (migration 014): a company that downloaded version 1 must always be able to
-- be told which version it was given and when.
--
-- LINKS BY FUND AND REF, NOT BY ITEM ID. `dd_form_items` names the checklist
-- item a form answers as (fund_id, item_ref). Refs are permanent identifiers
-- (migration 012) and survive a master being re-imported as a new version,
-- where `irl_template_items.id` does not. The company side resolves a link to
-- that company's own `company_irl_items` row by ref at read time, and drops it
-- if that item is hidden from the company ('held').
--
-- S3 KEYS. 'forms/{formId}/{filename}': a fourth top-level prefix, disjoint from
-- 'companies/', 'taranis-shared/' and 'documents/'.
--
-- SCANNING as shared files: same columns, same `scanner.js`, same
-- `downloadDecision`; an infected verdict refuses publication outright.
--
-- `audit_log`, its triggers and its retention are untouched. Forward-only and
-- idempotent throughout.
-- ============================================================================

CREATE TABLE IF NOT EXISTS dd_forms (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What the company sees. Mandatory at the column level too.
  title         TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description   TEXT,

  filename      TEXT NOT NULL,
  s3_key        TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  content_type  TEXT NOT NULL,

  -- NULL means every company; otherwise only companies in this fund.
  fund_id       UUID REFERENCES funds(id),

  version       INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  supersedes    UUID REFERENCES dd_forms(id),

  published_by  UUID NOT NULL REFERENCES users(id),
  published_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  withdrawn_at     TIMESTAMPTZ,
  withdrawn_by     UUID REFERENCES users(id),
  withdrawn_reason TEXT,

  scan_state    TEXT NOT NULL DEFAULT 'pending'
                  CHECK (scan_state IN ('pending', 'clean', 'infected', 'error')),
  scan_backend  TEXT,
  scanned_at    TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT dd_forms_withdrawal_is_attributable
    CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL)),
  -- A withdrawal always says why. Shared files leave the reason optional; a
  -- form is seen by every company, so the reason is part of the record.
  CONSTRAINT dd_forms_withdrawal_has_reason
    CHECK (withdrawn_at IS NULL OR length(trim(coalesce(withdrawn_reason, ''))) > 0)
);

-- The company-facing list is "live rows, for all companies or my fund".
CREATE INDEX IF NOT EXISTS idx_dd_forms_live
  ON dd_forms (fund_id, published_at DESC)
  WHERE withdrawn_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_dd_forms_supersedes ON dd_forms (supersedes);

CREATE TABLE IF NOT EXISTS dd_form_items (
  form_id   UUID NOT NULL REFERENCES dd_forms(id) ON DELETE CASCADE,
  fund_id   UUID NOT NULL REFERENCES funds(id),
  item_ref  TEXT NOT NULL,
  PRIMARY KEY (form_id, fund_id, item_ref)
);

-- The company-side lookup is "forms linked to this fund and ref".
CREATE INDEX IF NOT EXISTS idx_dd_form_items_fund_ref ON dd_form_items (fund_id, item_ref);

COMMENT ON TABLE dd_forms IS
  'Standard Taranis forms published once for every company (or one fund) to download, complete and upload against a checklist item. Versioned by supersedes; withdrawal is soft and attributable; rows are never deleted.';

COMMENT ON COLUMN dd_forms.fund_id IS
  'NULL: visible to every active company. Otherwise only to companies in this fund.';

COMMENT ON COLUMN dd_forms.supersedes IS
  'The previous version this row replaced. The previous row is withdrawn with reason "Replaced by version N".';

COMMENT ON TABLE dd_form_items IS
  'Checklist items a form answers, by (fund_id, item_ref). Refs are permanent identifiers (migration 012); item ids are not.';
