-- ============================================================================
-- 019: Record of company-visible IRL text that carried an internal reference
--
-- HANDOVER-CW019 §3.5 asks for an audit of existing `company_irl_items` rows
-- whose `already_held` or `note_for_company` carries a CASS score or names an
-- internal Taranis document, with the offending text moved into `internal_note`
-- and the refs reported for a human to rewrite. Rewriting the substance is
-- editorial and is deliberately NOT guessed here.
--
-- NUMBERED 019, NOT 017. The brief says 017; 017 and 018 were both taken by the
-- Phase 1b email work (`notification_outbox`, `email_suppressions`) between the
-- brief being written and this being built. The runner sorts by filename, so a
-- second 017 would have run out of sequence.
--
-- WHY THIS MIGRATION HOLDS NO PATTERNS. The detection lives in
-- `services/company-visible-text.js` and nowhere else, because CW019 §3.1
-- requires one place to add a term. It cannot be restated here: Postgres uses
-- POSIX regular expressions, which have no lookbehind and no lookahead, and the
-- date exclusion that keeps "SPA dated 14/8/2026" from reading as a score is
-- built from both. A SQL copy would be a DIFFERENT guard wearing the same name,
-- and would quarantine text the API considers perfectly safe.
--
-- So this migration creates the record and nothing else. The audit itself is
-- `services/irl-text-audit.js`, reachable at GET /api/maintenance/irl-text-audit
-- (report) and POST /api/maintenance/irl-text-audit/quarantine (act), which is
-- also the only way to run it against production: RDS is in a private subnet
-- and the deploy credential is ECR and ECS only.
--
-- DELIBERATELY NOT SELF-EXECUTING. `autoMigrate()` runs on every deploy, and a
-- step that rewrites stored text must never be something a redeploy repeats by
-- itself. Same reasoning as the platform reset.
--
-- Forward-only and idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS irl_internal_reference_audit (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id),
  item_id        UUID NOT NULL REFERENCES company_irl_items(id),
  item_ref       TEXT NOT NULL,          -- permanent ref, quoted when rewriting
  field          TEXT NOT NULL,          -- 'already_held' | 'note_for_company'
  tier           TEXT NOT NULL,          -- 'score' | 'internal-source'
  term           TEXT NOT NULL,          -- which rule matched, in words
  matched_text   TEXT NOT NULL,          -- the fragment, so it can be found
  -- The full original is moved to company_irl_items.internal_note rather than
  -- copied here: one home for the text, and it is the home that is stripped
  -- from every company-facing response.
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  quarantined_by UUID REFERENCES users(id),
  rewritten_at   TIMESTAMPTZ             -- set by hand once a human has redrafted
);

CREATE INDEX IF NOT EXISTS idx_irl_reference_audit_company
  ON irl_internal_reference_audit (company_id, item_ref);
CREATE INDEX IF NOT EXISTS idx_irl_reference_audit_open
  ON irl_internal_reference_audit (quarantined_at) WHERE rewritten_at IS NULL;

COMMENT ON TABLE irl_internal_reference_audit IS
  'Company-visible IRL text quarantined for carrying a CASS score or an internal source (HANDOVER-CW019). A row with rewritten_at NULL still needs a human redraft.';
