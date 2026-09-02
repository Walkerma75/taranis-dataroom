-- ============================================================================
-- 020: An optional idempotency key on the notification outbox
--
-- WHY. Every message queued up to now has been queued by a request: an
-- invitation, a receipt, a status change. A request happens once, so queueing
-- once needed no help. The daily due diligence digest (HANDOVER-CW020 §3.5) is
-- the first message queued by a CLOCK rather than by a person, and a clock
-- fires again whenever the process that watches it is restarted.
--
-- Two ways that bites, one of them certain:
--
--   * A task restart at any point after the fire time re-runs the check with an
--     empty in-memory "already sent today" flag. Deploys, scaling events and
--     crashes all do this. This is not hypothetical; it is what an in-process
--     timer means.
--   * The ECS service runs at desired count 1, but a rolling deploy starts the
--     new task before the old one drains, so two of them overlap for a minute
--     or two. A deploy during the digest window would queue two.
--
-- `FOR UPDATE SKIP LOCKED` in the worker already stops two workers SENDING the
-- same row. It cannot help here, because these would be two different rows
-- saying the same thing.
--
-- WHY A COLUMN RATHER THAN A CHECK IN THE CALLER. The obvious alternative is
-- `INSERT ... WHERE NOT EXISTS (SELECT ... today)`. At READ COMMITTED two
-- concurrent transactions can both find nothing and both insert, so it would
-- work right up until the day the deploy landed at 07:00. A unique index is
-- decided by the database and needs no coordination between tasks.
--
-- NULLABLE AND PARTIAL, so that nothing existing changes. The ten wired
-- templates queue with no key and are unaffected: NULLs are not equal to each
-- other in a unique index, and the partial predicate keeps them out of it
-- entirely. Only a caller that passes a key opts into the constraint.
--
-- The key is the caller's to compose. The digest uses
-- 'dd-digest:YYYY-MM-DD' on the Dubai date, which is what makes it one per
-- working day regardless of how many times the process starts.
--
-- Forward-only and idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS. Nothing is rewritten and no existing row is touched.
-- ============================================================================

ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_outbox_dedupe
  ON notification_outbox (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

COMMENT ON COLUMN notification_outbox.dedupe_key IS
  'Optional idempotency key. When set, a second queue() with the same key is a no-op, so a message queued by a timer survives a restart or an overlapping deploy without being sent twice. NULL for every request-driven message. See services/notifications.js queue().';
