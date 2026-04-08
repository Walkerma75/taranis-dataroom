-- ============================================================================
-- 007: Per-user capabilities + merge consultant role into advisor
-- ============================================================================

-- Add capabilities JSONB column with empty default
ALTER TABLE users ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{}';

-- Set default capabilities based on current role
UPDATE users SET capabilities = jsonb_build_object(
  'canManageUsers', true,
  'canManageFunds', true,
  'canUploadDocuments', true,
  'canViewAudit', true,
  'canDownloadDocuments', true,
  'canViewDocuments', true
) WHERE role = 'admin';

UPDATE users SET capabilities = jsonb_build_object(
  'canManageUsers', false,
  'canManageFunds', false,
  'canUploadDocuments', false,
  'canViewAudit', false,
  'canDownloadDocuments', true,
  'canViewDocuments', true
) WHERE role = 'investor';

UPDATE users SET capabilities = jsonb_build_object(
  'canManageUsers', false,
  'canManageFunds', false,
  'canUploadDocuments', true,
  'canViewAudit', false,
  'canDownloadDocuments', true,
  'canViewDocuments', true
) WHERE role = 'advisor' OR role = 'consultant';

UPDATE users SET capabilities = jsonb_build_object(
  'canManageUsers', false,
  'canManageFunds', false,
  'canUploadDocuments', false,
  'canViewAudit', false,
  'canDownloadDocuments', false,
  'canViewDocuments', true
) WHERE role = 'viewer';

-- Merge consultant into advisor
UPDATE users SET role = 'advisor' WHERE role = 'consultant';

-- Note: We leave the 'consultant' value in the user_role enum as PostgreSQL
-- doesn't easily support removing enum values. It simply won't be used.
