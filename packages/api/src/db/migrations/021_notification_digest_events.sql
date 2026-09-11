-- ============================================================================
-- 021: notification_digest_events — the open half of a session digest
--
-- WHY. Every status change, company upload and added checklist item sent its
-- own email. On 10 September 2026 one review sitting on a single company sent
-- its administrator 76 messages in a few minutes, and a company's upload of 78
-- files had sent the admin address one message per file. Mark's rule is one
-- digest per working session, not one email per file (HANDOVER-CW025).
--
-- WHY A TABLE OF ITS OWN, NOT A COALESCING OUTBOX ROW. The brief sketched one
-- pending notification_outbox row per recipient, its `send_after` pushed back
-- by each new event. The outbox cannot tell an open row from one being sent:
-- the worker claims a row by incrementing `attempts` and nothing else, so a
-- row mid-send, and one backing off after a failure, both still read
-- 'pending'. New events would attach to a message already on its way. The 020
-- dedupe key cannot stand in either: its unique index covers SENT rows, so a
-- second digest under the same key would be dropped without a word
-- (HANDOVER-C025 §3.1).
--
-- So an event lands here, and only here, in the transaction of the thing it is
-- about. The timer in `services/notification-digests.js` closes a group once it
-- has been quiet for the quiet period or held for the maximum hold. In ONE
-- transaction it locks the group's open events, writes one ORDINARY outbox row
-- and stamps the events with that row's id. From then on the outbox's own send,
-- retry, suppression and failure rules apply, unchanged.
--
-- EVENTS CARRY IDS, NOT CONTENT. The message is built when the group closes,
-- from the rows as they stand then. A file flagged and then accepted in the
-- same sitting is described once, as accepted, and the progress figure is the
-- one at the end of the sitting rather than after the first change.
--
-- `flushed_at` set with `outbox_id` NULL means the group closed with nothing
-- left to say: every file had moved on, or the recipient had been deactivated
-- in the meantime. Recorded, not deleted, like everything else here.
--
-- WHAT THIS TABLE IS NOT. It is not the audit log. It is operational state for
-- a timer, and it may be pruned one day. Nothing in the application deletes
-- from it today.
--
-- Forward-only and idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS notification_digest_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- TEXT with a CHECK rather than an enum, so a new family is an ALTER of the
  -- constraint and not an `ADD VALUE`, which could not be used in the migration
  -- that added it (see 010 and 015).
  family      TEXT NOT NULL
                CHECK (family IN ('company-status', 'admin-uploads', 'company-new-items')),

  -- Lower-cased on the way in, so one person is one group however their
  -- address was typed. Matches `email_suppressions` (migration 018).
  recipient   TEXT NOT NULL CHECK (length(trim(recipient)) > 0),

  company_id  UUID NOT NULL REFERENCES companies(id),

  -- Ids only: { fileId } or { itemId }. The content is read when the group
  -- closes, never stored here.
  event       JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Both NULL while the group is open. Set together when it closes.
  flushed_at  TIMESTAMPTZ,
  outbox_id   UUID REFERENCES notification_outbox(id),

  -- A digest cannot claim an outbox row without saying when it closed.
  CONSTRAINT digest_event_flush_is_timestamped
    CHECK (outbox_id IS NULL OR flushed_at IS NOT NULL)
);

-- The timer's only read: open events, grouped. Partial, so it stays the size of
-- what is currently waiting rather than of everything ever sent.
CREATE INDEX IF NOT EXISTS idx_digest_events_open
  ON notification_digest_events (family, recipient, company_id, created_at)
  WHERE flushed_at IS NULL;

-- For "which events went into this message".
CREATE INDEX IF NOT EXISTS idx_digest_events_outbox
  ON notification_digest_events (outbox_id)
  WHERE outbox_id IS NOT NULL;

COMMENT ON TABLE notification_digest_events IS
  'Events waiting to be folded into a session digest (HANDOVER-CW025). Written in the transaction of the change they describe; closed by services/notification-digests.js into one ordinary notification_outbox row per group. Ids only: the message is built from current state when the group closes.';

COMMENT ON COLUMN notification_digest_events.outbox_id IS
  'The outbox row this event went out in. NULL with flushed_at set means the group closed with nothing to send.';
