-- ============================================================================
-- 018: email_suppressions — addresses the platform must stop writing to
--
-- The SES production-access request committed Taranis to handling bounces and
-- complaints with address suppression. That is a promise made to AWS, not
-- wording (HANDOVER-C002 §5.3), and HANDOVER-CW011 §3.6 puts it in Phase 1b.
--
-- WHY IT MATTERS BEYOND KEEPING THE PROMISE. Sending reputation is an account
-- property, not an application one. One stale company contact address bouncing
-- repeatedly degrades deliverability for everything the account ever sends,
-- including the fund side and any future use. The cost of a suppression list is
-- one lookup per send; the cost of not having one is paid by every other
-- message.
--
-- TWO LAYERS, DELIBERATELY. SES keeps its own account-level suppression list
-- and applies it whether or not this table exists, so the promise to AWS holds
-- from the moment the configuration set is created. This table is the layer we
-- can see: it lets the portal tell an administrator WHY a company contact never
-- replied, which SES's list cannot, and it lets a send be recorded as
-- 'suppressed' in the outbox rather than being attempted and bounced again.
--
-- HARD BOUNCES AND COMPLAINTS ONLY. A soft bounce is a full mailbox or a
-- greylist and is exactly the thing a retry is for; suppressing on one would
-- lock a company out of its own diligence over a transient condition. The
-- reason is stored so that a wrongly suppressed address can be found and
-- released deliberately, by a person, with the original event still on record.
--
-- RELEASING. Rows are not deleted. `released_at` and `released_by` lift the
-- suppression and leave the history, for the same reason withdrawal is soft in
-- 014: a counterparty asking why they stopped receiving email deserves an
-- answer that survives the fix.
--
-- Addresses are stored lower-cased. The local part of an address is
-- case-sensitive in the RFC and case-insensitive at every mail provider anyone
-- actually uses; matching case-sensitively here would mean suppressing
-- Contact@example.com and then cheerfully sending to contact@example.com.
--
-- Forward-only and idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_suppressions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Lower-cased at write time by `services/notifications.js`; the constraint
  -- makes that a rule of the schema rather than a habit of one call site.
  email        TEXT NOT NULL CHECK (email = lower(email) AND length(trim(email)) > 0),

  reason       TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint', 'manual')),

  -- The SES event that caused it, verbatim, so a disputed suppression can be
  -- answered with the provider's own words rather than our summary of them.
  detail       JSONB,

  suppressed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Set to lift the suppression. The row stays.
  released_at  TIMESTAMPTZ,
  released_by  UUID REFERENCES users(id),
  released_reason TEXT,

  CONSTRAINT release_is_attributable
    CHECK ((released_at IS NULL) = (released_by IS NULL))
);

-- One live suppression per address. A second bounce for an address already
-- suppressed updates the existing row rather than stacking another, which keeps
-- "is this address suppressed" a single-row question.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_suppressions_live
  ON email_suppressions (email)
  WHERE released_at IS NULL;

COMMENT ON TABLE email_suppressions IS
  'Addresses the platform must not send to, from SES bounce and complaint events. Hard bounces and complaints only: a soft bounce is what retries are for. Rows are released, never deleted.';

COMMENT ON COLUMN email_suppressions.detail IS
  'The SES event payload verbatim. Kept so a disputed suppression can be answered with the provider''s own record.';
