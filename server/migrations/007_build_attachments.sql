ALTER TABLE builds ADD COLUMN attachment_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE builds ADD COLUMN attachment_context jsonb NOT NULL DEFAULT '[]'::jsonb;
