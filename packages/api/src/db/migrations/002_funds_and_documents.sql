-- ============================================================================
-- 002: Funds, document categories, and documents
-- ============================================================================

CREATE TYPE fund_status AS ENUM ('active', 'closed', 'draft');

CREATE TABLE funds (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,            -- URL-friendly: biotech, datacentre, property
  description TEXT,
  status      fund_status NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default categories per spec + Pitch Deck
CREATE TABLE document_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO document_categories (name, sort_order) VALUES
  ('Overview', 10),
  ('PPM', 20),
  ('LPA', 30),
  ('Subscription Docs', 40),
  ('Financials', 50),
  ('Technical', 60),
  ('Legal', 70),
  ('Correspondence', 80),
  ('Pitch Deck', 90);

CREATE TYPE document_status AS ENUM ('active', 'archived', 'processing');

CREATE TABLE documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id         UUID NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  category_id     UUID NOT NULL REFERENCES document_categories(id),
  title           TEXT NOT NULL,
  description     TEXT,
  file_name       TEXT NOT NULL,               -- original upload filename
  file_path       TEXT NOT NULL,               -- storage path (local or S3 key)
  file_size       BIGINT NOT NULL,             -- bytes
  mime_type       TEXT NOT NULL,
  version         INT NOT NULL DEFAULT 1,
  status          document_status NOT NULL DEFAULT 'active',
  download_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by     UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_documents_fund ON documents (fund_id);
CREATE INDEX idx_documents_category ON documents (category_id);
CREATE INDEX idx_documents_status ON documents (status);
