-- ============================================================================
-- 016: Remember the state a checklist item falls back to
--
-- `recomputeItemState()` has always needed an answer to "what state is this
-- item in when nothing submitted counts towards it?", and until now it guessed:
--
--     seeded = ['held','partially_held'].includes(item.state) ? item.state : 'outstanding'
--
-- That guess reads the CURRENT state, so it only survives while the item has
-- never moved. Once a file arrives and the state derives to 'received' the
-- original 'held' or 'partially_held' is gone, and the guess answers
-- 'outstanding' for ever after.
--
-- That was harmless while item state only ever moved forwards. Migration 015
-- makes it reversible: supersede the last submitted file and the item falls
-- back for the first time — and would have fallen back to 'outstanding',
-- silently downgrading an item Taranis holds in full into one the company is
-- asked for again. `already_held` cannot stand in for this: it is descriptive
-- TEXT ("what Taranis already holds"), not a state.
--
-- So the fallback becomes a stored fact rather than an inference.
--
-- WHY 'baseline_state' and not 'seeded_state': it is not only set at seeding. A
-- reviewer who sets an item to 'held', 'partially_held' or 'outstanding' by
-- hand is making exactly the same kind of decision as the seed did, and it must
-- survive a file arriving and later being superseded in the same way. The three
-- values it may hold are the three states that describe what Taranis holds
-- independently of any submission; the derived states ('received', 'in_review',
-- 'attention_needed', 'completed') are a projection of the files and must never
-- become a baseline. 'not_applicable' is not a baseline either: it short
-- circuits `recomputeItemState()` outright and is never derived away.
--
-- BACKFILL. Existing rows have no record of what they were seeded as, so this
-- reconstructs the best available answer, in precedence order:
--
--   1. an item still sitting at 'held' or 'partially_held' has not moved, so
--      its current state IS its baseline, and this also captures the case of a
--      reviewer having set it by hand after seeding;
--   2. anything else re-applies the seeding rule to the row's own
--      `already_held` text, which is the same rule `seedStateFor()` applies in
--      services/companies.js and is copied onto the item at seed time;
--   3. ad hoc items (template_item_id IS NULL) carry no `already_held` and fall
--      out of rule 2 as 'outstanding', which is what they were created as.
--
-- Keep this CASE and `seedStateFor()` in step. They are the same rule written
-- twice because one of them has to run in SQL against rows that predate the
-- column.
--
-- Forward-only: ADD COLUMN IF NOT EXISTS, and on the run that matters every row
-- is sitting at the column default, so the WHERE matches all of them. The WHERE
-- is there so that a hand re-run cannot walk back a baseline the application
-- has since moved off 'outstanding'.
-- ============================================================================

ALTER TABLE company_irl_items
  ADD COLUMN IF NOT EXISTS baseline_state irl_item_state NOT NULL DEFAULT 'outstanding';

UPDATE company_irl_items
   SET baseline_state = CASE
         WHEN state IN ('held', 'partially_held') THEN state
         WHEN already_held IS NULL OR length(trim(already_held)) = 0 THEN 'outstanding'::irl_item_state
         WHEN lower(trim(already_held)) LIKE 'partial%' THEN 'partially_held'::irl_item_state
         ELSE 'held'::irl_item_state
       END
 WHERE baseline_state = 'outstanding';

COMMENT ON COLUMN company_irl_items.baseline_state IS
  'The state this item returns to when no submitted file counts towards it. One of outstanding, partially_held, held. Set at seeding from already_held and updated when a reviewer sets one of those three by hand; never holds a derived state. See recomputeItemState() in services/companies.js.';
