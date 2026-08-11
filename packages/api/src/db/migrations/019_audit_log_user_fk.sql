-- ============================================================================
-- 019: Drop the foreign key from audit_log.user_id to users.id
--
-- READ THIS BEFORE ASSUMING IT WEAKENS THE AUDIT LOG. It does not delete a
-- row, does not modify a row, and does not touch either append-only trigger.
-- `audit_no_update` and `audit_no_delete` from migration 004 remain exactly as
-- they were, and every existing entry keeps its `user_id` value byte for byte.
-- What goes is the referential constraint, and only that.
--
-- WHY. The dataroom is being reset to zero for go-live: everything currently in
-- it is test data from the build, and the first real counterparty is invited
-- against a clean platform (HANDOVER-CW012, extended by Mark on 2026-08-11 to a
-- full reset). That means deleting every user except the founding admin.
--
-- The constraint made that impossible. `audit_log.user_id REFERENCES users(id)`
-- carried no ON DELETE clause, so any user who had ever signed in could not be
-- deleted while their audit entries existed, and those entries cannot be
-- removed or amended because the triggers refuse both. The three facts together
-- meant "delete this user" had no answer at all. Dropping the constraint is the
-- only one of the three that can be changed without weakening the append-only
-- guarantee, so it is the one that changes.
--
-- WHAT IT COSTS, STATED PLAINLY. `audit_log.user_id` stops being joinable to
-- `users` for a user who has since been deleted. The UUID is still recorded, so
-- entries by the same actor still group together and still distinguish one
-- actor from another; what is lost is resolving that UUID to a name from the
-- users table alone.
--
-- HOW THAT IS MITIGATED, AND WHY THE RESULT IS BETTER THAN THE FK WAS. The
-- reset appends a `user.identity_recorded` entry for every user immediately
-- before deleting them, carrying their id, email, display name and role. The
-- identity therefore lives INSIDE the append-only log rather than in a mutable
-- table the log merely pointed at. A foreign key never protected the name in
-- any case: `users.display_name` was always updatable, so the name an old audit
-- entry appeared to carry could change years later. Recording the identity at
-- the time of the event is the stronger record, not the weaker one.
--
-- FORWARD-ONLY. This is not reinstated afterwards. Re-adding the constraint
-- would fail against precisely the rows it is being dropped for, and the
-- retention position is served by the append-only triggers, which are what the
-- DFSA commitment actually rests on.
--
-- The constraint is looked up rather than named, so this works whatever
-- Postgres called it, and is a no-op on a database where it has already gone.
-- ============================================================================

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT con.conname INTO constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
   WHERE rel.relname = 'audit_log'
     AND con.contype = 'f'
     AND att.attname = 'user_id'
   LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE audit_log DROP CONSTRAINT %I', constraint_name);
    RAISE NOTICE 'Dropped audit_log foreign key %', constraint_name;
  ELSE
    RAISE NOTICE 'No foreign key on audit_log.user_id; nothing to drop.';
  END IF;
END $$;

COMMENT ON COLUMN audit_log.user_id IS
  'The actor, by id. NOT a foreign key since migration 019: a user may be deleted while their entries remain, because those entries can never be removed or amended. Resolve a name by joining users where the row still exists, and otherwise from the user.identity_recorded entry appended before the deletion.';
