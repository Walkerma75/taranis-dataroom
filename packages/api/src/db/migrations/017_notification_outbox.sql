-- ============================================================================
-- 017: notification_outbox — the transactional outbox for platform email
--
-- Phase 1a sent no email at all: an invitation returned a link for an
-- administrator to send by hand, and the Review Queue stood in for upload
-- notifications. SES production access was granted on 2026-08-06 (case
-- 178594622700053), so Phase 1b makes the platform send. This table is the
-- seam between the two halves.
--
-- WHY AN OUTBOX RATHER THAN SENDING INLINE. A route that calls SES in the
-- middle of handling a request couples a company's upload to the availability
-- of a third-party API: SES is slow or throttled, and a file the company
-- successfully uploaded reports a 500. Worse, a send that succeeds inside a
-- transaction that later rolls back has already left the building — you cannot
-- un-send an email. So the routes write a row here, in the SAME transaction as
-- the thing being notified about, and only the worker in
-- `services/notifications.js` talks to SES. If the transaction rolls back the
-- row rolls back with it and no email is sent; if it commits, the notification
-- is durable and will go out even if the process is replaced a millisecond
-- later. Email failure can never break request handling, which is the rule the
-- code brief §4 states and the reason this table exists.
--
-- NUMBERING. The code brief called this `013_notification_outbox.sql`. 013 and
-- 014 were consumed by company files and shared files while email was blocked
-- on AWS, so it lands at 017 (HANDOVER-CW011 §5.3).
--
-- NO digest_group. The brief's sketch carried one, for an admin digest that
-- would collapse a day's upload notifications into one message. Decision 8
-- (HANDOVER-C003 §5.5) settled on per-event notifications with no digest, and
-- digest mode is Phase 2. An unused column is an invitation to implement
-- against it, so it is left out; adding it back is one migration, and nothing
-- here forecloses it.
--
-- `send_after` IS kept, because it is not a digest feature. It is how the
-- worker backs off after a failed attempt without needing a separate schedule:
-- a retry pushes the row into the future rather than spinning on it.
--
-- STATUS. 'pending' -> 'sent' | 'failed' | 'suppressed'. 'suppressed' exists so
-- that a send withheld because the address has hard-bounced or complained is a
-- recorded outcome rather than an absence. HANDOVER-CW011 §3.6 requires that
-- suppressed sends are recorded, not silently dropped, and the acceptance test
-- in §4 requires every send attempt to be auditable: template, recipient,
-- timestamps and outcome all live on the row.
--
-- WHAT THIS TABLE IS NOT. It is not the audit log. `audit_log` remains the
-- 8-year DFSA-aligned append-only record and is untouched here; this is
-- operational state for a worker, and it may be pruned one day. Nothing in the
-- application deletes from it today.
--
-- The payload is JSONB rather than rendered text on purpose: a template fix
-- re-renders correctly for a row queued before the fix, and the recipient's
-- name and a filename are not worth storing twice.
--
-- Forward-only and idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS notification_outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The template id, e.g. 'company-invite'. Not a foreign key: templates live
  -- in code (`services/email-templates/`), and a row queued against a template
  -- that has since been renamed must fail loudly at render rather than be
  -- silently unsendable.
  template     TEXT NOT NULL CHECK (length(trim(template)) > 0),
  recipient    TEXT NOT NULL CHECK (length(trim(recipient)) > 0),
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,

  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),

  -- Not eligible for sending until this moment. Set forward by the worker on a
  -- failed attempt to back off; never used to batch or digest.
  send_after   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,

  -- The SES message id, kept so a message can be traced from this row into the
  -- SES event stream and back. NULL until a send succeeds.
  message_id   TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at      TIMESTAMPTZ,

  -- A terminal status must say when it became terminal, and a row that is still
  -- pending must not claim to have been sent.
  CONSTRAINT outcome_is_timestamped
    CHECK ((status IN ('sent', 'suppressed')) = (sent_at IS NOT NULL))
);

-- The worker's only read: the oldest due, pending rows. Partial so the index
-- stays small as sent rows accumulate.
CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
  ON notification_outbox (send_after, created_at)
  WHERE status = 'pending';

-- For the operational question "what did we send this person, and when".
CREATE INDEX IF NOT EXISTS idx_notification_outbox_recipient
  ON notification_outbox (lower(recipient), created_at DESC);

COMMENT ON TABLE notification_outbox IS
  'Transactional outbox for platform email. Routes insert rows inside the transaction of the event being notified about; only the worker in services/notifications.js sends. A rolled-back transaction sends nothing, and a committed one is durable.';

COMMENT ON COLUMN notification_outbox.status IS
  'pending -> sent | failed | suppressed. ''suppressed'' means the address is on the suppression list (migration 018) and the send was deliberately withheld: recorded, never silently dropped.';

COMMENT ON COLUMN notification_outbox.send_after IS
  'Not eligible for sending before this moment. Used only for retry backoff, not for batching or digests: digest mode is Phase 2 by decision 8.';

COMMENT ON COLUMN notification_outbox.payload IS
  'Template variables, not rendered text. Rendering happens at send time so a template correction applies to rows queued before it.';
