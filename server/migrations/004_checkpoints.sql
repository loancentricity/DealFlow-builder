CREATE TABLE checkpoints (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  source_files jsonb NOT NULL CHECK (jsonb_typeof(source_files) = 'array'),
  source_versions jsonb NOT NULL CHECK (jsonb_typeof(source_versions) = 'object'),
  file_count integer NOT NULL CHECK (file_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkpoints_project_history ON checkpoints(project_id, created_at DESC);
