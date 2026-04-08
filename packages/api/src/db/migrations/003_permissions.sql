-- ============================================================================
-- 003: Granular access control — user × fund × category grants
-- ============================================================================

CREATE TABLE grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fund_id         UUID NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  category_id     UUID NOT NULL REFERENCES document_categories(id),
  download_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at      TIMESTAMPTZ,                 -- NULL = no expiry
  granted_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  UNIQUE(user_id, fund_id, category_id)
);

CREATE INDEX idx_grants_user ON grants (user_id);
CREATE INDEX idx_grants_fund ON grants (fund_id);

-- Per-document overrides (grant or withhold beyond category level)
CREATE TABLE document_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  action          TEXT NOT NULL CHECK (action IN ('grant', 'deny')),
  download_allowed BOOLEAN,
  granted_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, document_id)
);

-- Permission templates for quick onboarding
CREATE TABLE permission_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  role        user_role NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE permission_template_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     UUID NOT NULL REFERENCES permission_templates(id) ON DELETE CASCADE,
  fund_id         UUID NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  category_id     UUID NOT NULL REFERENCES document_categories(id),
  download_allowed BOOLEAN NOT NULL DEFAULT TRUE
);
