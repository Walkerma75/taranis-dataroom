-- ============================================================================
-- 024: Adviser-restricted checklist items, and neutral master wording
--      (HANDOVER-CW028 §3.2 and §3.8, PR A of the two-PR split in C028 §4)
--
-- TWO THINGS, BOTH DATA, NEITHER CHANGING WHO SEES WHAT YET. The access model
-- that reads `adviser_restricted` (grants with scope and expiry, the Access
-- tab, the enforcement in every route) is PR B. This migration puts the flag
-- on the rows and backfills it, so PR B lands on data that is already right and
-- so the 2.7 / 3.3 wording fix ships without waiting for it.
--
-- THE FLAG. `adviser_restricted` on `irl_template_items` and `company_irl_items`,
-- default FALSE. Source of truth is column H, `adviser_access`, of the IRL
-- master (Biotech_KSA_IRL_Master_Seed_v1.1_11Sep2026.xlsx), carried into the
-- committed seed JSON by tools/build-irl-seed.mjs and copied to each company at
-- seeding. Confirmed by Mark on 11 September 2026: 1.4, 1.5, 1.10, 1.11, 7.5,
-- 7.7, 7.12, 8.5, 8.7, 8.8, 11.3 and the whole of section 14 (14.1 to 14.10).
-- Twenty-one refs. Identity documents, bank details, ownership, cap tables and
-- personal data: the material no adviser grant will ever show.
--
-- BACKFILL BY REF, ON THE BIOTECH FUND ONLY. Refs are permanent identifiers
-- (migration 012) and are the only key that survives a master re-import, so
-- the list below is refs, not ids. It is scoped to templates and companies of
-- the fund with slug 'biotech-ksa' (or any fund whose template was imported from
-- a Biotech_KSA_IRL_Master file, in case the slug differs in production) because the numbering is that master's: a
-- future fund's list numbers differently (the Disruptive Tech list puts AML/KYC
-- at section 11, not 14) and will carry its own `adviser_access` column, which
-- the seed builder now refuses to run without.
--
-- NEUTRAL WORDING. The Biotech master was first built from one company's own
-- pre-filled request and two items carried its programme into every company's
-- checklist: 2.7 named two biomarkers, 3.3 named a trial. The spreadsheet was
-- neutralised on 25 August 2026 and the live workspaces corrected by hand that
-- day, but the committed JSON never was, so a re-import brought the old text
-- back. The rewrite below is by CONTENT, not by ref alone: only a description
-- that still carries the old fragment is touched, on every company including
-- the one it came from, because the neutral wording is right for them too.
-- Zero rows is the expected answer for `company_irl_items` if the 25 August
-- correction held; the counts are RAISEd so the deploy log shows them.
--
-- `audit_log`, its triggers and its retention are untouched. Forward-only and
-- idempotent: the ADD COLUMNs are IF NOT EXISTS, the backfill sets a value that
-- is already correct on a re-run, and the rewrite matches text that a first run
-- removed.
-- ============================================================================

ALTER TABLE irl_template_items
  ADD COLUMN IF NOT EXISTS adviser_restricted BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE company_irl_items
  ADD COLUMN IF NOT EXISTS adviser_restricted BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN irl_template_items.adviser_restricted IS
  'Files under this item are for admins only; no adviser grant, at any level or scope, ever shows them (HANDOVER-CW028 §3.1). From the master''s adviser_access column.';

COMMENT ON COLUMN company_irl_items.adviser_restricted IS
  'Copied from the template at seeding, toggleable per company by an admin (HANDOVER-CW028 §3.3). Never reaches a company response.';

-- ---------------------------------------------------------------------------
-- Backfill the flag, Biotech KSA only, by ref
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  restricted_refs TEXT[] := ARRAY[
    '1.4', '1.5', '1.10', '1.11',
    '7.5', '7.7', '7.12',
    '8.5', '8.7', '8.8',
    '11.3',
    '14.1', '14.2', '14.3', '14.4', '14.5', '14.6', '14.7', '14.8', '14.9', '14.10'
  ];
  template_rows INT;
  company_rows INT;
BEGIN
  UPDATE irl_template_items i
     SET adviser_restricted = TRUE
    FROM irl_templates t
    JOIN funds f ON f.id = t.fund_id
   WHERE i.template_id = t.id
     AND (f.slug = 'biotech-ksa' OR t.source ILIKE 'Biotech_KSA_IRL_Master%')
     AND i.ref = ANY(restricted_refs)
     AND i.adviser_restricted = FALSE;
  GET DIAGNOSTICS template_rows = ROW_COUNT;

  UPDATE company_irl_items i
     SET adviser_restricted = TRUE
    FROM companies c
    JOIN funds f ON f.id = c.fund_id
   WHERE i.company_id = c.id
     AND (f.slug = 'biotech-ksa'
          OR EXISTS (SELECT 1 FROM irl_templates t2
                      WHERE t2.fund_id = f.id AND t2.source ILIKE 'Biotech_KSA_IRL_Master%'))
     AND i.ref = ANY(restricted_refs)
     AND i.adviser_restricted = FALSE;
  GET DIAGNOSTICS company_rows = ROW_COUNT;

  RAISE NOTICE '[024] adviser_restricted backfilled: % template item rows, % company item rows',
    template_rows, company_rows;
END $$;

-- ---------------------------------------------------------------------------
-- Neutral wording for 2.7 and 3.3, wherever the old fragment survives
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t27 INT; c27 INT; t33 INT; c33 INT;
BEGIN
  UPDATE irl_template_items
     SET description = 'Biomarker strategy and any companion diagnostics'
   WHERE ref = '2.7' AND description ILIKE '%bio-ADM / DPP3%';
  GET DIAGNOSTICS t27 = ROW_COUNT;

  UPDATE company_irl_items
     SET description = 'Biomarker strategy and any companion diagnostics',
         updated_at = NOW()
   WHERE ref = '2.7' AND description ILIKE '%bio-ADM / DPP3%';
  GET DIAGNOSTICS c27 = ROW_COUNT;

  UPDATE irl_template_items
     SET description = 'Protocol synopses for ongoing and planned trials'
   WHERE ref = '3.3' AND description ILIKE '%(BOOST Phase 3)%';
  GET DIAGNOSTICS t33 = ROW_COUNT;

  UPDATE company_irl_items
     SET description = 'Protocol synopses for ongoing and planned trials',
         updated_at = NOW()
   WHERE ref = '3.3' AND description ILIKE '%(BOOST Phase 3)%';
  GET DIAGNOSTICS c33 = ROW_COUNT;

  RAISE NOTICE '[024] neutral wording: 2.7 rewrote % template / % company rows; 3.3 rewrote % template / % company rows',
    t27, c27, t33, c33;
END $$;
