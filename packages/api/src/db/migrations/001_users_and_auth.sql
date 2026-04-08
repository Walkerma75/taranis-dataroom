-- ============================================================================
-- 001: Users, sessions, MFA, and invite tokens
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Five roles as per spec
CREATE TYPE user_role AS ENUM ('admin', 'investor', 'advisor', 'consultant', 'viewer');
CREATE TYPE user_status AS ENUM ('invited', 'active', 'disabled');

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT,                          -- NULL until invite accepted
  role          user_role NOT NULL DEFAULT 'viewer',
  status        user_status NOT NULL DEFAULT 'invited',
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_status ON users (status);

-- MFA secrets (TOTP)
CREATE TABLE user_mfa (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  totp_secret   TEXT,                          -- base32-encoded TOTP secret
  totp_verified BOOLEAN NOT NULL DEFAULT FALSE,
  recovery_codes TEXT[],                       -- hashed recovery codes
  enabled_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Refresh tokens (server-side, opaque)
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,            -- SHA-256 of the opaque token
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens (token_hash);

-- Invite tokens
CREATE TABLE invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  role        user_role NOT NULL DEFAULT 'viewer',
  token_hash  TEXT NOT NULL UNIQUE,
  invited_by  UUID NOT NULL REFERENCES users(id),
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invites_email ON invites (email);
CREATE INDEX idx_invites_hash ON invites (token_hash);
