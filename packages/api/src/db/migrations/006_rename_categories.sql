-- ============================================================================
-- 006: Rename categories — remove acronyms, merge into Legal Documents
-- ============================================================================

-- Rename PPM to full name
UPDATE document_categories SET name = 'Private Placement Memorandum' WHERE name = 'PPM';

-- Rename LPA to Legal Documents (this becomes the merged category)
UPDATE document_categories SET name = 'Legal Documents', sort_order = 30 WHERE name = 'LPA';

-- Move any documents that were in Subscription Docs into Legal Documents
UPDATE documents SET category_id = (
  SELECT id FROM document_categories WHERE name = 'Legal Documents'
) WHERE category_id = (
  SELECT id FROM document_categories WHERE name = 'Subscription Docs'
);

-- Move any grants that were on Subscription Docs to Legal Documents
UPDATE grants SET category_id = (
  SELECT id FROM document_categories WHERE name = 'Legal Documents'
) WHERE category_id = (
  SELECT id FROM document_categories WHERE name = 'Subscription Docs'
);

-- Move any permission template entries
UPDATE permission_template_entries SET category_id = (
  SELECT id FROM document_categories WHERE name = 'Legal Documents'
) WHERE category_id = (
  SELECT id FROM document_categories WHERE name = 'Subscription Docs'
);

-- Now remove Subscription Docs (no longer needed)
DELETE FROM document_categories WHERE name = 'Subscription Docs';

-- Also remove the old Legal category (now covered by Legal Documents)
-- First move anything referencing it
UPDATE documents SET category_id = (
  SELECT id FROM document_categories WHERE name = 'Legal Documents'
) WHERE category_id = (
  SELECT id FROM document_categories WHERE name = 'Legal'
);

UPDATE grants SET category_id = (
  SELECT id FROM document_categories WHERE name = 'Legal Documents'
) WHERE category_id = (
  SELECT id FROM document_categories WHERE name = 'Legal'
);

UPDATE permission_template_entries SET category_id = (
  SELECT id FROM document_categories WHERE name = 'Legal Documents'
) WHERE category_id = (
  SELECT id FROM document_categories WHERE name = 'Legal'
);

DELETE FROM document_categories WHERE name = 'Legal';

-- Rename Pitch Deck to full name
UPDATE document_categories SET name = 'Pitch Deck / Presentation' WHERE name = 'Pitch Deck';

-- Reorder for clarity
UPDATE document_categories SET sort_order = 10 WHERE name = 'Overview';
UPDATE document_categories SET sort_order = 20 WHERE name = 'Private Placement Memorandum';
UPDATE document_categories SET sort_order = 30 WHERE name = 'Legal Documents';
UPDATE document_categories SET sort_order = 40 WHERE name = 'Financials';
UPDATE document_categories SET sort_order = 50 WHERE name = 'Technical';
UPDATE document_categories SET sort_order = 60 WHERE name = 'Correspondence';
UPDATE document_categories SET sort_order = 70 WHERE name = 'Pitch Deck / Presentation';
