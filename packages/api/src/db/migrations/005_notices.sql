-- ============================================================================
-- 005: Broadcast notices (DFSA investor communications)
-- ============================================================================

CREATE TYPE notice_type AS ENUM ('liquidity', 'valuation', 'compliance', 'general');
CREATE TYPE notice_status AS ENUM ('draft', 'sent');

CREATE TABLE notices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id     UUID REFERENCES funds(id),       -- NULL = all funds
  type        notice_type NOT NULL DEFAULT 'general',
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      notice_status NOT NULL DEFAULT 'draft',
  sent_by     UUID REFERENCES users(id),
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE notice_recipients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id   UUID NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id),
  read_at     TIMESTAMPTZ,
  email_sent  BOOLEAN NOT NULL DEFAULT FALSE,
  email_sent_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notice_recipients_notice ON notice_recipients (notice_id);
CREATE INDEX idx_notice_recipients_user ON notice_recipients (user_id);
