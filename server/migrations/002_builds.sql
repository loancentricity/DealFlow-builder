CREATE TABLE builds (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id uuid NOT NULL REFERENCES tasks(id),
 status text NOT NULL CHECK(status IN ('queued','running','review','applied','failed','cancelled')),
 prompt text NOT NULL CHECK(length(prompt) BETWEEN 1 AND 6000),
 base_versions jsonb NOT NULL,
 source_files jsonb NOT NULL,
 candidate_files jsonb,
 snapshot_id text,
 summary text,
 error text,
 checks jsonb,
 review jsonb,
 lease_token text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 claimed_at timestamptz,
 completed_at timestamptz
);
CREATE UNIQUE INDEX builds_one_active_project ON builds(project_id) WHERE status IN ('queued','running','review');
CREATE INDEX builds_project_history ON builds(project_id,created_at DESC);
CREATE TABLE build_worker_state (
 id integer PRIMARY KEY CHECK(id=1),
 name text NOT NULL,
 ready boolean NOT NULL DEFAULT false,
 reason text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
