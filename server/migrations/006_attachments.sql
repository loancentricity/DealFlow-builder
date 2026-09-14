CREATE TABLE attachments (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 bytes bigint NOT NULL CHECK(bytes > 0 AND bytes <= 262144000),
 disk_name text NOT NULL UNIQUE,
 inventory jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_project ON attachments(project_id,created_at);
