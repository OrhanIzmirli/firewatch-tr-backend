-- Source audit of 2026-11-08: keep only headline, source and link.
-- Copied article text is removed from every row. Rows from removed sources
-- stay because incident_news_claims points at them, but the API no longer
-- returns them (config/newsSources.ts).
-- Take a Neon backup branch before running: this text cannot be restored.
UPDATE news
   SET summary = '',
       body = '',
       highlights = '{}',
       paragraphs = '{}',
       image_url = NULL,
       thumbnail_url = NULL
 WHERE COALESCE(summary, '') <> ''
    OR COALESCE(body, '') <> ''
    OR COALESCE(array_length(highlights, 1), 0) > 0
    OR COALESCE(array_length(paragraphs, 1), 0) > 0
    OR image_url IS NOT NULL
    OR thumbnail_url IS NOT NULL;
