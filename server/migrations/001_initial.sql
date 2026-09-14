CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE files (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path text NOT NULL,
  content text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (project_id, path)
);
CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id),
  type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_project_order ON events (project_id, id DESC);
CREATE TABLE previews (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
