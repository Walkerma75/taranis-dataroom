-- ============================================================================
-- 004: Append-only audit log
-- ============================================================================

CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id),       -- NULL for system events
  action      TEXT NOT NULL,                    -- e.g. 'login', 'document.view', 'grant.create'
  resource    TEXT,                             -- e.g. 'document', 'user', 'fund'
  resource_id UUID,
  detail      JSONB,                           -- flexible payload
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_user ON audit_log (user_id);
CREATE INDEX idx_audit_log_action ON audit_log (action);
CREATE INDEX idx_audit_log_resource ON audit_log (resource, resource_id);
CREATE INDEX idx_audit_log_created ON audit_log (created_at);

-- Prevent updates and deletes at the database level
-- The API db user should be granted INSERT-only on this table
-- For local dev, we enforce it with a trigger:
CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log is append-only. UPDATE and DELETE are prohibited.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

CREATE TRIGGER audit_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
