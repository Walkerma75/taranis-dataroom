-- ============================================================================
-- 012: Information Request List — templates, template items, per-company items
--
-- An IRL template is the master checklist for a fund, versioned. Seeding a
-- company COPIES template items into `company_irl_items`, so per-company edits
-- (a note for the company, an item marked not applicable, an ad hoc addition)
-- never mutate the template and never leak between companies.
--
-- REFS ARE PERMANENT IDENTIFIERS. `ref` is the '1.1' style reference the
-- company quotes back in correspondence and that Taranis quotes in the PRE-
-- FILLED and GAPS working files. It is unique per template and per company and
-- is NEVER renumbered. `sort_order` carries display order so a later insertion
-- does not force a renumber.
--
-- VISIBILITY. Items Taranis already holds are seeded 'held' or
-- 'partially_held'. 'held' items are hidden from the company view entirely and
-- 'partially_held' items are shown, matching the GAPS convention that a company
-- only sees what is still outstanding or partial. That filter lives in the
-- service layer (services/companies.js `companyVisibleItems`), applied on every
-- company-side read.
--
-- Forward-only and idempotent throughout.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE irl_priority AS ENUM ('high', 'medium', 'standard');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE irl_item_state AS ENUM (
    'outstanding',
    'partially_held',
    'held',
    'received',
    'in_review',
    'attention_needed',
    'completed',
    'not_applicable'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- irl_templates — one master list per fund, versioned
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS irl_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id    UUID NOT NULL REFERENCES funds(id),
  name       TEXT NOT NULL,
  version    INT NOT NULL DEFAULT 1,
  -- Where the rows came from, so a template's provenance survives the session
  -- that imported it. e.g. 'Biotech_KSA_IRL_Master_Seed_v1_06Aug2026.xlsx'.
  source     TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fund_id, name, version)
);

CREATE INDEX IF NOT EXISTS idx_irl_templates_fund ON irl_templates (fund_id);

-- ---------------------------------------------------------------------------
-- irl_template_items — the master rows
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS irl_template_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES irl_templates(id) ON DELETE CASCADE,
  section     TEXT NOT NULL,
  ref         TEXT NOT NULL,               -- permanent, never renumbered
  description TEXT NOT NULL,
  priority    irl_priority NOT NULL DEFAULT 'standard',
  sort_order  INT NOT NULL,
  -- Carried through from the seed spreadsheet; both are per-company in
  -- practice and are usually blank on the template.
  already_held     TEXT,
  note_for_company TEXT,
  UNIQUE (template_id, ref)
);

CREATE INDEX IF NOT EXISTS idx_irl_template_items_template
  ON irl_template_items (template_id, sort_order);

-- ---------------------------------------------------------------------------
-- company_irl_items — the per-company checklist
--
-- template_item_id is NULL for ad hoc items a reviewer adds for one company.
-- `internal_note` is never surfaced to the company under any circumstance;
-- `note_for_company` always is.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_irl_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id),
  template_item_id UUID REFERENCES irl_template_items(id),  -- NULL = ad hoc
  section          TEXT NOT NULL,
  ref              TEXT NOT NULL,
  description      TEXT NOT NULL,
  priority         irl_priority NOT NULL DEFAULT 'standard',
  state            irl_item_state NOT NULL DEFAULT 'outstanding',
  already_held     TEXT,                   -- what Taranis already holds
  -- Which document on file satisfies the item. Feeds the PRE-FILLED export's
  -- 'Source document on file' column; Taranis-side only, never in GAPS.
  source_document  TEXT,
  note_for_company TEXT,                   -- surfaced to the company
  internal_note    TEXT,                   -- NEVER surfaced to the company
  target_date      DATE,                   -- Phase 3: column present, no UI yet
  sort_order       INT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, ref)
);

CREATE INDEX IF NOT EXISTS idx_company_irl_items_company
  ON company_irl_items (company_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_company_irl_items_state
  ON company_irl_items (company_id, state);

COMMENT ON COLUMN company_irl_items.ref IS
  'Permanent identifier quoted by the company in correspondence. Never renumber.';
COMMENT ON COLUMN company_irl_items.internal_note IS
  'Taranis-side only. Must never appear in any company-facing response or export.';
